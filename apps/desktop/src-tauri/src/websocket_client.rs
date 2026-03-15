//! WebSocket 客戶端 — 連接雲端 Gateway
//! 支援串流音訊 chunk 接收 + 打斷機制 + 唇形幀直接轉發

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

/// TTS 工作項目（用 channel 保證順序）
enum TtsWork {
    Base64 { data: String, index: i64, text: String, engine: String },
    Url { url: String, index: i64, text: String, engine: String },
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

    // TTS 串流佇列 — channel 保證音訊按順序處理（不再 spawn 獨立 task）
    let (tts_tx, mut tts_rx) = tokio::sync::mpsc::channel::<TtsWork>(50);

    // TTS 消費者（循序處理，避免 base64 和 URL 交錯導致亂序）
    let app_tts = app.clone();
    tokio::spawn(async move {
        while let Some(work) = tts_rx.recv().await {
            match work {
                TtsWork::Base64 { data, index, text, engine } => {
                    let start = std::time::Instant::now();
                    match decode_and_enqueue(&data) {
                        Ok(_) => {
                            use tauri::Emitter;
                            app_tts.emit("debug-log", &format!(
                                "TTS #{} [{}]「{}」入隊 ({}ms, {}KB)",
                                index, engine, text, start.elapsed().as_millis(), data.len() / 1024
                            )).ok();
                        }
                        Err(e) => {
                            use tauri::Emitter;
                            app_tts.emit("debug-log", &format!(
                                "TTS #{} [{}]「{}」入隊失敗: {}", index, engine, text, e
                            )).ok();
                        }
                    }
                }
                TtsWork::Url { url, index, text, engine } => {
                    let start = std::time::Instant::now();
                    match download_and_enqueue(&url).await {
                        Ok(_) => {
                            use tauri::Emitter;
                            app_tts.emit("debug-log", &format!(
                                "TTS #{} [{}]「{}」URL 下載+入隊 ({}ms)",
                                index, engine, text, start.elapsed().as_millis()
                            )).ok();
                        }
                        Err(e) => {
                            use tauri::Emitter;
                            app_tts.emit("debug-log", &format!(
                                "TTS #{} [{}]「{}」URL 入隊失敗: {}", index, engine, text, e
                            )).ok();
                        }
                    }
                }
            }
        }
    });

    // 在背景接收訊息
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    // 嘗試解析 JSON（在 Rust 層直接處理音訊和唇形）
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
                                let chunk_text = json["data"]["text"].as_str().unwrap_or("").to_string();
                                let tts_engine = json["data"]["tts_engine"].as_str().unwrap_or("").to_string();

                                // 送入 TTS 佇列（循序處理，保證順序）
                                if let Some(b64) = json["data"]["audio_base64"].as_str() {
                                    let _ = tts_tx.send(TtsWork::Base64 {
                                        data: b64.to_string(),
                                        index: chunk_idx,
                                        text: chunk_text.clone(),
                                        engine: tts_engine.clone(),
                                    }).await;
                                } else if let Some(audio_url) = json["data"]["audio_url"].as_str() {
                                    let _ = tts_tx.send(TtsWork::Url {
                                        url: audio_url.to_string(),
                                        index: chunk_idx,
                                        text: chunk_text.clone(),
                                        engine: tts_engine.clone(),
                                    }).await;
                                }
                                // 同時也發送給前端（讓 UI 顯示進度）
                                use tauri::Emitter;
                                app_clone.emit("ws-message", text.as_str()).ok();
                            }
                            "avatar_frame" => {
                                // MuseTalk 唇形幀 — 直接發送到 AvatarWindow（不經 React 繞路）
                                if let Some(frame) = json["data"]["frame"].as_str() {
                                    use tauri::Emitter;
                                    app_clone.emit("avatar-frame-update", frame).ok();
                                }
                                // 也發送給主視窗（UI 顯示進度）
                                use tauri::Emitter;
                                app_clone.emit("ws-message", text.as_str()).ok();
                            }
                            "tts_stream_end" => {
                                // 串流結束信號
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
