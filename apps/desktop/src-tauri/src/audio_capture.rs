//! 音訊捕捉模組 — 使用 cpal 捕捉麥克風音訊

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static SELECTED_DEVICE: Mutex<Option<String>> = Mutex::new(None);

/// 列出可用的音訊輸入裝置
pub fn list_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.name().ok())
        .collect();
    Ok(devices)
}

/// 設定音訊輸入裝置
pub fn set_device(name: &str) -> Result<(), String> {
    let mut device = SELECTED_DEVICE.lock().map_err(|e| e.to_string())?;
    *device = Some(name.to_string());
    Ok(())
}

/// 開始音訊捕捉
pub fn start_capture() -> Result<(), String> {
    ACTIVE.store(true, Ordering::SeqCst);

    // TODO: 實作完整的音訊捕捉迴圈
    // 使用 cpal 建立輸入串流
    // 將音訊資料傳給 STT 模組處理

    Ok(())
}

/// 停止音訊捕捉
pub fn stop_capture() {
    ACTIVE.store(false, Ordering::SeqCst);
}

/// 檢查是否正在捕捉
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}
