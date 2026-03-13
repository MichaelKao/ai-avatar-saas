//! 串流音訊播放器 — 邊收邊播，支援 gapless 無縫串接和打斷
//! 取代原本「下載完整 WAV → 播放」的模式

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::audio_capture;

/// 全域播放器狀態
static PLAYER: std::sync::OnceLock<Arc<Mutex<StreamingPlayer>>> = std::sync::OnceLock::new();

/// 取得全域播放器
fn get_player() -> &'static Arc<Mutex<StreamingPlayer>> {
    PLAYER.get_or_init(|| Arc::new(Mutex::new(StreamingPlayer::new())))
}

/// 串流播放器
pub struct StreamingPlayer {
    /// 待播放的音訊 chunk 佇列（已解碼的 f32 samples）
    queue: Arc<Mutex<VecDeque<Vec<f32>>>>,
    /// 目前是否正在播放
    playing: Arc<AtomicBool>,
    /// 佇列中的 chunk 總數（用於追蹤進度）
    total_chunks: Arc<AtomicUsize>,
    /// 已播放完的 chunk 數
    played_chunks: Arc<AtomicUsize>,
    /// 是否已被取消
    cancelled: Arc<AtomicBool>,
    /// 播放執行緒 handle
    play_thread: Option<std::thread::JoinHandle<()>>,
}

impl StreamingPlayer {
    fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            playing: Arc::new(AtomicBool::new(false)),
            total_chunks: Arc::new(AtomicUsize::new(0)),
            played_chunks: Arc::new(AtomicUsize::new(0)),
            cancelled: Arc::new(AtomicBool::new(false)),
            play_thread: None,
        }
    }
}

/// 將音訊 chunk 加入播放佇列
/// 如果是第一個 chunk，自動啟動播放
pub fn enqueue_audio_chunk(wav_bytes: &[u8]) -> Result<(), String> {
    let player = get_player();
    let mut p = player.lock().map_err(|e| format!("鎖定失敗: {}", e))?;

    // 解碼 WAV
    let cursor = std::io::Cursor::new(wav_bytes);
    let mut reader = hound::WavReader::new(cursor)
        .map_err(|e| format!("解析 WAV 失敗: {}", e))?;
    let spec = reader.spec();
    let wav_samples: Vec<f32> = if spec.bits_per_sample == 16 {
        reader
            .samples::<i16>()
            .filter_map(|s| s.ok())
            .map(|s| s as f32 / 32768.0)
            .collect()
    } else {
        reader
            .samples::<i32>()
            .filter_map(|s| s.ok())
            .map(|s| s as f32 / 2147483648.0)
            .collect()
    };

    if wav_samples.is_empty() {
        return Err("音訊資料為空".to_string());
    }

    // 混成 mono
    let wav_channels = spec.channels as usize;
    let mono_samples: Vec<f32> = wav_samples
        .chunks(wav_channels)
        .map(|frame| frame.iter().sum::<f32>() / wav_channels as f32)
        .collect();

    // 存入佇列
    {
        let mut queue = p.queue.lock().map_err(|e| format!("佇列鎖定失敗: {}", e))?;
        queue.push_back(mono_samples);
    }
    p.total_chunks.fetch_add(1, Ordering::SeqCst);

    // 如果尚未播放，啟動播放
    if !p.playing.load(Ordering::SeqCst) {
        p.cancelled.store(false, Ordering::SeqCst);
        p.played_chunks.store(0, Ordering::SeqCst);
        start_playback(&mut p)?;
    }

    Ok(())
}

/// 啟動背景播放執行緒
fn start_playback(player: &mut StreamingPlayer) -> Result<(), String> {
    let queue = player.queue.clone();
    let playing = player.playing.clone();
    let played_chunks = player.played_chunks.clone();
    let cancelled = player.cancelled.clone();

    playing.store(true, Ordering::SeqCst);
    // 第一個 chunk 開始播放時就啟動回饋迴圈防護
    audio_capture::set_playback_active(true);

    let handle = std::thread::spawn(move || {
        if let Err(e) = playback_loop(queue, playing.clone(), played_chunks, cancelled) {
            eprintln!("播放迴圈錯誤: {}", e);
        }
        // 播放結束：冷卻 + 清空 buffer
        std::thread::sleep(std::time::Duration::from_millis(2000));
        audio_capture::flush_buffer();
        audio_capture::set_playback_active(false);
        playing.store(false, Ordering::SeqCst);
    });

    player.play_thread = Some(handle);
    Ok(())
}

