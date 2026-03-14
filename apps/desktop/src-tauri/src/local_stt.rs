//! 本機 Whisper STT — 使用預編譯的 whisper.cpp CLI 在用戶電腦本機執行語音辨識
//! 省去上傳音訊到伺服器的網路延遲，不需要 LLVM/cmake 等編譯依賴

use std::path::PathBuf;
use std::sync::OnceLock;

static MODEL_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 設定模型儲存目錄
pub fn set_model_dir(dir: PathBuf) {
    MODEL_DIR.set(dir).ok();
}

/// 取得基礎目錄
fn base_dir() -> PathBuf {
    MODEL_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("ai-avatar-models"))
}

/// whisper CLI 執行檔路徑
fn cli_path() -> PathBuf {
    base_dir().join("whisper-cli.exe")
}

/// GGML 模型檔案路徑
fn model_path() -> PathBuf {
    base_dir().join("ggml-base.bin")
}

/// 檢查 CLI 和模型是否都已下載
pub fn is_ready() -> bool {
    cli_path().exists() && model_path().exists()
}

/// 取得狀態
pub fn status() -> serde_json::Value {
    serde_json::json!({
        "cli_downloaded": cli_path().exists(),
        "model_downloaded": model_path().exists(),
        "ready": is_ready(),
        "base_dir": base_dir().to_string_lossy(),
    })
}

/// 下載 whisper.cpp CLI + GGML 模型
pub async fn download_all(app: tauri::AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;
    use tauri::Emitter;

    let dir = base_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建立目錄失敗: {}", e))?;

    // Step 1: 下載 whisper.cpp CLI binary（從 GitHub Release）
    if !cli_path().exists() {
        app.emit("stt-download-progress", "正在取得 whisper.cpp 最新版本...")
            .ok();

        // 查詢最新 release
        let client = reqwest::Client::builder()
            .user_agent("AI-Avatar-Desktop/0.5.0")
            .build()
            .map_err(|e| format!("建立 HTTP client 失敗: {}", e))?;

        let release: serde_json::Value = client
            .get("https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest")
            .send()
            .await
            .map_err(|e| format!("取得 release 資訊失敗: {}", e))?
            .json()
            .await
            .map_err(|e| format!("解析 release 資訊失敗: {}", e))?;

        // 找到 Windows x64 binary asset
        let assets = release["assets"]
            .as_array()
            .ok_or("Release 沒有 assets")?;
        let bin_asset = assets
            .iter()
            .find(|a| {
                let name = a["name"].as_str().unwrap_or("");
                name.contains("bin") && name.contains("x64") && name.ends_with(".zip")
            })
            .ok_or("找不到 Windows x64 binary asset")?;

        let download_url = bin_asset["browser_download_url"]
            .as_str()
            .ok_or("Asset 沒有 download URL")?;
        let asset_name = bin_asset["name"].as_str().unwrap_or("whisper-bin.zip");

        app.emit(
            "stt-download-progress",
            &format!("下載 {}...", asset_name),
        )
        .ok();

        // 下載 zip
        let zip_path = dir.join("whisper-bin.zip");
        download_file(&client, download_url, &zip_path, &app, "stt-download-progress").await?;

        // 解壓縮 — 找到 main.exe 或 whisper-cli.exe
        app.emit("stt-download-progress", "解壓縮 whisper.cpp...").ok();
        let file = std::fs::File::open(&zip_path)
            .map_err(|e| format!("開啟 zip 失敗: {}", e))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("解壓 zip 失敗: {}", e))?;

        let mut found_cli = false;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("讀取 zip 項目失敗: {}", e))?;
            let name = entry.name().to_string();

            // 尋找 CLI 執行檔（main.exe 或 whisper-cli.exe）
            if (name.ends_with("main.exe") || name.ends_with("whisper-cli.exe")) && !name.contains("bench") {
                let out_path = cli_path();
                let mut out_file = std::fs::File::create(&out_path)
                    .map_err(|e| format!("建立檔案失敗: {}", e))?;
                std::io::copy(&mut entry, &mut out_file)
                    .map_err(|e| format!("寫入失敗: {}", e))?;
                found_cli = true;
                break;
            }
        }

        // 清理 zip
        let _ = std::fs::remove_file(&zip_path);

        if !found_cli {
            return Err("zip 中找不到 whisper CLI 執行檔（main.exe 或 whisper-cli.exe）".to_string());
        }
    }

    // Step 2: 下載 GGML base 模型
    if !model_path().exists() {
        app.emit(
            "stt-download-progress",
            "下載 Whisper base 模型 (~142MB)...",
        )
        .ok();

        let client = reqwest::Client::new();
        let url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
        download_file(&client, url, &model_path(), &app, "stt-download-progress").await?;
    }

    app.emit("stt-download-progress", "本機 STT 就緒！").ok();
    Ok(())
}

