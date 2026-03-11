//! OBS Studio 生命週期管理 — 自動偵測、下載、安裝、啟動、清理
//!
//! 使用者完全不需要知道 OBS 的存在。
//! 按下「啟動分身」→ 自動搞定一切 → 視訊軟體選「OBS Virtual Camera」即可。

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::Emitter;

/// 是否由我們啟動的 OBS（清理時才關閉）
static OBS_LAUNCHED_BY_US: AtomicBool = AtomicBool::new(false);
/// OBS 程序 PID
static OBS_PID: AtomicU32 = AtomicU32::new(0);

/// OBS 偵測結果
pub struct ObsDetection {
    pub installed: bool,
    pub exe_path: Option<PathBuf>,
    pub running: bool,
}

// -------------------------------------------------------------------------
// 偵測
// -------------------------------------------------------------------------

/// 偵測 OBS 安裝與運行狀態
pub fn detect_obs() -> ObsDetection {
    let paths = [
        PathBuf::from(r"C:\Program Files\obs-studio\bin\64bit\obs64.exe"),
        PathBuf::from(r"C:\Program Files (x86)\obs-studio\bin\64bit\obs64.exe"),
    ];

    let exe_path = paths.iter().find(|p| p.exists()).cloned();
    let installed = exe_path.is_some();

    let running = std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq obs64.exe", "/NH"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("obs64.exe"))
        .unwrap_or(false);

    ObsDetection {
        installed,
        exe_path,
        running,
    }
}

// -------------------------------------------------------------------------
// 下載
// -------------------------------------------------------------------------

