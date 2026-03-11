// AI Avatar Desktop — MVP 桌面版
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod websocket_client;
mod audio_capture;
mod stt_client;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            connect_session,
            disconnect_session,
            send_text,
            get_status,
            start_auto_mode,
            stop_auto_mode,
        ])
        .run(tauri::generate_context!())
        .expect("啟動失敗");
}

/// 連接 WebSocket 到 Gateway
#[tauri::command]
async fn connect_session(
    app: tauri::AppHandle,
    api_url: String,
    token: String,
    session_id: String,
    mode: i32,
) -> Result<String, String> {
    let ws_url = format!(
        "{}/ws/session/{}?token={}",
        api_url.replace("https://", "wss://").replace("http://", "ws://"),
        session_id,
        token
    );

    websocket_client::connect(app, &ws_url, mode)
        .await
        .map_err(|e| format!("連線失敗: {}", e))?;

    Ok("已連線".to_string())
}

/// 斷開 WebSocket
#[tauri::command]
async fn disconnect_session() -> Result<String, String> {
    audio_capture::stop_capture();
    websocket_client::disconnect().await;
    Ok("已斷線".to_string())
}

/// 傳送文字到 AI
#[tauri::command]
async fn send_text(text: String, mode: i32) -> Result<(), String> {
    websocket_client::send_message(&text, mode).await
}

/// 取得連線狀態
#[tauri::command]
fn get_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "connected": websocket_client::is_connected(),
        "capturing": audio_capture::is_capturing(),
    }))
}

/// 啟動自動模式 — 擷取系統音訊 → STT → 自動傳送
#[tauri::command]
async fn start_auto_mode(
    app: tauri::AppHandle,
    gpu_url: String,
    mode: i32,
) -> Result<String, String> {
    let mut rx = audio_capture::start_capture()?;

    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            // Skip silence (check RMS level)
            let rms = calculate_rms(&chunk.data);
            if rms < 500.0 {
                continue; // Too quiet, skip
            }

            // Send to STT
            match stt_client::transcribe(&chunk.data, chunk.sample_rate, &gpu_url).await {
                Ok(text) => {
                    let text = text.trim().to_string();
                    if !text.is_empty() && text.len() > 1 {
                        // Emit STT result to frontend
                        use tauri::Emitter;
                        app_clone.emit("stt-result", &text).ok();

                        // Auto-send to WebSocket
                        if let Err(e) = websocket_client::send_message(&text, mode).await {
                            eprintln!("自動傳送失敗: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("STT 失敗: {}", e);
                }
            }
        }
    });

    Ok("自動模式已啟動".to_string())
}

/// 停止自動模式
#[tauri::command]
fn stop_auto_mode() -> Result<String, String> {
    audio_capture::stop_capture();
    Ok("自動模式已停止".to_string())
}

/// Calculate RMS of audio samples
fn calculate_rms(data: &[i16]) -> f64 {
    if data.is_empty() { return 0.0; }
    let sum: f64 = data.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum / data.len() as f64).sqrt()
}
