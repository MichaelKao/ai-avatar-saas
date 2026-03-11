// AI Avatar Desktop — MVP 桌面版
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod websocket_client;
mod audio_capture;
mod stt_client;
mod obs_virtual_cam;
mod obs_manager;

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
            auto_setup,
            play_audio_to_vbcable,
            open_avatar_window,
            close_avatar_window,
            emit_avatar_video,
            emit_avatar_face,
            start_obs_virtual_cam,
            stop_obs_virtual_cam,
            ensure_obs_ready,
            cleanup_obs,
            set_voice_and_face,
            auto_set_default_mic,
            restore_default_mic,
            auto_disable_real_cameras,
            restore_real_cameras,
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

/// STT 防抖緩衝區 — 累積 STT 文字，等待 3 秒無新結果後才送出
struct DebounceState {
    /// 累積的 STT 文字
    buffer: String,
    /// 正在等待的延遲傳送任務（3 秒計時器）
    pending_timer: Option<tokio::task::JoinHandle<()>>,
}

/// 全域防抖狀態（用 OnceLock + tokio::sync::Mutex 實作）
fn debounce_state() -> &'static tokio::sync::Mutex<DebounceState> {
    static STATE: std::sync::OnceLock<tokio::sync::Mutex<DebounceState>> = std::sync::OnceLock::new();
    STATE.get_or_init(|| {
        tokio::sync::Mutex::new(DebounceState {
            buffer: String::new(),
            pending_timer: None,
        })
    })
}

/// 清除防抖狀態（停止自動模式時呼叫）
async fn clear_debounce() {
    let mut state = debounce_state().lock().await;
    // 取消尚未觸發的計時器
    if let Some(handle) = state.pending_timer.take() {
        handle.abort();
    }
    state.buffer.clear();
}

