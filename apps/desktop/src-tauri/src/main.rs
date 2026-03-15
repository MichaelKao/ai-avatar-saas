// AI Avatar Desktop — MVP 桌面版
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod websocket_client;
mod audio_capture;
mod stt_client;
mod local_stt;
mod obs_virtual_cam;
mod obs_manager;
mod vad;
mod audio_player;
mod frame_server;

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
            api_register,
            api_start_session,
            api_end_session,
            install_vb_cable,
            auto_setup,
            play_audio_to_vbcable,
            enqueue_audio_chunk,
            cancel_audio_playback,
            open_avatar_window,
            close_avatar_window,
            emit_avatar_frame,
            emit_avatar_video,
            emit_avatar_face,
            start_obs_virtual_cam,
            stop_obs_virtual_cam,
            ensure_obs_ready,
            cleanup_obs,
            set_voice_and_face,
            set_custom_prompt,
            auto_set_default_mic,
            restore_default_mic,
            auto_disable_real_cameras,
            restore_real_cameras,
            // 本機 STT
            init_local_stt,
            get_stt_model_status,
            // 懸浮提示視窗
            open_overlay_window,
            close_overlay_window,
            update_overlay_text,
            // 場景 API
            api_fetch_scenes,
            api_set_default_scene,
            // 健康檢查
            api_check_health,
        ])
        .setup(|_app| {
            // 啟動 MuseTalk 幀 HTTP 伺服器（給 OBS Browser Source 用）
            tauri::async_runtime::spawn(frame_server::start(19280));
            Ok(())
        })
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

/// 啟動自動模式 — VAD 偵測語音結束 → STT → 直接送 AI（無防抖）
/// stt_mode: "local"（本機 Whisper）或 "remote"（雲端 GPU Whisper）
#[tauri::command]
async fn start_auto_mode(
    app: tauri::AppHandle,
    gpu_url: String,
    mode: i32,
    stt_mode: Option<String>,
) -> Result<String, String> {
    let mut rx = audio_capture::start_capture()?;

    let app_clone = app.clone();
    let gpu_url_clone = gpu_url.clone();
    let use_local_stt = stt_mode.as_deref() == Some("local") && local_stt::is_ready();

    // 送出除錯訊息
    {
        use tauri::Emitter;
        if use_local_stt {
            app_clone.emit("debug-log", "使用本機 Whisper STT（無需上傳）").ok();
        } else {
            app_clone.emit("debug-log", &format!("使用雲端 STT: {}", gpu_url_clone)).ok();
        }
        app_clone.emit("debug-log", "VAD 語音偵測已啟動，等待語音...").ok();
    }

    // 追蹤語句計數
    let utterance_count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let utterance_count_clone = utterance_count.clone();

    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let count = utterance_count_clone.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;

            // 計算 RMS 確認有效語音
            let rms = calculate_rms(&chunk.data);
            let duration_ms = chunk.data.len() as u64 * 1000 / chunk.sample_rate as u64;

            {
                use tauri::Emitter;
                let skip_reason = if rms < 800.0 {
                    "(低音量，跳過)"
                } else if duration_ms < 800 {
                    "(太短，跳過)"
                } else {
                    "(送 STT)"
                };
                app_clone.emit("debug-log", &format!(
                    "VAD 語句 #{}: {}ms, RMS={:.0} {}",
                    count, duration_ms, rms, skip_reason
                )).ok();
            }

            // RMS 過低或語音太短的跳過（減少誤辨識）
            if rms < 800.0 || duration_ms < 800 {
                continue;
            }

            // STT 辨識（本機或雲端）
            let stt_start = std::time::Instant::now();
            {
                use tauri::Emitter;
                let stt_label = if use_local_stt { "本機 STT" } else { "雲端 STT" };
                app_clone.emit("debug-log", &format!("正在 {}... ({}ms, RMS={:.0})", stt_label, duration_ms, rms)).ok();
            }

            let stt_result = if use_local_stt {
                // 本機 Whisper（在 blocking 執行緒中跑，避免阻塞 async runtime）
                let data = chunk.data.clone();
                let sr = chunk.sample_rate;
                tokio::task::spawn_blocking(move || {
                    local_stt::transcribe(&data, sr)
                }).await.unwrap_or_else(|e| Err(format!("執行緒錯誤: {}", e)))
            } else {
                // 雲端 Whisper
                stt_client::transcribe(&chunk.data, chunk.sample_rate, &gpu_url_clone).await
            };

            let stt_elapsed = stt_start.elapsed().as_millis();

            match stt_result {
                Ok(text) => {
                    let text = text.trim().to_string();
                    if !text.is_empty() && text.len() > 1 {
                        use tauri::Emitter;
                        app_clone.emit("stt-result", &text).ok();
                        app_clone.emit("debug-log", &format!("STT 完成 ({}ms): {}", stt_elapsed, &text)).ok();

                        // VAD 模式：語句結束就直接送 AI，不需防抖
                        if let Err(e) = websocket_client::send_message(&text, mode).await {
                            app_clone.emit("debug-log", &format!("WebSocket 傳送失敗: {}", e)).ok();
                        }
                    } else {
                        use tauri::Emitter;
                        app_clone.emit("debug-log", &format!("STT 回傳空白 ({}ms)", stt_elapsed)).ok();
                    }
                }
                Err(e) => {
                    use tauri::Emitter;
                    app_clone.emit("debug-log", &format!("STT 失敗 ({}ms): {}", stt_elapsed, e)).ok();
                }
            }
        }

        // 音訊擷取結束
        use tauri::Emitter;
        app_clone.emit("debug-log", "音訊擷取已結束").ok();
    });

    let label = if use_local_stt { "本機 STT" } else { "雲端 STT" };
    Ok(format!("自動模式已啟動（VAD + {}）", label))
}

