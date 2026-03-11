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
            check_virtual_devices,
            list_audio_devices,
            api_login,
            api_start_session,
            api_end_session,
            install_vb_cable,
            install_obs,
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

/// 檢查虛擬音訊裝置是否已安裝
#[tauri::command]
fn check_virtual_devices() -> Result<serde_json::Value, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();

    let mut has_vb_cable = false;
    let mut has_virtual_cam = false;
    let mut output_devices: Vec<String> = Vec::new();
    let mut input_devices: Vec<String> = Vec::new();

    // Check output devices (for playing TTS audio to virtual mic)
    if let Ok(devices) = host.output_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                output_devices.push(name.clone());
                let lower = name.to_lowercase();
                if lower.contains("cable") || lower.contains("vb-") || lower.contains("virtual") {
                    has_vb_cable = true;
                }
            }
        }
    }

    // Check input devices
    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                input_devices.push(name.clone());
            }
        }
    }

    // Check for OBS Virtual Camera (check if OBS virtual cam DLL exists)
    let obs_paths = [
        r"C:\Program Files\obs-studio\bin\64bit\obs-virtualsource.dll",
        r"C:\Program Files (x86)\obs-studio\bin\64bit\obs-virtualsource.dll",
    ];
    for path in &obs_paths {
        if std::path::Path::new(path).exists() {
            has_virtual_cam = true;
            break;
        }
    }

    Ok(serde_json::json!({
        "has_vb_cable": has_vb_cable,
        "has_virtual_cam": has_virtual_cam,
        "output_devices": output_devices,
        "input_devices": input_devices,
    }))
}

/// 設定音訊輸出裝置（用於將 TTS 音訊路由到 VB-Cable）
#[tauri::command]
fn list_audio_devices() -> Result<serde_json::Value, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();

    let mut outputs = Vec::new();
    let mut inputs = Vec::new();

    if let Ok(devices) = host.output_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                outputs.push(name);
            }
        }
    }

    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                inputs.push(name);
            }
        }
    }

    Ok(serde_json::json!({
        "output_devices": outputs,
        "input_devices": inputs,
    }))
}

/// 登入 API（透過 Rust 後端，避免 CORS 問題）
#[tauri::command]
async fn api_login(api_url: String, email: String, password: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/api/v1/auth/login", api_url))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("連線失敗: {}", e))?;

    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("回應解析失敗: {}", e))?;

    if status >= 400 {
        let error_msg = body["error"].as_str().unwrap_or("登入失敗，請確認帳號密碼");
        return Err(error_msg.to_string());
    }

    Ok(body)
}

/// 建立 Session（透過 Rust 後端，避免 CORS 問題）
#[tauri::command]
async fn api_start_session(api_url: String, token: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/api/v1/session/start", api_url))
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("連線失敗: {}", e))?;

    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("回應解析失敗: {}", e))?;

    if status == 401 || status == 403 {
        return Err("TOKEN_EXPIRED".to_string());
    }
    if status >= 400 {
        let error_msg = body["error"].as_str().unwrap_or("建立 Session 失敗");
        return Err(error_msg.to_string());
    }

    Ok(body)
}

/// 結束 Session（透過 Rust 後端）
#[tauri::command]
async fn api_end_session(api_url: String, token: String, session_id: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let _ = client
        .delete(format!("{}/api/v1/session/{}/end", api_url, session_id))
        .header("Authorization", format!("Bearer {}", token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
    Ok(())
}

/// 一鍵安裝 VB-Cable（下載 zip → 解壓 → 執行安裝）
#[tauri::command]
async fn install_vb_cable(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    app.emit("install-progress", "正在下載 VB-Cable...").ok();

    let url = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip";
    let tmp_dir = std::env::temp_dir().join("ai-avatar-vbcable");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let zip_path = tmp_dir.join("VBCABLE_Driver_Pack43.zip");

    // Download
    let client = reqwest::Client::new();
    let resp = client.get(url)
        .timeout(std::time::Duration::from_secs(120))
        .send().await
        .map_err(|e| format!("下載失敗: {}", e))?;
    let bytes = resp.bytes().await
        .map_err(|e| format!("下載失敗: {}", e))?;
    std::fs::write(&zip_path, &bytes)
        .map_err(|e| format!("寫入失敗: {}", e))?;

    app.emit("install-progress", "正在解壓縮...").ok();

    // Extract zip
    let file = std::fs::File::open(&zip_path)
        .map_err(|e| format!("開啟 zip 失敗: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("解壓失敗: {}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("解壓失敗: {}", e))?;
        let out_path = tmp_dir.join(entry.mangled_name());
        if entry.is_dir() {
            let _ = std::fs::create_dir_all(&out_path);
        } else {
            if let Some(parent) = out_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("寫入失敗: {}", e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("寫入失敗: {}", e))?;
        }
    }

    app.emit("install-progress", "正在安裝 VB-Cable（需要管理員權限）...").ok();

    // Run installer (requires admin — use runas)
    let setup_exe = tmp_dir.join("VBCABLE_Setup_x64.exe");
    if !setup_exe.exists() {
        return Err("找不到 VBCABLE_Setup_x64.exe，請手動安裝".to_string());
    }

    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "/wait", setup_exe.to_str().unwrap_or("")])
        .status()
        .map_err(|e| format!("執行安裝程式失敗: {}", e))?;

    // Cleanup
    let _ = std::fs::remove_dir_all(&tmp_dir);

    if status.success() {
        Ok("VB-Cable 安裝完成".to_string())
    } else {
        Ok("安裝程式已執行，請確認是否安裝成功".to_string())
    }
}

/// 一鍵安裝 OBS Studio（下載安裝檔 → 執行）
#[tauri::command]
async fn install_obs(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    app.emit("install-progress", "正在下載 OBS Studio...").ok();

    // OBS installer URL (stable release)
    let url = "https://cdn-fastly.obsproject.com/downloads/OBS-Studio-31.0.1-Windows-Installer.exe";
    let tmp_dir = std::env::temp_dir().join("ai-avatar-obs");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let installer_path = tmp_dir.join("OBS-Studio-Installer.exe");

    // Download
    let client = reqwest::Client::new();
    let resp = client.get(url)
        .timeout(std::time::Duration::from_secs(300))
        .send().await
        .map_err(|e| format!("下載失敗: {}", e))?;
    let bytes = resp.bytes().await
        .map_err(|e| format!("下載失敗: {}", e))?;
    std::fs::write(&installer_path, &bytes)
        .map_err(|e| format!("寫入失敗: {}", e))?;

    app.emit("install-progress", "正在安裝 OBS Studio...").ok();

    // Run installer
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "/wait", installer_path.to_str().unwrap_or("")])
        .status()
        .map_err(|e| format!("執行安裝程式失敗: {}", e))?;

    // Cleanup
    let _ = std::fs::remove_dir_all(&tmp_dir);

    if status.success() {
        Ok("OBS Studio 安裝完成".to_string())
    } else {
        Ok("安裝程式已執行，請確認是否安裝成功".to_string())
    }
}

/// Calculate RMS of audio samples
fn calculate_rms(data: &[i16]) -> f64 {
    if data.is_empty() { return 0.0; }
    let sum: f64 = data.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum / data.len() as f64).sqrt()
}