/// 本機語音辨識（同步，在 spawn_blocking 中呼叫）
pub fn transcribe(audio_data: &[i16], sample_rate: u32) -> Result<String, String> {
    if !is_ready() {
        return Err("本機 STT 未就緒，請先下載模型".to_string());
    }

    // 將音訊寫成 WAV 暫存檔
    let tmp_wav = std::env::temp_dir().join("ai-avatar-stt-input.wav");
    {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&tmp_wav, spec)
            .map_err(|e| format!("建立 WAV 失敗: {}", e))?;
        for &sample in audio_data {
            writer
                .write_sample(sample)
                .map_err(|e| format!("寫入 WAV 失敗: {}", e))?;
        }
        writer
            .finalize()
            .map_err(|e| format!("完成 WAV 失敗: {}", e))?;
    }

    // 執行 whisper CLI
    let output = std::process::Command::new(cli_path())
        .args([
            "-m",
            model_path().to_str().unwrap_or(""),
            "-f",
            tmp_wav.to_str().unwrap_or(""),
            "-l",
            "zh",           // 強制中文
            "--no-timestamps",
            "-np",          // no print progress
            "-nt",          // no timestamps in output
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW (Windows)
        .output()
        .map_err(|e| format!("執行 whisper CLI 失敗: {}", e))?;

    // 清理暫存檔
    let _ = std::fs::remove_file(&tmp_wav);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("whisper CLI 錯誤: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // whisper CLI 輸出每行一個 segment，去掉時間戳後合併
    let text: String = stdout
        .lines()
        .map(|line| {
            // 移除 [HH:MM:SS.mmm --> HH:MM:SS.mmm] 前綴
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                if let Some(idx) = trimmed.find(']') {
                    return trimmed[idx + 1..].trim();
                }
            }
            trimmed
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("");

    Ok(text.trim().to_string())
}

/// 通用檔案下載（支援進度回報）
async fn download_file(
    client: &reqwest::Client,
    url: &str,
    path: &PathBuf,
    app: &tauri::AppHandle,
    event_name: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;
    use tauri::Emitter;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下載請求失敗: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("下載失敗: HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut last_pct: u32 = 0;

    let tmp_path = path.with_extension("tmp");
    let mut file =
        std::fs::File::create(&tmp_path).map_err(|e| format!("建立暫存檔失敗: {}", e))?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下載中斷: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("寫入失敗: {}", e))?;
        downloaded += chunk.len() as u64;

        if total > 0 {
            let pct = (downloaded as f64 / total as f64 * 100.0) as u32;
            if pct != last_pct {
                last_pct = pct;
                app.emit(
                    event_name,
                    &format!(
                        "下載中... {}% ({:.1}MB/{:.1}MB)",
                        pct,
                        downloaded as f64 / 1_048_576.0,
                        total as f64 / 1_048_576.0
                    ),
                )
                .ok();
            }
        }
    }

    // 改名（原子替換）
    std::fs::rename(&tmp_path, path).map_err(|e| format!("重命名失敗: {}", e))?;
    Ok(())
}

// Windows CREATE_NO_WINDOW flag
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(not(target_os = "windows"))]
trait CommandExt {
    fn creation_flags(&mut self, _: u32) -> &mut Self;
}
#[cfg(not(target_os = "windows"))]
impl CommandExt for std::process::Command {
    fn creation_flags(&mut self, _: u32) -> &mut Self {
        self
    }
}