/// 停止自動模式
#[tauri::command]
async fn stop_auto_mode() -> Result<String, String> {
    audio_capture::stop_capture();
    audio_player::cancel_playback();
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

/// 註冊新帳號
#[tauri::command]
async fn api_register(api_url: String, email: String, password: String, name: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/api/v1/auth/register", api_url))
        .json(&serde_json::json!({ "email": email, "password": password, "name": name }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("連線失敗: {}", e))?;

    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("回應解析失敗: {}", e))?;

    if status >= 400 {
        let error_msg = body["error"].as_str().unwrap_or("註冊失敗");
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
/// 相容舊的整段下載播放模式
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

/// 將音訊 chunk 加入串流播放佇列
#[tauri::command]
async fn enqueue_audio_chunk(audio_url: String) -> Result<String, String> {
    // 下載音訊
    let client = reqwest::Client::new();
    let resp = client.get(&audio_url)
        .timeout(std::time::Duration::from_secs(15))
        .send().await
        .map_err(|e| format!("下載音訊 chunk 失敗: {}", e))?;
    let wav_bytes = resp.bytes().await
        .map_err(|e| format!("讀取音訊 chunk 失敗: {}", e))?;

    // 加入播放佇列
    tokio::task::spawn_blocking(move || {
        audio_player::enqueue_audio_chunk(&wav_bytes)
    }).await.map_err(|e| format!("執行緒錯誤: {}", e))??;

    Ok("已加入播放佇列".to_string())
}

/// 取消所有音訊播放（打斷機制）
#[tauri::command]
async fn cancel_audio_playback() -> Result<String, String> {
    audio_player::cancel_playback();
    Ok("已取消播放".to_string())
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

    // 找到 VB-Cable 輸出裝置（若無則退回預設輸出裝置）
    let host = cpal::default_host();
    let vb_device = host.output_devices()
        .ok()
        .and_then(|mut devs| {
            devs.find(|d| {
                d.name().map(|n| {
                    let lower = n.to_lowercase();
                    lower.contains("cable") && lower.contains("input")
                }).unwrap_or(false)
            })
        });
    let vb_device = match vb_device {
        Some(dev) => dev,
        None => host.default_output_device()
            .ok_or_else(|| "找不到任何音訊輸出裝置".to_string())?,
    };

    let device_name = vb_device.name().unwrap_or_default();

    // 使用 VB-Cable 的預設輸出設定（而不是 WAV 檔案的取樣率）
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

    // 播放結束，等 2 秒讓殘響消散 + 確保擷取 buffer 中的殘留音訊被丟棄
    std::thread::sleep(std::time::Duration::from_millis(2000));
    // 清空擷取 buffer（丟棄播放期間可能殘留的音訊）
    audio_capture::flush_buffer();
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

/// 發送 MuseTalk 動畫幀到 Avatar 視窗（base64 JPEG）
#[tauri::command]
async fn emit_avatar_frame(app: tauri::AppHandle, frame: String) -> Result<(), String> {
    use tauri::Emitter;
    app.emit_to("avatar", "avatar-frame-update", &frame)
        .map_err(|e| format!("發送失敗: {}", e))?;
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

/// 設定自訂 system prompt（面試模式等場景用）
#[tauri::command]
async fn set_custom_prompt(prompt: String) -> Result<(), String> {
    websocket_client::set_custom_prompt(&prompt).await;
    Ok(())
}

/// 發送臉部截圖到 Avatar 視窗（webcam 不可用時的備用畫面）
#[tauri::command]
async fn emit_avatar_face(app: tauri::AppHandle, face_base64: String) -> Result<(), String> {
    use tauri::Emitter;
    // 寫入 frame server（OBS Browser Source 初始畫面）
    frame_server::update_frame_base64(&face_base64).await;
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

// =========================================================================
// 本機 STT 指令
// =========================================================================

/// 初始化本機 Whisper STT（下載 CLI + 模型）
#[tauri::command]
async fn init_local_stt(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    // 設定模型儲存目錄
    let model_dir = app.path()
        .app_data_dir()
        .map_err(|e| format!("取得 app 目錄失敗: {}", e))?
        .join("whisper");
    local_stt::set_model_dir(model_dir);

    // 下載 CLI + 模型（如果尚未下載）
    if !local_stt::is_ready() {
        local_stt::download_all(app.clone()).await?;
    }

    Ok("本機 Whisper STT 已就緒".to_string())
}

/// 取得本機 STT 狀態
#[tauri::command]
fn get_stt_model_status() -> Result<serde_json::Value, String> {
    Ok(local_stt::status())
}

// =========================================================================
// 懸浮提示視窗（Mode 1 overlay）
// =========================================================================

/// 開啟半透明懸浮提示視窗
#[tauri::command]
async fn open_overlay_window(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    // 已開啟就聚焦
    if let Some(window) = app.get_webview_window("overlay") {
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok("提示視窗已開啟".to_string());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "overlay",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("AI 提示")
    .decorations(false)
    .always_on_top(true)
    .transparent(true)
    .inner_size(480.0, 200.0)
    .skip_taskbar(true)
    .resizable(true)
    .build()
    .map_err(|e| format!("開啟提示視窗失敗: {}", e))?;

    // 移到螢幕右下角
    if let Some(window) = app.get_webview_window("overlay") {
        if let Ok(monitor) = window.current_monitor() {
            if let Some(m) = monitor {
                let size = m.size();
                let x = (size.width as f64 - 500.0).max(0.0) as i32;
                let y = (size.height as f64 - 250.0).max(0.0) as i32;
                window.set_position(tauri::Position::Physical(
                    tauri::PhysicalPosition { x, y },
                )).ok();
            }
        }
    }

    Ok("提示視窗已開啟".to_string())
}

/// 關閉懸浮提示視窗
#[tauri::command]
async fn close_overlay_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("overlay") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 更新懸浮提示視窗的文字
#[tauri::command]
async fn update_overlay_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri::Emitter;
    app.emit_to("overlay", "overlay-text-update", &text)
        .map_err(|e| format!("發送失敗: {}", e))?;
    Ok(())
}

// =========================================================================
// 場景 API（透過 Rust 後端，避免 CORS 問題）
// =========================================================================

/// 取得用戶的場景列表
#[tauri::command]
async fn api_fetch_scenes(api_url: String, token: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/api/v1/scenes", api_url))
        .header("Authorization", format!("Bearer {}", token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("取得場景失敗: {}", e))?;

    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("解析失敗: {}", e))?;

    if status == 401 || status == 403 {
        return Err("TOKEN_EXPIRED".to_string());
    }
    if status >= 400 {
        let error_msg = body["error"].as_str().unwrap_or("取得場景失敗");
        return Err(error_msg.to_string());
    }

    Ok(body)
}

/// 檢查 Gateway 和 GPU 服務健康狀態
#[tauri::command]
async fn api_check_health(api_url: String, gpu_url: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client 建立失敗: {}", e))?;

    // 同時檢查 Gateway 和 GPU
    let (gw_result, gpu_result) = tokio::join!(
        client.get(format!("{}/health", api_url)).send(),
        client.get(format!("{}/health", gpu_url)).send()
    );

    let gateway_ok = match gw_result {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    };
    let gpu_ok = match gpu_result {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    };

    Ok(serde_json::json!({
        "gateway": gateway_ok,
        "gpu": gpu_ok,
    }))
}

/// 設定預設場景
#[tauri::command]
async fn api_set_default_scene(api_url: String, token: String, scene_id: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/api/v1/scenes/{}/set-default", api_url, scene_id))
        .header("Authorization", format!("Bearer {}", token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("設定場景失敗: {}", e))?;

    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("解析失敗: {}", e))?;

    Ok(body)
}