/// 從 GitHub Releases 下載 OBS 安裝檔
pub async fn download_obs(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.emit("obs-install-progress", "正在查詢最新 OBS Studio 版本...")
        .ok();

    let client = reqwest::Client::builder()
        .user_agent("ai-avatar-desktop/0.1")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客戶端錯誤: {}", e))?;

    // 查詢 GitHub 最新 Release
    let release: serde_json::Value = client
        .get("https://api.github.com/repos/obsproject/obs-studio/releases/latest")
        .send()
        .await
        .map_err(|e| format!("查詢 OBS 版本失敗: {}", e))?
        .json()
        .await
        .map_err(|e| format!("解析回應失敗: {}", e))?;

    let version = release["tag_name"].as_str().unwrap_or("unknown");

    // 找 Windows 安裝檔
    let assets = release["assets"]
        .as_array()
        .ok_or("找不到 OBS 下載檔案")?;

    let asset = assets
        .iter()
        .find(|a| {
            let name = a["name"].as_str().unwrap_or("");
            name.ends_with(".exe")
                && (name.contains("Windows") || name.contains("windows"))
                && (name.contains("Installer") || name.contains("installer"))
        })
        .or_else(|| {
            // 備用：任何含 x64 的 exe
            assets.iter().find(|a| {
                let name = a["name"].as_str().unwrap_or("");
                name.ends_with(".exe") && name.contains("x64")
            })
        })
        .ok_or("找不到 Windows 版 OBS 安裝檔")?;

    let download_url = asset["browser_download_url"]
        .as_str()
        .ok_or("無法取得下載連結")?;
    let file_name = asset["name"].as_str().unwrap_or("OBS-Installer.exe");
    let total_size = asset["size"].as_u64().unwrap_or(0);
    let size_mb = total_size / 1_000_000;

    app.emit(
        "obs-install-progress",
        format!("正在下載 OBS Studio {} ({} MB)...", version, size_mb),
    )
    .ok();

    // 下載到暫存目錄
    let tmp_dir = std::env::temp_dir().join("ai-avatar-obs");
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("建立暫存目錄失敗: {}", e))?;
    let file_path = tmp_dir.join(file_name);

    // 如果已經下載過同檔名，直接使用
    if file_path.exists() {
        if let Ok(meta) = std::fs::metadata(&file_path) {
            if total_size > 0 && meta.len() == total_size {
                app.emit("obs-install-progress", "使用已下載的安裝檔").ok();
                return Ok(file_path);
            }
        }
    }

    let mut resp = client
        .get(download_url)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("下載失敗: {}", e))?;

    let mut file =
        std::fs::File::create(&file_path).map_err(|e| format!("建立檔案失敗: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut last_reported: u64 = 0;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("下載中斷: {}", e))?
    {
        use std::io::Write;
        file.write_all(&chunk)
            .map_err(|e| format!("寫入失敗: {}", e))?;
        downloaded += chunk.len() as u64;

        // 每 10% 回報一次
        if total_size > 0 {
            let percent = (downloaded * 100) / total_size;
            if percent >= last_reported + 10 {
                last_reported = percent;
                app.emit(
                    "obs-install-progress",
                    format!("正在下載 OBS Studio... {}%", percent),
                )
                .ok();
            }
        }
    }

    app.emit("obs-install-progress", "OBS Studio 下載完成").ok();
    Ok(file_path)
}

// -------------------------------------------------------------------------
// 安裝
// -------------------------------------------------------------------------

/// 靜默安裝 OBS（需要管理員權限，會觸發 UAC 彈窗）
pub async fn install_obs_silent(
    installer_path: &Path,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    app.emit(
        "obs-install-progress",
        "正在安裝 OBS Studio（需要管理員權限，請在彈出的對話框中按「是」）...",
    )
    .ok();

    let installer = installer_path
        .to_str()
        .ok_or("安裝路徑包含無效字元")?
        .to_string();

    // 用 PowerShell 以管理員身分靜默安裝
    let status: std::process::ExitStatus = tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args([
                "-Command",
                &format!(
                    "Start-Process '{}' -ArgumentList '/S' -Verb RunAs -Wait",
                    installer
                ),
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status()
    })
    .await
    .map_err(|e| format!("執行緒錯誤: {}", e))?
    .map_err(|e| format!("執行安裝程式失敗: {}", e))?;

    if !status.success() {
        return Err("OBS 安裝被取消或失敗".to_string());
    }

    // 驗證安裝成功
    let obs_exe = PathBuf::from(r"C:\Program Files\obs-studio\bin\64bit\obs64.exe");
    if !obs_exe.exists() {
        return Err("OBS 安裝完成但找不到執行檔，請重試".to_string());
    }

    app.emit("obs-install-progress", "OBS Studio 安裝完成").ok();
    Ok(())
}

// -------------------------------------------------------------------------
// 設定
// -------------------------------------------------------------------------

/// 清除 OBS 舊設定（避免 "Unable to migrate global configuration" 遷移衝突彈窗）
/// OBS 發現 ProgramData 和 AppData 都有 global.ini 時就會彈出此錯誤
/// 解法：直接刪除 ProgramData 下的整個 obs-studio 目錄
fn cleanup_programdata_obs() {
    let programdata_obs = PathBuf::from(r"C:\ProgramData\obs-studio");
    if programdata_obs.exists() {
        // 整個目錄刪掉（不只是 global.ini）
        std::fs::remove_dir_all(&programdata_obs).ok();
    }
}

/// 設定 OBS：啟用 WebSocket、停用認證、啟用系統匣、抑制首次精靈
pub fn configure_obs() -> Result<(), String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "無法取得 APPDATA 路徑")?;
    let obs_dir = PathBuf::from(&appdata).join("obs-studio");
    std::fs::create_dir_all(&obs_dir).ok();

    // 清除 ProgramData 舊設定（避免 OBS 遷移衝突彈窗）
    cleanup_programdata_obs();

    // === 修補 global.ini ===
    let global_ini = obs_dir.join("global.ini");
    let content = std::fs::read_to_string(&global_ini).unwrap_or_default();
    let patched = patch_ini(
        &content,
        &[
            (
                "OBSWebSocket",
                &[
                    ("FirstLoad", "false"),
                    ("ServerEnabled", "true"),
                    ("ServerPort", "4455"),
                    ("AlertsEnabled", "false"),
                    ("AuthRequired", "false"),
                    ("ServerPassword", ""),
                ],
            ),
            (
                "General",
                &[
                    ("SysTrayEnabled", "true"),
                    ("FirstRun", "false"),
                    ("EnableAutoUpdates", "false"),
                ],
            ),
        ],
    );
    std::fs::write(&global_ini, patched).map_err(|e| format!("寫入 global.ini 失敗: {}", e))?;

    // === 建立基本 Profile（抑制首次設定精靈）===
    let profile_dir = obs_dir
        .join("basic")
        .join("profiles")
        .join("Untitled");
    std::fs::create_dir_all(&profile_dir).ok();

    let basic_ini = profile_dir.join("basic.ini");
    if !basic_ini.exists() {
        std::fs::write(&basic_ini, "[General]\nName=Untitled\n").ok();
    }

    // === 建立基本場景集合 ===
    let scenes_dir = obs_dir.join("basic").join("scenes");
    std::fs::create_dir_all(&scenes_dir).ok();

    let scene_file = scenes_dir.join("Untitled.json");
    if !scene_file.exists() {
        let scene_json = serde_json::json!({
            "current_scene": "AI Avatar",
            "scene_order": [{"name": "AI Avatar"}],
            "sources": []
        });
        std::fs::write(&scene_file, scene_json.to_string()).ok();
    }

    Ok(())
}

