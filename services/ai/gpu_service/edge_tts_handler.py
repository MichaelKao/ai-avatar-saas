"""Edge TTS 快速語音合成 Handler

使用 Microsoft Edge TTS（免費、快速、延遲 < 1 秒）。
適合不需要語音克隆的場景，作為 CosyVoice 的輕量替代方案。

安裝：
    pip install edge-tts
"""

import os
import uuid
import time
import logging
from pathlib import Path

import edge_tts

logger = logging.getLogger(__name__)

# 輸出目錄
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/workspace/outputs"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 繁體中文語音對照表
VOICE_MAP = {
    "female": "zh-TW-HsiaoYuNeural",   # 台灣女聲（清晰）
    "male": "zh-TW-YunJheNeural",       # 台灣男聲（清晰）
}

# 支援的語音清單（方便日後擴充）
SUPPORTED_VOICES = {
    "zh-TW-HsiaoYuNeural": {"gender": "female", "language": "zh-TW", "description": "台灣繁體中文女聲"},
    "zh-TW-YunJheNeural": {"gender": "male", "language": "zh-TW", "description": "台灣繁體中文男聲"},
}


async def fast_synthesize(text: str, voice_gender: str = "female") -> str:
    """快速語音合成（Edge TTS），回傳音訊檔案路徑

    Args:
        text: 要合成的文字
        voice_gender: 語音性別，"male" 或 "female"（預設 "female"）

    Returns:
        音訊檔案的絕對路徑（WAV 格式）

    Raises:
        ValueError: 不支援的性別參數或空文字
        RuntimeError: Edge TTS 合成失敗
    """
    # 參數驗證
    if not text or not text.strip():
        raise ValueError("合成文字不能為空")

    voice_gender = voice_gender.lower().strip()
    if voice_gender not in VOICE_MAP:
        raise ValueError(f"不支援的語音性別: {voice_gender}，僅支援 'male' 或 'female'")

    # 選擇語音
    voice = VOICE_MAP[voice_gender]

    # 產生輸出檔案路徑（使用 MP3 中繼，再轉成 WAV）
    file_id = str(uuid.uuid4())
    mp3_path = OUTPUT_DIR / f"edge_tts_{file_id}.mp3"
    wav_path = OUTPUT_DIR / f"edge_tts_{file_id}.wav"

    start_t = time.time()

    try:
        # 使用 edge-tts 合成語音（輸出 MP3）
        communicate = edge_tts.Communicate(text=text, voice=voice)
        await communicate.save(str(mp3_path))

        elapsed_tts = time.time() - start_t
        logger.info(f"Edge TTS 合成完成: voice={voice} 耗時={elapsed_tts:.3f}s 檔案={mp3_path}")

        # 將 MP3 轉換為 WAV（使用 pydub 或 ffmpeg）
        wav_path_str = await _convert_mp3_to_wav(str(mp3_path), str(wav_path))

        elapsed_total = time.time() - start_t
        logger.info(f"Edge TTS 完成（含轉檔）: 總耗時={elapsed_total:.3f}s 檔案={wav_path_str}")

        return wav_path_str

    except Exception as e:
        logger.error(f"Edge TTS 合成失敗: {e}")
        # 清理可能產生的中繼檔案
        for p in [mp3_path, wav_path]:
            if p.exists():
                p.unlink()
        raise RuntimeError(f"Edge TTS 語音合成失敗: {str(e)}") from e
    finally:
        # 清理 MP3 中繼檔案（WAV 保留給呼叫端使用）
        if mp3_path.exists():
            mp3_path.unlink()


async def _convert_mp3_to_wav(mp3_path: str, wav_path: str) -> str:
    """將 MP3 轉換為 WAV 格式

    優先使用 pydub（需要 ffmpeg），失敗時嘗試用 subprocess 直接呼叫 ffmpeg。

    Args:
        mp3_path: MP3 檔案路徑
        wav_path: 輸出 WAV 檔案路徑

    Returns:
        WAV 檔案路徑
    """
    # 方法 1：使用 pydub
    try:
        from pydub import AudioSegment
        audio = AudioSegment.from_mp3(mp3_path)
        # 轉換為 16kHz mono 16-bit WAV（與 Whisper / CosyVoice 格式一致）
        audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)
        audio.export(wav_path, format="wav")
        return wav_path
    except ImportError:
        logger.warning("pydub 未安裝，嘗試使用 ffmpeg 命令列")
    except Exception as e:
        logger.warning(f"pydub 轉檔失敗: {e}，嘗試使用 ffmpeg 命令列")

    # 方法 2：直接呼叫 ffmpeg
    import asyncio
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-i", mp3_path,
            "-ar", "16000",       # 取樣率 16kHz
            "-ac", "1",           # 單聲道
            "-sample_fmt", "s16", # 16-bit
            wav_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()

        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg 轉檔失敗 (code={proc.returncode}): {stderr.decode()}")

        return wav_path
    except FileNotFoundError:
        raise RuntimeError(
            "無法轉換 MP3 至 WAV：找不到 ffmpeg 且 pydub 未安裝。"
            "請安裝 ffmpeg 或執行 pip install pydub"
        )


async def list_voices() -> list[dict]:
    """列出所有可用的 Edge TTS 繁體中文語音

    Returns:
        語音清單，每個包含 name, gender, language 等資訊
    """
    try:
        voices = await edge_tts.list_voices()
        # 篩選繁體中文語音
        zh_tw_voices = [
            {
                "name": v["ShortName"],
                "gender": v["Gender"].lower(),
                "language": v["Locale"],
                "friendly_name": v.get("FriendlyName", v["ShortName"]),
            }
            for v in voices
            if v["Locale"].startswith("zh-TW")
        ]
        return zh_tw_voices
    except Exception as e:
        logger.error(f"取得語音清單失敗: {e}")
        return []