/// 播放迴圈：從佇列取 chunk → 播放 → 取下一個（gapless）
fn playback_loop(
    queue: Arc<Mutex<VecDeque<Vec<f32>>>>,
    playing: Arc<AtomicBool>,
    played_chunks: Arc<AtomicUsize>,
    cancelled: Arc<AtomicBool>,
) -> Result<(), String> {
    // 找到 VB-Cable 輸出裝置
    let host = cpal::default_host();
    let vb_device = host
        .output_devices()
        .map_err(|e| format!("列舉裝置失敗: {}", e))?
        .find(|d| {
            d.name()
                .map(|n| {
                    let lower = n.to_lowercase();
                    lower.contains("cable") && lower.contains("input")
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| "找不到 VB-Cable Input 裝置".to_string())?;

    let device_config = vb_device
        .default_output_config()
        .map_err(|e| format!("取得設定失敗: {}", e))?;
    let device_sample_rate = device_config.sample_rate().0;
    let device_channels = device_config.channels() as usize;

    let config = cpal::StreamConfig {
        channels: device_channels as u16,
        sample_rate: cpal::SampleRate(device_sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    loop {
        if cancelled.load(Ordering::SeqCst) {
            break;
        }

        // 從佇列取出下一個 chunk
        let chunk = {
            let mut q = queue.lock().map_err(|e| format!("佇列鎖定失敗: {}", e))?;
            q.pop_front()
        };

        let samples = match chunk {
            Some(s) => s,
            None => {
                // 佇列空了，等一下看有沒有新的
                std::thread::sleep(std::time::Duration::from_millis(100));
                // 再檢查一次
                let still_empty = {
                    let q = queue.lock().map_err(|e| format!("鎖定失敗: {}", e))?;
                    q.is_empty()
                };
                if still_empty {
                    // 確實沒有了，結束播放
                    break;
                }
                continue;
            }
        };

        // 重新取樣到裝置取樣率
        let resampled = if device_sample_rate != 16000 {
            simple_resample(&samples, 16000, device_sample_rate)
        } else {
            samples
        };

        // 擴展到裝置聲道數
        let final_samples: Vec<f32> = if device_channels > 1 {
            resampled
                .iter()
                .flat_map(|&s| std::iter::repeat(s).take(device_channels))
                .collect()
        } else {
            resampled
        };

        // 播放這個 chunk
        let total = final_samples.len();
        let samples_arc = Arc::new(final_samples);
        let pos = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicBool::new(false));

        let samples_clone = samples_arc.clone();
        let pos_clone = pos.clone();
        let done_clone = done.clone();
        let cancelled_clone = cancelled.clone();

        let stream = vb_device
            .build_output_stream(
                &config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    if cancelled_clone.load(Ordering::Relaxed) {
                        for sample in data.iter_mut() {
                            *sample = 0.0;
                        }
                        done_clone.store(true, Ordering::Relaxed);
                        return;
                    }
                    for sample in data.iter_mut() {
                        let idx = pos_clone.load(Ordering::Relaxed);
                        if idx >= samples_clone.len() {
                            *sample = 0.0;
                            done_clone.store(true, Ordering::Relaxed);
                        } else {
                            *sample = samples_clone[idx];
                            pos_clone.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                },
                |e| eprintln!("音訊串流錯誤: {}", e),
                None,
            )
            .map_err(|e| format!("建立音訊串流失敗: {}", e))?;

        stream
            .play()
            .map_err(|e| format!("播放失敗: {}", e))?;

        // 等待播放完成
        let duration_secs = total as f64 / (device_sample_rate as f64 * device_channels as f64);
        let wait_ms = (duration_secs * 1000.0) as u64 + 200;
        let start = std::time::Instant::now();

        while !done.load(Ordering::Relaxed) && !cancelled.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(10));
            if start.elapsed().as_millis() as u64 > wait_ms {
                break;
            }
        }

        drop(stream);
        played_chunks.fetch_add(1, Ordering::SeqCst);
    }

    Ok(())
}

/// 取消所有播放（打斷機制）
pub fn cancel_playback() {
    if let Ok(mut p) = get_player().lock() {
        p.cancelled.store(true, Ordering::SeqCst);
        // 清空佇列
        if let Ok(mut q) = p.queue.lock() {
            q.clear();
        }
        p.total_chunks.store(0, Ordering::SeqCst);
        p.played_chunks.store(0, Ordering::SeqCst);
    }
}

/// 檢查是否正在播放
pub fn is_playing() -> bool {
    if let Ok(p) = get_player().lock() {
        p.playing.load(Ordering::SeqCst)
    } else {
        false
    }
}

/// 簡單線性重新取樣
fn simple_resample(data: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
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
