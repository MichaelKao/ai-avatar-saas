//! 虛擬攝影機模組 — 將 AI 生成的影片輸出到虛擬攝影機
//!
//! 使用 OBS Virtual Camera 或 Unity Capture
//! Windows: 需要安裝 OBS Studio 或 OBS Virtual Camera plugin
//! macOS: 需要安裝 OBS Studio

use std::sync::atomic::{AtomicBool, Ordering};

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// 啟動虛擬攝影機
pub fn start() -> Result<(), String> {
    // TODO: 實作虛擬攝影機
    // Windows: 使用 DirectShow API
    // macOS: 使用 CoreMediaIO DAL plugin
    //
    // 簡化方案：使用 OBS Virtual Camera
    // 1. 啟動 OBS 的虛擬攝影機
    // 2. 將影片幀寫入共享記憶體
    // 3. OBS 從共享記憶體讀取並輸出

    ACTIVE.store(true, Ordering::SeqCst);
    Ok(())
}

/// 輸出影片幀到虛擬攝影機
pub fn write_frame(frame_data: &[u8], width: u32, height: u32) -> Result<(), String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err("虛擬攝影機未啟動".to_string());
    }

    // TODO: 將幀資料寫入虛擬攝影機

    Ok(())
}

/// 停止虛擬攝影機
pub fn stop() {
    ACTIVE.store(false, Ordering::SeqCst);
}

/// 檢查是否正在運行
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}