/// INI 檔案修補：保留既有設定，只覆寫指定的 key
fn patch_ini(content: &str, patches: &[(&str, &[(&str, &str)])]) -> String {
    // 解析成 sections: Vec<(section_name, Vec<(key, value)>)>
    let mut sections: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut current_section = String::new();
    let mut current_entries: Vec<(String, String)> = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            sections.push((current_section.clone(), current_entries.clone()));
            current_section = trimmed[1..trimmed.len() - 1].to_string();
            current_entries = Vec::new();
        } else if let Some(eq) = trimmed.find('=') {
            current_entries.push((trimmed[..eq].to_string(), trimmed[eq + 1..].to_string()));
        }
    }
    sections.push((current_section, current_entries));

    // 套用修補
    for (section_name, entries) in patches {
        let sec = sections
            .iter_mut()
            .find(|(s, _)| s == section_name);

        if let Some((_, sec_entries)) = sec {
            for (key, value) in *entries {
                if let Some((_, v)) = sec_entries.iter_mut().find(|(k, _)| k == key) {
                    *v = value.to_string();
                } else {
                    sec_entries.push((key.to_string(), value.to_string()));
                }
            }
        } else {
            sections.push((
                section_name.to_string(),
                entries
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ));
        }
    }

    // 輸出
    let mut output = String::new();
    for (section, entries) in &sections {
        if !section.is_empty() {
            output.push_str(&format!("[{}]\n", section));
        }
        for (key, value) in entries {
            output.push_str(&format!("{}={}\n", key, value));
        }
        if !section.is_empty() {
            output.push('\n');
        }
    }
    output
}

// -------------------------------------------------------------------------
// 啟動 / 等待
// -------------------------------------------------------------------------

/// 以隱藏模式啟動 OBS（最小化到系統匣）
pub fn launch_obs_hidden(exe_path: &Path) -> Result<u32, String> {
    // 清除 ProgramData 舊設定（避免 "Unable to migrate global configuration" 彈窗）
    // OBS 偵測到 ProgramData 和 AppData 都有設定時會顯示遷移衝突對話框
    cleanup_programdata_obs();

    // 取得 OBS 執行檔所在目錄，作為工作目錄
    // OBS 需要在自己的目錄下才能找到 locale/en-US.ini 等相對路徑資源
    let obs_dir = exe_path
        .parent()
        .ok_or("無法取得 OBS 目錄路徑")?;

    let child = std::process::Command::new(exe_path)
        .current_dir(obs_dir)
        .args([
            "--minimize-to-tray",
            "--startvirtualcam",
            "--multi",
            "--disable-missing-files-check",
            "--disable-updater",
        ])
        .spawn()
        .map_err(|e| format!("啟動 OBS 失敗: {}", e))?;

    let pid = child.id();
    OBS_PID.store(pid, Ordering::SeqCst);
    OBS_LAUNCHED_BY_US.store(true, Ordering::SeqCst);

    Ok(pid)
}

