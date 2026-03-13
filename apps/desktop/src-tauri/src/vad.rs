//! Voice Activity Detection — 偵測語音開始/結束
//! 使用能量閾值法 + 300ms 靜音判定，取代固定 5 秒 chunk

/// 32ms frame（512 samples @ 16kHz）
const FRAME_SIZE: usize = 512;
/// 連續靜音幀數閾值（300ms ≈ 10 frames × 32ms）
const SILENCE_FRAMES_THRESHOLD: usize = 10;
/// 最小語音長度（避免偵測到噪音碎片，160ms ≈ 5 frames）
const MIN_SPEECH_FRAMES: usize = 5;
/// 預設能量閾值（i16 RMS）
const DEFAULT_ENERGY_THRESHOLD: f64 = 150.0;
/// 最大語句長度（秒），超過強制切段
const MAX_UTTERANCE_SECS: f64 = 15.0;
/// 最大語句取樣數
const MAX_UTTERANCE_SAMPLES: usize = (16000.0 * MAX_UTTERANCE_SECS) as usize;

#[derive(Debug, PartialEq)]
enum VadState {
    /// 靜音中，等待語音開始
    Silence,
    /// 偵測到語音，正在收集
    Speech,
    /// 語音可能結束，計數靜音幀
    SpeechEnding,
}

/// 語音活動偵測器
pub struct VoiceActivityDetector {
    state: VadState,
    /// 累積的語音 PCM（16kHz i16 mono）
    speech_buffer: Vec<i16>,
    /// 連續靜音幀計數
    silence_frame_count: usize,
    /// 語音幀計數
    speech_frame_count: usize,
    /// 能量閾值
    energy_threshold: f64,
    /// 未滿一幀的殘留取樣
    frame_remainder: Vec<i16>,
}

impl VoiceActivityDetector {
    pub fn new() -> Self {
        Self {
            state: VadState::Silence,
            speech_buffer: Vec::with_capacity(16000 * 5), // 預分配 5 秒
            silence_frame_count: 0,
            speech_frame_count: 0,
            energy_threshold: DEFAULT_ENERGY_THRESHOLD,
            frame_remainder: Vec::new(),
        }
    }

    /// 餵入一批 16kHz i16 mono 取樣
    /// 回傳完整語句（如果偵測到語音結束）
    pub fn process_samples(&mut self, samples: &[i16]) -> Vec<Vec<i16>> {
        let mut utterances = Vec::new();

        // 將新取樣加入殘留 buffer
        self.frame_remainder.extend_from_slice(samples);

        // 每次處理一個 32ms frame（512 取樣）
        while self.frame_remainder.len() >= FRAME_SIZE {
            let frame: Vec<i16> = self.frame_remainder.drain(..FRAME_SIZE).collect();
            if let Some(utterance) = self.process_frame(&frame) {
                utterances.push(utterance);
            }
        }

        utterances
    }

    /// 處理單一 32ms frame，回傳完整語句（如果偵測到結束）
    fn process_frame(&mut self, frame: &[i16]) -> Option<Vec<i16>> {
        let rms = frame_rms(frame);
        let is_speech = rms > self.energy_threshold;

        match self.state {
            VadState::Silence => {
                if is_speech {
                    self.state = VadState::Speech;
                    self.speech_buffer.clear();
                    self.speech_buffer.extend_from_slice(frame);
                    self.speech_frame_count = 1;
                    self.silence_frame_count = 0;
                }
                None
            }
            VadState::Speech => {
                self.speech_buffer.extend_from_slice(frame);
                if is_speech {
                    self.speech_frame_count += 1;
                    // 超過最大長度，強制切段
                    if self.speech_buffer.len() >= MAX_UTTERANCE_SAMPLES {
                        return self.emit_utterance();
                    }
                } else {
                    self.state = VadState::SpeechEnding;
                    self.silence_frame_count = 1;
                }
                None
            }
            VadState::SpeechEnding => {
                self.speech_buffer.extend_from_slice(frame);
                if is_speech {
                    // 語音恢復，回到 Speech 狀態
                    self.state = VadState::Speech;
                    self.speech_frame_count += 1;
                    self.silence_frame_count = 0;
                    // 超過最大長度，強制切段
                    if self.speech_buffer.len() >= MAX_UTTERANCE_SAMPLES {
                        return self.emit_utterance();
                    }
                    None
                } else {
                    self.silence_frame_count += 1;
                    if self.silence_frame_count >= SILENCE_FRAMES_THRESHOLD {
                        // 300ms 靜音確認，語句結束
                        return self.emit_utterance();
                    }
                    None
                }
            }
        }
    }

    /// 輸出累積的語句並重設狀態
    fn emit_utterance(&mut self) -> Option<Vec<i16>> {
        self.state = VadState::Silence;
        let frame_count = self.speech_frame_count;
        self.speech_frame_count = 0;
        self.silence_frame_count = 0;

        // 語音太短（< 160ms），視為雜訊丟棄
        if frame_count < MIN_SPEECH_FRAMES {
            self.speech_buffer.clear();
            return None;
        }

        let utterance = std::mem::take(&mut self.speech_buffer);
        Some(utterance)
    }

    /// 強制輸出剩餘語句（停止擷取時呼叫）
    pub fn flush(&mut self) -> Option<Vec<i16>> {
        if self.speech_frame_count >= MIN_SPEECH_FRAMES && !self.speech_buffer.is_empty() {
            self.state = VadState::Silence;
            self.speech_frame_count = 0;
            self.silence_frame_count = 0;
            let utterance = std::mem::take(&mut self.speech_buffer);
            Some(utterance)
        } else {
            self.speech_buffer.clear();
            self.state = VadState::Silence;
            self.speech_frame_count = 0;
            self.silence_frame_count = 0;
            None
        }
    }

    /// 重設 VAD 狀態（播放結束後清空）
    pub fn reset(&mut self) {
        self.state = VadState::Silence;
        self.speech_buffer.clear();
        self.speech_frame_count = 0;
        self.silence_frame_count = 0;
        self.frame_remainder.clear();
    }
}

/// 計算 frame 的 RMS 能量
fn frame_rms(frame: &[i16]) -> f64 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum: f64 = frame.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum / frame.len() as f64).sqrt()
}
