//! WebSocket 客戶端 — 連接雲端 Gateway

use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};

static CONNECTED: AtomicBool = AtomicBool::new(false);

type WsSender = Arc<Mutex<Option<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>
    >,
    Message
>>>>;

static WS_SENDER: std::sync::OnceLock<WsSender> = std::sync::OnceLock::new();

fn get_sender() -> &'static WsSender {
    WS_SENDER.get_or_init(|| Arc::new(Mutex::new(None)))
}

/// 建立 WebSocket 連線
pub async fn connect(app: tauri::AppHandle, url: &str) -> Result<(), String> {
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
                    // 解析伺服器訊息並轉發給前端
                    use tauri::Emitter;
                    app_clone.emit("ws-message", &text).ok();
                }
                Ok(Message::Binary(data)) => {
                    // 影片幀資料
                    use tauri::Emitter;
                    let b64 = base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &data
                    );
                    app_clone.emit("ws-video-frame", &b64).ok();
                }
                Ok(Message::Close(_)) => {
                    CONNECTED.store(false, Ordering::SeqCst);
                    break;
                }
                Err(e) => {
                    eprintln!("WebSocket 錯誤: {}", e);
                    CONNECTED.store(false, Ordering::SeqCst);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// 發送文字訊息
pub async fn send_text(text: &str) -> Result<(), String> {
    let sender = get_sender();
    let mut guard = sender.lock().await;

    if let Some(ref mut ws) = *guard {
        let msg = serde_json::json!({
            "type": "transcribed_text",
            "payload": {
                "text": text,
                "language": "zh-TW",
                "timestamp": chrono::Utc::now().timestamp_millis()
            }
        });

        ws.send(Message::Text(msg.to_string()))
            .await
            .map_err(|e| format!("發送失敗: {}", e))?;
    }

    Ok(())
}

/// 斷開連線
pub async fn disconnect() {
    let sender = get_sender();
    let mut guard = sender.lock().await;
    *guard = None;
    CONNECTED.store(false, Ordering::SeqCst);
}

/// 檢查是否已連線
pub fn is_connected() -> bool {
    CONNECTED.load(Ordering::SeqCst)
}
