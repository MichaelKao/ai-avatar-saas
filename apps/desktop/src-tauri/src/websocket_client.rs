//! WebSocket 客戶端 — 連接雲端 Gateway
//! 支援串流音訊 chunk 接收 + 打斷機制

use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::audio_player;

static CONNECTED: AtomicBool = AtomicBool::new(false);

type WsSender = Arc<Mutex<Option<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>
    >,
    Message
>>>>;

static WS_SENDER: std::sync::OnceLock<WsSender> = std::sync::OnceLock::new();

/// Session 設定（聲音性別 + webcam 截圖）
static SESSION_CONFIG: std::sync::OnceLock<Arc<Mutex<SessionConfig>>> = std::sync::OnceLock::new();

#[derive(Default)]
pub struct SessionConfig {
    pub voice_gender: String,
    pub face_image_base64: String,
    pub custom_prompt: String,
}

fn get_session_config() -> &'static Arc<Mutex<SessionConfig>> {
    SESSION_CONFIG.get_or_init(|| Arc::new(Mutex::new(SessionConfig::default())))
}

fn get_sender() -> &'static WsSender {
    WS_SENDER.get_or_init(|| Arc::new(Mutex::new(None)))
}

/// 建立 WebSocket 連線
pub async fn connect(app: tauri::AppHandle, url: &str, _mode: i32) -> Result<(), String> {
    let (ws_stream, _) = connect_async(url)
        .await
        .map_err(|e| format!("WebSocket 連線失敗: {}", e))?;

    let (write, mut read) = ws_stream.split();

    // 儲存 sender
    {
        let mut sender = get_sender().lock().await;
        *sender = Some(write);
    }
    CONNECTED.store(true, Ordering::SeqCst);

    // 在背景接收訊息
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    // 嘗試解析 JSON 看是否為 tts_audio_chunk（在 Rust 層直接處理）
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        let msg_type = json["type"].as_str().unwrap_or("");

                        match msg_type {
                            "thinking_animation" => {
                                // 新回答開始 → 清空舊音訊佇列（避免舊回答殘留）
                                if json["data"]["status"].as_str() == Some("start") {
                                    audio_player::cancel_playback();
                                    use tauri::Emitter;
                                    app_clone.emit("debug-log", "新回答開始，清空舊音訊佇列").ok();
                                }
                                use tauri::Emitter;
                                app_clone.emit("ws-message", text.as_str()).ok();
                            }
                            "tts_audio_chunk" | "tts_audio" => {
                                let chunk_idx = json["data"]["index"].as_i64().unwrap_or(-1);
                                // 串流 TTS chunk：支援 base64（記憶體內）或 URL（下載）
                                if let Some(b64) = json["data"]["audio_base64"].as_str() {
                                    // base64 模式：直接解碼，不需下載（省 ~250ms）
                                    let b64 = b64.to_string();
                                    let app_dbg = app_clone.clone();
                                    let idx = chunk_idx;
                                    tokio::spawn(async move {
                                        let start = std::time::Instant::now();
                                        match decode_and_enqueue(&b64) {
                                            Ok(_) => {
                                                use tauri::Emitter;
                                                app_dbg.emit("debug-log", &format!(
                                                    "TTS #{} base64 入隊 ({}ms, {}KB)",
                                                    idx, start.elapsed().as_millis(), b64.len() / 1024
                                                )).ok();
                                            }
                                            Err(e) => {
                                                use tauri::Emitter;
                                                app_dbg.emit("debug-log", &format!("TTS #{} base64 入隊失敗: {}", idx, e)).ok();
                                            }
                                        }
                                    });
                                } else if let Some(audio_url) = json["data"]["audio_url"].as_str() {
                                    let url = audio_url.to_string();
                                    let app_dbg = app_clone.clone();
                                    let idx = chunk_idx;
                                    tokio::spawn(async move {
                                        let start = std::time::Instant::now();
                                        match download_and_enqueue(&url).await {
                                            Ok(_) => {
                                                use tauri::Emitter;
                                                app_dbg.emit("debug-log", &format!(
                                                    "TTS #{} URL 下載+入隊 ({}ms)",
                                                    idx, start.elapsed().as_millis()
                                                )).ok();
                                            }
                                            Err(e) => {
                                                use tauri::Emitter;
                                                app_dbg.emit("debug-log", &format!("TTS #{} URL 入隊失敗: {}", idx, e)).ok();
                                            }
                                        }
                                    });
                                }
                                // 同時也發送給前端（讓 UI 顯示進度）
                                use tauri::Emitter;
                                app_clone.emit("ws-message", text.as_str()).ok();
                            }
                            "tts_stream_end" => {
                                // 串流結束信號（可選：前端更新 UI）
                                use tauri::Emitter;
                                app_clone.emit("ws-message", text.as_str()).ok();
                            }
                            _ => {
                                // 其他訊息照常轉發給前端
                                use tauri::Emitter;
                                app_clone.emit("ws-message", text.as_str()).ok();
                            }
                        }
                    } else {
                        use tauri::Emitter;
                        app_clone.emit("ws-message", text.as_str()).ok();
                    }
                }
                Ok(Message::Close(_)) => {
                    CONNECTED.store(false, Ordering::SeqCst);
                    use tauri::Emitter;
                    app_clone.emit("ws-disconnected", "closed").ok();
                    break;
                }
                Err(e) => {
                    eprintln!("WebSocket 錯誤: {}", e);
                    CONNECTED.store(false, Ordering::SeqCst);
                    use tauri::Emitter;
                    app_clone.emit("ws-disconnected", "error").ok();
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// 解碼 base64 音訊並加入串流播放佇列（零網路延遲）
fn decode_and_enqueue(b64: &str) -> Result<(), String> {
    use base64::Engine;
    let wav_bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解碼失敗: {}", e))?;
    audio_player::enqueue_audio_chunk(&wav_bytes)
}

/// 下載音訊並加入串流播放佇列
async fn download_and_enqueue(audio_url: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let resp = client.get(audio_url)
        .timeout(std::time::Duration::from_secs(15))
        .send().await
        .map_err(|e| format!("下載失敗: {}", e))?;
    let wav_bytes = resp.bytes().await
        .map_err(|e| format!("讀取失敗: {}", e))?;

    let bytes_clone = wav_bytes.to_vec();
    tokio::task::spawn_blocking(move || {
        audio_player::enqueue_audio_chunk(&bytes_clone)
    }).await.map_err(|e| format!("執行緒錯誤: {}", e))??;

    Ok(())
}

/// 設定 session 的聲音性別和 webcam 截圖
pub async fn set_session_config(voice_gender: &str, face_image_base64: &str) {
    let config = get_session_config();
    let mut guard = config.lock().await;
    guard.voice_gender = voice_gender.to_string();
    guard.face_image_base64 = face_image_base64.to_string();
}

/// 設定自訂 system prompt（面試模式等場景用）
pub async fn set_custom_prompt(prompt: &str) {
    let config = get_session_config();
    let mut guard = config.lock().await;
    guard.custom_prompt = prompt.to_string();
}

/// 發送文字訊息到 Gateway
pub async fn send_message(text: &str, mode: i32) -> Result<(), String> {
    let sender = get_sender();
    let mut guard = sender.lock().await;

    if let Some(ref mut ws) = *guard {
        // 從 session config 取得聲音性別和 webcam 截圖
        let config = get_session_config();
        let mut cfg = config.lock().await;

        let mut msg = serde_json::json!({
            "text": text,
            "mode": mode,
        });

        if !cfg.voice_gender.is_empty() {
            msg["voice_gender"] = serde_json::Value::String(cfg.voice_gender.clone());
        }
        // face_image_base64 只送一次（第一則訊息），之後清掉避免浪費頻寬
        if !cfg.face_image_base64.is_empty() {
            msg["face_image_base64"] = serde_json::Value::String(cfg.face_image_base64.clone());
            cfg.face_image_base64.clear();
        }
        // 自訂 prompt（面試模式等場景用）— 每則訊息都帶
        if !cfg.custom_prompt.is_empty() {
            msg["custom_prompt"] = serde_json::Value::String(cfg.custom_prompt.clone());
        }
        drop(cfg);

        ws.send(Message::Text(msg.to_string()))
            .await
            .map_err(|e| format!("發送失敗: {}", e))?;
        Ok(())
    } else {
        Err("未連線".to_string())
    }
}

/// 發送打斷訊息到 Gateway
pub async fn send_interrupt() -> Result<(), String> {
    let sender = get_sender();
    let mut guard = sender.lock().await;

    if let Some(ref mut ws) = *guard {
        let msg = serde_json::json!({
            "type": "interrupt",
        });
        ws.send(Message::Text(msg.to_string()))
            .await
            .map_err(|e| format!("發送打斷失敗: {}", e))?;
        Ok(())
    } else {
        Err("未連線".to_string())
    }
}

/// 斷開連線
pub async fn disconnect() {
    let sender = get_sender();
    let mut guard = sender.lock().await;
    if let Some(ref mut ws) = *guard {
        let _ = ws.close().await;
    }
    *guard = None;
    CONNECTED.store(false, Ordering::SeqCst);
}

/// 檢查是否已連線
pub fn is_connected() -> bool {
    CONNECTED.load(Ordering::SeqCst)
}