/// 啟動自動模式 — 擷取系統音訊 → STT → 防抖後自動傳送
#[tauri::command]
async fn start_auto_mode(
    app: tauri::AppHandle,
    gpu_url: String,
    mode: i32,
) -> Result<String, String> {
    // 啟動前先清除上一次的防抖狀態
    clear_debounce().await;

    let mut rx = audio_capture::start_capture()?;

    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            // 跳過靜音（檢查 RMS 音量）
            let rms = calculate_rms(&chunk.data);
            if rms < 500.0 {
                continue;
            }

            // 送到 STT 辨識
            match stt_client::transcribe(&chunk.data, chunk.sample_rate, &gpu_url).await {
                Ok(text) => {
                    let text = text.trim().to_string();
                    if !text.is_empty() && text.len() > 1 {
                        // 即時發送 STT 結果到前端（讓 UI 即時顯示逐字稿）
                        use tauri::Emitter;
                        app_clone.emit("stt-result", &text).ok();

                        // 防抖機制：累積文字，重設 3 秒計時器
                        let mut state = debounce_state().lock().await;

                        // 將新的 STT 文字加入緩衝區（用空格分隔）
                        if !state.buffer.is_empty() {
                            state.buffer.push(' ');
                        }
                        state.buffer.push_str(&text);

                        // 取消現有的計時器（重新計時）
                        if let Some(handle) = state.pending_timer.take() {
                            handle.abort();
                        }

                        // 啟動新的 3 秒延遲傳送任務
                        let send_mode = mode;
                        let timer_handle = tokio::spawn(async move {
                            // 等待 3 秒，若期間沒有新的 STT 結果就送出
                            tokio::time::sleep(std::time::Duration::from_secs(3)).await;

                            // 取出緩衝區內容並清空
                            let accumulated_text = {
                                let mut s = debounce_state().lock().await;
                                let text = s.buffer.clone();
                                s.buffer.clear();
                                s.pending_timer = None;
                                text
                            };

                            // 送出累積的完整文字到 WebSocket
                            if !accumulated_text.is_empty() {
                                if let Err(e) = websocket_client::send_message(&accumulated_text, send_mode).await {
                                    eprintln!("自動傳送失敗: {}", e);
                                }
                            }
                        });

                        state.pending_timer = Some(timer_handle);
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

/// 停止自動模式（同時清除防抖緩衝區）
#[tauri::command]
async fn stop_auto_mode() -> Result<String, String> {
    audio_capture::stop_capture();
    clear_debounce().await;
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

/// 安裝內建的 VB-Cable（從 app 資源解壓 → 執行安裝）
#[tauri::command]
async fn install_vb_cable(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::{Emitter, Manager};
    app.emit("install-progress", "正在準備 VB-Cable 安裝...").ok();

    // Get bundled resource path
    let resource_path = app.path()
        .resource_dir()
        .map_err(|e| format!("找不到資源目錄: {}", e))?
        .join("resources")
        .join("VBCABLE_Driver_Pack43.zip");

    if !resource_path.exists() {
        return Err("內建 VB-Cable 安裝檔遺失".to_string());
    }

    let tmp_dir = std::env::temp_dir().join("ai-avatar-vbcable");
    let _ = std::fs::create_dir_all(&tmp_dir);

    // Extract zip from bundled resource
    app.emit("install-progress", "正在解壓縮 VB-Cable...").ok();
    let file = std::fs::File::open(&resource_path)
        .map_err(|e| format!("開啟資源失敗: {}", e))?;
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

    app.emit("install-progress", "正在安裝 VB-Cable 虛擬音訊裝置...").ok();

    // Run installer
    let setup_exe = tmp_dir.join("VBCABLE_Setup_x64.exe");
    if !setup_exe.exists() {
        return Err("找不到 VBCABLE_Setup_x64.exe".to_string());
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

/// 自動設定環境 — 偵測並安裝缺少的虛擬裝置
#[tauri::command]
async fn auto_setup(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Emitter;

    // Step 1: Check what's installed
    let has_vb = {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        let mut found = false;
        if let Ok(devices) = host.output_devices() {
            for device in devices {
                if let Ok(name) = device.name() {
                    let lower = name.to_lowercase();
                    if lower.contains("cable") || lower.contains("vb-") {
                        found = true;
                        break;
                    }
                }
            }
        }
        found
    };

    if has_vb {
        return Ok(serde_json::json!({
            "vb_cable": true,
            "message": "環境已就緒"
        }));
    }

    // Step 2: Auto-install VB-Cable from bundled resource
    app.emit("install-progress", "正在安裝虛擬音訊裝置...").ok();
    match install_vb_cable(app.clone()).await {
        Ok(_) => {
            app.emit("install-progress", "安裝完成！").ok();
            Ok(serde_json::json!({
                "vb_cable": true,
                "message": "VB-Cable 已自動安裝"
            }))
        }
        Err(e) => {
            Ok(serde_json::json!({
                "vb_cable": false,
                "message": format!("VB-Cable 安裝失敗: {}", e)
            }))
        }
    }
}

/// 下載 TTS 音訊並播放到 VB-Cable（讓視訊軟體的麥克風收到 AI 語音）
#[tauri::command]
async fn play_audio_to_vbcable(audio_url: String) -> Result<String, String> {
    // Step 1: Download WAV
    let client = reqwest::Client::new();
    let resp = client.get(&audio_url)
        .timeout(std::time::Duration::from_secs(30))
        .send().await
        .map_err(|e| format!("下載音訊失敗: {}", e))?;
    let wav_bytes = resp.bytes().await
        .map_err(|e| format!("讀取音訊失敗: {}", e))?;

    // Step 2+3+4+5: Decode + Play in blocking thread (cpal::Stream is !Send)
    let result = tokio::task::spawn_blocking(move || {
        play_wav_to_vbcable_sync(&wav_bytes)
    }).await.map_err(|e| format!("執行緒錯誤: {}", e))?;

    result
}

/// Synchronous WAV playback to VB-Cable device
fn play_wav_to_vbcable_sync(wav_bytes: &[u8]) -> Result<String, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    // Decode WAV
    let cursor = std::io::Cursor::new(wav_bytes);
    let mut reader = hound::WavReader::new(cursor)
        .map_err(|e| format!("解析 WAV 失敗: {}", e))?;
    let spec = reader.spec();
    let wav_samples: Vec<f32> = if spec.bits_per_sample == 16 {
        reader.samples::<i16>().filter_map(|s| s.ok())
            .map(|s| s as f32 / 32768.0).collect()
    } else {
        reader.samples::<i32>().filter_map(|s| s.ok())
            .map(|s| s as f32 / 2147483648.0).collect()
    };

    if wav_samples.is_empty() {
        return Err("音訊資料為空".to_string());
    }

    // Find VB-Cable output device
    let host = cpal::default_host();
    let vb_device = host.output_devices()
        .map_err(|e| format!("列舉裝置失敗: {}", e))?
        .find(|d| {
            d.name().map(|n| {
                let lower = n.to_lowercase();
                lower.contains("cable") && lower.contains("input")
            }).unwrap_or(false)
        })
        .ok_or_else(|| "找不到 VB-Cable Input 裝置，請先安裝 VB-Cable".to_string())?;

    let device_name = vb_device.name().unwrap_or_default();

    // 使用 VB-Cable 的預設輸出設定（而不是 WAV 檔案的取樣率）
    // VB-Cable 通常只支援 44100/48000 Hz，TTS 輸出的 22050 Hz 會導致串流建立失敗
    let device_config = vb_device.default_output_config()
        .map_err(|e| format!("取得 VB-Cable 預設設定失敗: {}", e))?;
    let device_sample_rate = device_config.sample_rate().0;
    let device_channels = device_config.channels() as usize;

    // 先混合成 mono（如果 WAV 是 stereo）
    let wav_channels = spec.channels as usize;
    let mono_samples: Vec<f32> = wav_samples.chunks(wav_channels)
        .map(|frame| frame.iter().sum::<f32>() / wav_channels as f32)
        .collect();

    // 重新取樣到 VB-Cable 的取樣率
    let resampled = if spec.sample_rate != device_sample_rate {
        simple_resample_f32(&mono_samples, spec.sample_rate, device_sample_rate)
    } else {
        mono_samples
    };

    // 如果 VB-Cable 需要多聲道，擴展 mono → multi-channel
    let final_samples: Vec<f32> = if device_channels > 1 {
        resampled.iter().flat_map(|&s| std::iter::repeat(s).take(device_channels)).collect()
    } else {
        resampled
    };

    let config = cpal::StreamConfig {
        channels: device_channels as u16,
        sample_rate: cpal::SampleRate(device_sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    // Play audio
    let samples = std::sync::Arc::new(final_samples);
    let pos = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let samples_clone = samples.clone();
    let pos_clone = pos.clone();
    let done_clone = done.clone();

    let stream = vb_device.build_output_stream(
        &config,
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            let total = samples_clone.len();
            for sample in data.iter_mut() {
                let idx = pos_clone.load(std::sync::atomic::Ordering::Relaxed);
                if idx >= total {
                    *sample = 0.0;
                    done_clone.store(true, std::sync::atomic::Ordering::Relaxed);
                } else {
                    *sample = samples_clone[idx];
                    pos_clone.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
        },
        |e| eprintln!("音訊串流錯誤: {}", e),
        None,
    ).map_err(|e| format!("建立音訊串流失敗: {}", e))?;

    // 播放前暫停音訊擷取（避免 WASAPI loopback 擷取到 AI 自己的語音 → 回饋迴圈）
    audio_capture::set_playback_active(true);

    stream.play().map_err(|e| format!("播放失敗: {}", e))?;

    // Wait for playback to finish
    let total_samples = samples.len();
    let duration_secs = total_samples as f64 / (device_sample_rate as f64 * device_channels as f64);
    let wait_ms = (duration_secs * 1000.0) as u64 + 500;
    std::thread::sleep(std::time::Duration::from_millis(wait_ms));

    drop(stream);

    // 播放結束，再多等 0.5 秒讓殘響消散，然後恢復擷取
    std::thread::sleep(std::time::Duration::from_millis(500));
    audio_capture::set_playback_active(false);

    Ok(format!("已播放到 {} ({}Hz {}ch)", device_name, device_sample_rate, device_channels))
}

/// 簡單線性重新取樣（f32 版本）
fn simple_resample_f32(data: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    let ratio = from_rate as f64 / to_rate as f64;
    let new_len = (data.len() as f64 / ratio) as usize;
    let mut result = Vec::with_capacity(new_len);
    for i in 0..new_len {
        let src_idx = i as f64 * ratio;
        let idx = src_idx as usize;
        let frac = (src_idx - idx as f64) as f32;
        if idx + 1 < data.len() {
            result.push(data[idx] * (1.0 - frac) + data[idx + 1] * frac);
        } else if idx < data.len() {
            result.push(data[idx]);
        }
    }
    result
}

/// 開啟 Avatar 獨立視窗（無邊框，供 OBS 擷取用）
#[tauri::command]
async fn open_avatar_window(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    // 已開啟就聚焦
    if let Some(window) = app.get_webview_window("avatar") {
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok("Avatar 視窗已開啟".to_string());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "avatar",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("AI Avatar Camera")
    .decorations(false)
    .always_on_top(false)
    .inner_size(320.0, 240.0)
    .position(0.0, 0.0)
    .skip_taskbar(true)
    .resizable(true)
    .build()
    .map_err(|e| format!("開啟視窗失敗: {}", e))?;

    // 移到螢幕左上角，盡量不遮擋使用者操作
    // 注意：不能 minimize，否則 OBS 無法擷取
    if let Some(window) = app.get_webview_window("avatar") {
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: 0, y: 0 })).ok();
    }

    Ok("Avatar 視窗已開啟".to_string())
}

/// 關閉 Avatar 視窗
#[tauri::command]
async fn close_avatar_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("avatar") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 發送影片 URL 到 Avatar 視窗
#[tauri::command]
async fn emit_avatar_video(app: tauri::AppHandle, video_url: String) -> Result<(), String> {
    use tauri::Emitter;
    app.emit_to("avatar", "avatar-video-update", &video_url)
        .map_err(|e| format!("發送失敗: {}", e))?;
    Ok(())
}

/// 發送臉部截圖到 Avatar 視窗（webcam 不可用時的備用畫面）
#[tauri::command]
async fn emit_avatar_face(app: tauri::AppHandle, face_base64: String) -> Result<(), String> {
    use tauri::Emitter;
    app.emit_to("avatar", "avatar-face-snapshot", &face_base64)
        .map_err(|e| format!("發送失敗: {}", e))?;
    Ok(())
}

/// 啟動 OBS 虛擬鏡頭（自動設定場景 + 視窗擷取 + 啟動）
#[tauri::command]
async fn start_obs_virtual_cam(password: Option<String>) -> Result<String, String> {
    obs_virtual_cam::setup_virtual_camera(password, "AI Avatar Camera").await
}

/// 停止 OBS 虛擬鏡頭
#[tauri::command]
async fn stop_obs_virtual_cam(password: Option<String>) -> Result<String, String> {
    obs_virtual_cam::stop_virtual_camera(password).await
}

/// 確保 OBS 就緒（自動偵測 → 下載 → 安裝 → 設定 → 啟動）
#[tauri::command]
async fn ensure_obs_ready(app: tauri::AppHandle) -> Result<String, String> {
    obs_manager::ensure_obs_ready(&app).await?;
    Ok("OBS 虛擬鏡頭環境就緒".to_string())
}

/// 清理 OBS（停止虛擬鏡頭 + 關閉由我們啟動的 OBS 程序）
#[tauri::command]
async fn cleanup_obs() -> Result<String, String> {
    obs_manager::cleanup_obs().await?;
    Ok("OBS 已清理".to_string())
}

/// 設定聲音性別和 webcam 截圖（前端呼叫）
#[tauri::command]
async fn set_voice_and_face(voice_gender: String, face_image_base64: String) -> Result<(), String> {
    websocket_client::set_session_config(&voice_gender, &face_image_base64).await;
    Ok(())
}

/// 自動將 Windows 預設麥克風切換為 CABLE Output（所有 APP 自動生效）
#[tauri::command]
async fn auto_set_default_mic() -> Result<String, String> {
    use std::os::windows::process::CommandExt;

    // 將 PowerShell 腳本寫到暫存目錄
    let script = include_str!("set_default_mic.ps1");
    let script_path = std::env::temp_dir().join("ai-avatar-set-mic.ps1");
    std::fs::write(&script_path, script)
        .map_err(|e| format!("寫入腳本失敗: {}", e))?;

    let output: std::process::Output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", script_path.to_str().unwrap_or(""),
                "-Action", "set",
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
    }).await
        .map_err(|e| format!("執行緒錯誤: {}", e))?
        .map_err(|e| format!("執行 PowerShell 失敗: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.contains("OK") {
        Ok("已將預設麥克風切換為 CABLE Output（所有 APP 自動生效）".to_string())
    } else if stdout.contains("NOTFOUND") {
        Err("找不到 VB-Cable 錄音裝置".to_string())
    } else {
        Err(format!("切換失敗: {}", stdout.trim()))
    }
}

/// 還原 Windows 預設麥克風
#[tauri::command]
async fn restore_default_mic() -> Result<String, String> {
    use std::os::windows::process::CommandExt;

    let script_path = std::env::temp_dir().join("ai-avatar-set-mic.ps1");
    if !script_path.exists() {
        return Ok("無需還原".to_string());
    }

    let output: std::process::Output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", script_path.to_str().unwrap_or(""),
                "-Action", "restore",
            ])
            .creation_flags(0x08000000)
            .output()
    }).await
        .map_err(|e| format!("執行緒錯誤: {}", e))?
        .map_err(|e| format!("還原失敗: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.contains("RESTORED") {
        Ok("已還原預設麥克風".to_string())
    } else {
        Ok("無需還原".to_string())
    }
}

/// 自動停用真實攝影機，讓所有 APP 只看到 OBS Virtual Camera
#[tauri::command]
async fn auto_disable_real_cameras() -> Result<String, String> {
    use std::os::windows::process::CommandExt;

    let script = include_str!("set_default_cam.ps1");
    let script_path = std::env::temp_dir().join("ai-avatar-set-cam.ps1");
    std::fs::write(&script_path, script)
        .map_err(|e| format!("寫入腳本失敗: {}", e))?;

    // 需要管理員權限（Disable-PnpDevice 需要）
    let ps_cmd = format!(
        "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}','-Action','set' -Verb RunAs -Wait -PassThru | Select-Object -ExpandProperty ExitCode",
        script_path.to_str().unwrap_or("")
    );

    let output: std::process::Output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps_cmd])
            .creation_flags(0x08000000)
            .output()
    }).await
        .map_err(|e| format!("執行緒錯誤: {}", e))?
        .map_err(|e| format!("執行 PowerShell 失敗: {}", e))?;

    // 檢查儲存檔是否已建立（表示有停用攝影機）
    let save_file = std::env::temp_dir().join("ai-avatar-disabled-cams.txt");
    if save_file.exists() {
        Ok("已停用真實攝影機，所有 APP 只會看到 OBS Virtual Camera".to_string())
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if stdout.contains("NO_REAL_CAM") {
            Ok("沒有偵測到真實攝影機，無需停用".to_string())
        } else {
            Ok("攝影機設定完成".to_string())
        }
    }
}

/// 還原被停用的真實攝影機
#[tauri::command]
async fn restore_real_cameras() -> Result<String, String> {
    use std::os::windows::process::CommandExt;

    let script_path = std::env::temp_dir().join("ai-avatar-set-cam.ps1");
    if !script_path.exists() {
        let script = include_str!("set_default_cam.ps1");
        std::fs::write(&script_path, script).ok();
    }

    let save_file = std::env::temp_dir().join("ai-avatar-disabled-cams.txt");
    if !save_file.exists() {
        return Ok("無需還原攝影機".to_string());
    }

    let ps_cmd = format!(
        "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}','-Action','restore' -Verb RunAs -Wait",
        script_path.to_str().unwrap_or("")
    );

    let _output: std::process::Output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps_cmd])
            .creation_flags(0x08000000)
            .output()
    }).await
        .map_err(|e| format!("執行緒錯誤: {}", e))?
        .map_err(|e| format!("還原攝影機失敗: {}", e))?;

    Ok("已還原真實攝影機".to_string())
}

/// Calculate RMS of audio samples
fn calculate_rms(data: &[i16]) -> f64 {
    if data.is_empty() { return 0.0; }
    let sum: f64 = data.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum / data.len() as f64).sqrt()
}