/// 等待 OBS WebSocket 就緒（輪詢直到可連線）
pub async fn wait_for_websocket(timeout_secs: u64) -> Result<(), String> {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs);

    loop {
        if start.elapsed() > timeout {
            return Err(format!(
                "等待 OBS 啟動超時（{}秒），請確認 OBS 是否正常運行",
                timeout_secs
            ));
        }

        if crate::obs_virtual_cam::check_websocket_available().await {
            return Ok(());
        }

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

// -------------------------------------------------------------------------
// 主要入口
// -------------------------------------------------------------------------

/// 確保 OBS 就緒（一鍵搞定：偵測 → 下載 → 安裝 → 設定 → 啟動 → 等待）
pub async fn ensure_obs_ready(app: &tauri::AppHandle) -> Result<(), String> {
    let status = detect_obs();

    // 情況 1：OBS 已經在跑且 WebSocket 可用 → 直接用
    if status.running {
        app.emit("obs-install-progress", "偵測到 OBS 已在運行，正在連接...")
            .ok();
        if crate::obs_virtual_cam::check_websocket_available().await {
            app.emit("obs-install-progress", "OBS 連接成功").ok();
            return Ok(());
        }
        // WebSocket 不可用 → 殺掉重來
        app.emit("obs-install-progress", "OBS WebSocket 未就緒，正在重新設定...")
            .ok();
        kill_obs_process();
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }

    // 情況 2：OBS 沒裝 → 下載 + 安裝
    if !status.installed && !detect_obs().installed {
        app.emit(
            "obs-install-progress",
            "首次使用需要下載虛擬鏡頭驅動（OBS Studio）...",
        )
        .ok();
        let installer = download_obs(app).await?;
        install_obs_silent(&installer, app).await?;
    }

    // 重新偵測取得 exe 路徑
    let exe_path = detect_obs()
        .exe_path
        .ok_or("找不到 OBS 執行檔，安裝可能失敗")?;

    // 情況 3：設定 + 啟動
    app.emit("obs-install-progress", "正在設定虛擬鏡頭環境...")
        .ok();
    configure_obs()?;

    app.emit("obs-install-progress", "正在啟動虛擬鏡頭（背景模式）...")
        .ok();
    launch_obs_hidden(&exe_path)?;

    app.emit("obs-install-progress", "等待虛擬鏡頭就緒...")
        .ok();
    wait_for_websocket(30).await?;

    app.emit("obs-install-progress", "虛擬鏡頭環境就緒！")
        .ok();
    Ok(())
}

// -------------------------------------------------------------------------
// 清理
// -------------------------------------------------------------------------

/// 清理 OBS（停止虛擬鏡頭 + 關閉 OBS 程序）
pub async fn cleanup_obs() -> Result<(), String> {
    // 嘗試停止虛擬鏡頭
    let _ = crate::obs_virtual_cam::stop_virtual_camera(None).await;

    // 只關閉由我們啟動的 OBS
    if OBS_LAUNCHED_BY_US.load(Ordering::SeqCst) {
        kill_obs_process();
        OBS_LAUNCHED_BY_US.store(false, Ordering::SeqCst);
        OBS_PID.store(0, Ordering::SeqCst);
    }

    Ok(())
}

/// 強制結束 OBS 程序
fn kill_obs_process() {
    let pid = OBS_PID.load(Ordering::SeqCst);
    if pid > 0 {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .creation_flags(0x08000000)
            .output();
    }
}

/// 查詢 OBS 狀態（給前端用）
pub fn get_obs_status() -> serde_json::Value {
    let det = detect_obs();
    serde_json::json!({
        "installed": det.installed,
        "running": det.running,
        "launched_by_us": OBS_LAUNCHED_BY_US.load(Ordering::SeqCst),
    })
}
