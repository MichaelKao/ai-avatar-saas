//! STT 模組 — 使用 Whisper.cpp 進行本機語音辨識

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// 開始語音辨識
pub fn start_recognition(app: tauri::AppHandle) -> Result<(), String> {
    ACTIVE.store(true, Ordering::SeqCst);

    // TODO: 在背景執行緒啟動 Whisper
    // 1. 載入 Whisper 模型（whisper-rs）
    // 2. 持續接收音訊資料
    // 3. 偵測靜音（> 0.8 秒）表示句子結束
    // 4. 轉文字後透過 Tauri event 發送：
    //    app.emit("stt-result", text).ok();

    std::thread::spawn(move || {
        while ACTIVE.load(Ordering::SeqCst) {
            // Whisper 處理迴圈
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });

    Ok(())
}

/// 停止語音辨識
pub fn stop_recognition() {
    ACTIVE.store(false, Ordering::SeqCst);
}

/// 檢查是否正在辨識
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}
