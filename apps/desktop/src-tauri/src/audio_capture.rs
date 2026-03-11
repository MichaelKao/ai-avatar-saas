//! 系統音訊擷取 — 擷取 Zoom/Meet 播放的聲音

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::mpsc;

static CAPTURING: AtomicBool = AtomicBool::new(false);
/// AI 正在播放語音時暫停擷取（避免回饋迴圈）
static PLAYBACK_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 播放結束後清空 buffer（丟棄殘留音訊）
static FLUSH_BUFFER: AtomicBool = AtomicBool::new(false);

/// Audio chunk - 16kHz 16-bit mono PCM
pub struct AudioChunk {
    pub data: Vec<i16>,
    pub sample_rate: u32,
}

/// Start capturing system audio (WASAPI loopback)
/// Returns a receiver that yields audio chunks
pub fn start_capture() -> Result<mpsc::Receiver<AudioChunk>, String> {
    let (tx, rx) = mpsc::channel::<AudioChunk>(32);

    let host = cpal::default_host();

    // Get default output device (what Zoom plays through)
    let device = host.default_output_device()
        .ok_or("找不到音訊輸出裝置")?;

    // Use loopback config to capture what's being played
    let config = device.default_output_config()
        .map_err(|e| format!("無法取得音訊設定: {}", e))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;

    CAPTURING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        let mut buffer: Vec<f32> = Vec::new();
        let chunk_size = (sample_rate as f32 * 1.5) as usize; // 1.5 秒（加速回應速度）
        // 跳過前 1 秒的音訊（避免擷取到啟動前的殘留聲音）
        let skip_samples = sample_rate as usize;
        let mut skipped: usize = 0;

        let tx_clone = tx.clone();
        let stream = match device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !CAPTURING.load(Ordering::SeqCst) {
                    return;
                }
                // AI 播放語音中 → 丟棄音訊，避免回饋迴圈
                if PLAYBACK_ACTIVE.load(Ordering::SeqCst) {
                    return;
                }

                // 播放結束後清空 buffer（丟棄播放前殘留的音訊片段）
                if FLUSH_BUFFER.swap(false, Ordering::SeqCst) {
                    buffer.clear();
                }

                // Mix to mono
                let mono: Vec<f32> = data.chunks(channels)
                    .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                    .collect();

                // 跳過開頭的音訊殘留
                if skipped < skip_samples {
                    skipped += mono.len();
                    return;
                }

                buffer.extend_from_slice(&mono);

                // Send chunk every 1.5 seconds
                if buffer.len() >= chunk_size {
                    // Resample to 16kHz if needed
                    let resampled = if sample_rate != 16000 {
                        simple_resample(&buffer, sample_rate, 16000)
                    } else {
                        buffer.clone()
                    };

                    // Convert to i16
                    let pcm: Vec<i16> = resampled.iter()
                        .map(|&s| (s * 32767.0).clamp(-32768.0, 32767.0) as i16)
                        .collect();

                    let _ = tx_clone.try_send(AudioChunk {
                        data: pcm,
                        sample_rate: 16000,
                    });

                    buffer.clear();
                }
            },
            |err| {
                eprintln!("音訊擷取錯誤: {}", err);
            },
            None,
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("建立音訊串流失敗: {}", e);
                CAPTURING.store(false, Ordering::SeqCst);
                return;
            }
        };

        match stream.play() {
            Ok(_) => eprintln!("音訊擷取已啟動: {}Hz {}ch", sample_rate, channels),
            Err(e) => {
                eprintln!("啟動音訊串流失敗: {}", e);
                CAPTURING.store(false, Ordering::SeqCst);
                return;
            }
        }

        // Keep thread alive while capturing
        while CAPTURING.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });

    Ok(rx)
}

/// Stop capturing
pub fn stop_capture() {
    CAPTURING.store(false, Ordering::SeqCst);
}

pub fn is_capturing() -> bool {
    CAPTURING.load(Ordering::SeqCst)
}

/// 設定播放狀態（播放中暫停擷取，避免回饋迴圈）
pub fn set_playback_active(active: bool) {
    PLAYBACK_ACTIVE.store(active, Ordering::SeqCst);
}

/// 清空擷取 buffer（播放結束後呼叫，丟棄可能包含 AI 語音的殘留資料）
pub fn flush_buffer() {
    FLUSH_BUFFER.store(true, Ordering::SeqCst);
}

/// Simple linear resampling
fn simple_resample(data: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    let ratio = from_rate as f64 / to_rate as f64;
    let new_len = (data.len() as f64 / ratio) as usize;
    let mut result = Vec::with_capacity(new_len);

    for i in 0..new_len {
        let src_idx = i as f64 * ratio;
        let idx = src_idx as usize;
        let frac = src_idx - idx as f64;

        if idx + 1 < data.len() {
            result.push(data[idx] * (1.0 - frac as f32) + data[idx + 1] * frac as f32);
        } else if idx < data.len() {
            result.push(data[idx]);
        }
    }

    result
}
