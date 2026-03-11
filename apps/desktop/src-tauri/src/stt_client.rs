//! STT 客戶端 — 傳送音訊到 GPU Whisper 服務

use reqwest::multipart;

/// Send audio PCM data to STT service and get transcribed text
pub async fn transcribe(audio_data: &[i16], sample_rate: u32, gpu_url: &str) -> Result<String, String> {
    // Encode as WAV
    let wav_data = encode_wav(audio_data, sample_rate)?;

    let client = reqwest::Client::new();
    let part = multipart::Part::bytes(wav_data)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("MIME error: {}", e))?;

    // 指定語言為中文，避免 Whisper 自動偵測把中文聽成英文/日文
    // 加入 initial_prompt 引導 Whisper 辨識常見會議用語，提升準確度
    let form = multipart::Form::new()
        .part("audio", part)
        .text("language", "zh")
        .text("initial_prompt", "會議討論、Spring Boot、技術架構、商業計畫、專案管理");

    let resp = client
        .post(format!("{}/api/v1/stt/transcribe", gpu_url))
        .multipart(form)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("STT 請求失敗: {}", e))?;

    let json: serde_json::Value = resp.json().await
        .map_err(|e| format!("STT 回應解析失敗: {}", e))?;

    let text = json["data"]["text"].as_str().unwrap_or("").to_string();
    Ok(text)
}

/// Encode PCM i16 data as WAV bytes
fn encode_wav(data: &[i16], sample_rate: u32) -> Result<Vec<u8>, String> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = hound::WavWriter::new(&mut cursor, spec)
        .map_err(|e| format!("WAV 編碼失敗: {}", e))?;

    for &sample in data {
        writer.write_sample(sample)
            .map_err(|e| format!("WAV 寫入失敗: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| format!("WAV 完成失敗: {}", e))?;

    Ok(cursor.into_inner())
}
