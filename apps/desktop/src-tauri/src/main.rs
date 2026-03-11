// AI Avatar Desktop — 主程式入口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_capture;
mod stt;
mod websocket_client;
mod virtual_camera;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            start_session,
            stop_session,
            get_audio_devices,
            set_audio_device,
            get_session_status,
        ])
        .run(tauri::generate_context!())
        .expect("啟動失敗");
}

/// 開始會議 Session
#[tauri::command]
async fn start_session(
    app: tauri::AppHandle,
    api_url: String,
    token: String,
    session_id: String,
) -> Result<String, String> {
    // 1. 建立 WebSocket 連線
    let ws_url = format!(
        "{}/ws/session/{}?token={}",
        api_url.replace("https://", "wss://").replace("http://", "ws://"),
        session_id,
        token
    );

    // 2. 啟動音訊捕捉
    let audio_handle = audio_capture::start_capture()
        .map_err(|e| format!("音訊捕捉啟動失敗: {}", e))?;

    // 3. 啟動 STT（語音轉文字）
    let stt_handle = stt::start_recognition(app.clone())
        .map_err(|e| format!("STT 啟動失敗: {}", e))?;

    // 4. 建立 WebSocket 連線
    websocket_client::connect(app.clone(), &ws_url)
        .await
        .map_err(|e| format!("WebSocket 連線失敗: {}", e))?;

    Ok("Session 已開始".to_string())
}

/// 停止會議 Session
#[tauri::command]
async fn stop_session() -> Result<String, String> {
    audio_capture::stop_capture();
    stt::stop_recognition();
    websocket_client::disconnect().await;
    Ok("Session 已停止".to_string())
}

/// 取得可用音訊裝置
#[tauri::command]
fn get_audio_devices() -> Result<Vec<String>, String> {
    audio_capture::list_devices()
        .map_err(|e| format!("取得裝置失敗: {}", e))
}

/// 設定音訊輸入裝置
#[tauri::command]
fn set_audio_device(device_name: String) -> Result<(), String> {
    audio_capture::set_device(&device_name)
        .map_err(|e| format!("設定裝置失敗: {}", e))
}

/// 取得 Session 狀態
#[tauri::command]
fn get_session_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "connected": websocket_client::is_connected(),
        "stt_active": stt::is_active(),
        "audio_active": audio_capture::is_active(),
    }))
}
