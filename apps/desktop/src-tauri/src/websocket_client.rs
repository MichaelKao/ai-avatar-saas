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
                            "tts_audio_chunk" => {
                                // 串流 TTS chunk：直接在 Rust 層下載並入隊播放
                                if let Some(audio_url) = json["data"]["audio_url"].as_str() {
                                    let url = audio_url.to_string();
                                    tokio::spawn(async move {
                                        match download_and_enqueue(&url).await {
                                            Ok(_) => {}
                                            Err(e) => eprintln!("音訊 chunk 入隊失敗: {}", e),
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
