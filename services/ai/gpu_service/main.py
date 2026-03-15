"""GPU AI Service — 語音克隆 + 臉部動畫
在 RunPod GPU 伺服器上運行
"""

import os
import time
import uuid
import logging
from pathlib import Path
from contextlib import asynccontextmanager

import numpy as np

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import base64
import httpx
import torch

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 模型儲存路徑
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/workspace/models"))
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/workspace/uploads"))
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/workspace/outputs"))

# 確保目錄存在
for d in [MODEL_DIR, UPLOAD_DIR, OUTPUT_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# Whisper STT 設定
WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "small")

# 全域模型變數
whisper_model = None
cosyvoice_model = None
wav2lip_model = None
musetalk_model = None
melotts_model = None
melotts_speaker_ids = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """啟動時載入模型"""
    global whisper_model, cosyvoice_model, wav2lip_model, musetalk_model

    logger.info(f"GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'}")
    logger.info(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB" if torch.cuda.is_available() else "No GPU")

    # 載入 CosyVoice 模型
    try:
        from cosyvoice_handler import CosyVoiceHandler
        cosyvoice_model = CosyVoiceHandler(MODEL_DIR)
        logger.info("CosyVoice 模型載入完成")
    except Exception as e:
        logger.warning(f"CosyVoice 載入失敗（可能尚未安裝）: {e}")

    # 載入 Wav2Lip 模型
    try:
        from wav2lip_handler import Wav2LipHandler
        wav2lip_model = Wav2LipHandler(MODEL_DIR)
        logger.info("Wav2Lip 模型載入完成")
    except Exception as e:
        logger.warning(f"Wav2Lip 載入失敗（可能尚未安裝）: {e}")

    # 載入 MuseTalk 模型（即時唇形動畫，取代 Wav2Lip）
    try:
        from musetalk_handler import MuseTalkHandler
        musetalk_model = MuseTalkHandler(MODEL_DIR)
        logger.info("MuseTalk 模型載入完成")
    except Exception as e:
        logger.warning(f"MuseTalk 載入失敗（可能尚未安裝）: {e}")

    # 載入 MeloTTS（超低延遲 TTS，~120ms）
    try:
        global melotts_model, melotts_speaker_ids
        from melo.api import TTS as MeloTTSModel
        melotts_model = MeloTTSModel(language="ZH", device="cuda" if torch.cuda.is_available() else "cpu")
        melotts_speaker_ids = melotts_model.hps.data.spk2id
        # 暖機（首次推論較慢）
        melotts_model.tts_to_file("暖機", melotts_speaker_ids["ZH"], str(OUTPUT_DIR / "_warmup.wav"))
        melotts_model.tts_to_file("暖機", melotts_speaker_ids["ZH"], str(OUTPUT_DIR / "_warmup.wav"))
        logger.info(f"MeloTTS 模型載入完成，speakers: {list(melotts_speaker_ids.keys())}")
    except Exception as e:
        logger.warning(f"MeloTTS 載入失敗: {e}")

    # 載入 Whisper STT 模型
    try:
        from faster_whisper import WhisperModel
        compute = "int8_float16" if WHISPER_MODEL_SIZE == "large-v3" else "float16"
        logger.info(f"Loading Whisper {WHISPER_MODEL_SIZE} (compute={compute})...")
        whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cuda", compute_type=compute)
        logger.info(f"Whisper {WHISPER_MODEL_SIZE} 載入完成")
    except Exception as e:
        logger.warning(f"Whisper 載入失敗: {e}")

    yield
    logger.info("GPU Service 關閉")


app = FastAPI(title="AI Avatar GPU Service", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============== 健康檢查 ==============

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "gpu-service",
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none",
        "gpu_memory_gb": round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1) if torch.cuda.is_available() else 0,
        "cosyvoice_loaded": cosyvoice_model is not None,
        "wav2lip_loaded": wav2lip_model is not None,
        "musetalk_loaded": musetalk_model is not None,
        "melotts_loaded": melotts_model is not None,
        "whisper_loaded": True,  # Whisper 由 stt_service.py 管理
    }


# ============== 語音克隆 TTS ==============

class TTSRequest(BaseModel):
    text: str
    voice_id: str  # 用戶的聲音模型 ID
    voice_gender: str = "female"  # "male" 或 "female"，僅 voice_id="default" 時使用


@app.post("/api/v1/tts/clone-voice")
async def clone_voice(voice_sample: UploadFile = File(...)):
    """上傳語音樣本 → 建立聲音模型"""
    if cosyvoice_model is None:
        raise HTTPException(503, "CosyVoice 模型未載入")

    # 儲存上傳的語音檔
    voice_id = str(uuid.uuid4())
    sample_path = UPLOAD_DIR / f"voice_{voice_id}.wav"

    with open(sample_path, "wb") as f:
        content = await voice_sample.read()
        f.write(content)

    # 建立聲音模型（提取 speaker embedding）
    try:
        cosyvoice_model.create_voice_profile(voice_id, str(sample_path))
        return {"data": {"voice_id": voice_id, "status": "ready"}, "error": None}
    except Exception as e:
        raise HTTPException(500, f"聲音模型建立失敗: {str(e)}")


@app.post("/api/v1/tts/synthesize")
async def synthesize_speech(request: TTSRequest):
    """文字 → 語音（CosyVoice 優先，Edge TTS 回退），回傳可下載的音訊 URL"""
    if cosyvoice_model is not None:
        try:
            filename = f"tts_{uuid.uuid4()}.wav"
            output_path = OUTPUT_DIR / filename
            if request.voice_id == "default":
                cosyvoice_model.synthesize_default(request.text, str(output_path), voice_gender=request.voice_gender)
            else:
                cosyvoice_model.synthesize(request.text, request.voice_id, str(output_path))
            return {"data": {"audio_url": f"/outputs/{filename}"}, "error": None}
        except Exception as e:
            logger.warning(f"CosyVoice 合成失敗，回退 Edge TTS: {e}")

    # 回退到 Edge TTS
    try:
        from edge_tts_handler import fast_synthesize
        output_path = await fast_synthesize(request.text, request.voice_gender)
        filename = Path(output_path).name
        return {"data": {"audio_url": f"/outputs/{filename}"}, "error": None}
    except Exception as e:
        raise HTTPException(500, f"語音合成失敗: {str(e)}")


@app.post("/api/v1/tts/synthesize-stream")
async def synthesize_speech_stream(request: TTSRequest):
    """文字 → 語音串流（逐句合成）"""
    if cosyvoice_model is None:
        raise HTTPException(503, "CosyVoice 模型未載入")

    async def generate():
        try:
            for chunk in cosyvoice_model.synthesize_stream(request.text, request.voice_id):
                yield chunk
        except Exception as e:
            logger.error(f"串流合成失敗: {e}")

    return StreamingResponse(generate(), media_type="audio/wav")


# ============== 串流 TTS（CosyVoice 2.0 串流模式） ==============

class StreamTTSRequest(BaseModel):
    text: str
    voice_id: str = "default"
    voice_gender: str = "female"  # "male" 或 "female"


@app.post("/api/v1/tts/stream-synthesize")
async def stream_synthesize_speech(request: StreamTTSRequest):
    """串流語音合成 — 回傳 chunked PCM（22050Hz 16bit mono）
    首 chunk < 100ms，適合即時串流播放
    CosyVoice 載入失敗時自動回退到 Edge TTS（非串流）
    """
    if cosyvoice_model is None:
        # 回退：CosyVoice 未載入，使用 Edge TTS
        try:
            from edge_tts_handler import fast_synthesize
            output_path = await fast_synthesize(request.text, request.voice_gender)
            filename = Path(output_path).name
            return {"data": {"audio_url": f"/outputs/{filename}"}, "error": None}
        except Exception as e:
            raise HTTPException(503, f"CosyVoice 未載入且 Edge TTS 也失敗: {str(e)}")

    async def generate():
        try:
            if request.voice_id == "default":
                # 使用 SFT 內建聲音（最快，首 chunk < 100ms）
                for chunk in cosyvoice_model.synthesize_stream_sft(
                    request.text, request.voice_gender
                ):
                    yield chunk
            else:
                # 使用 zero-shot 克隆聲音
                for chunk in cosyvoice_model.synthesize_stream(
                    request.text, request.voice_id
                ):
                    yield chunk
        except Exception as e:
            logger.error(f"串流 TTS 失敗: {e}")

    return StreamingResponse(
        generate(),
        media_type="application/octet-stream",
        headers={"X-Audio-Format": "pcm-22050-16bit-mono"},
    )


# ============== MeloTTS 快速語音合成（~120ms，即時對話用） ==============

@app.post("/api/v1/tts/melo-synthesize")
async def melo_synthesize_speech(request: StreamTTSRequest):
    """MeloTTS 超低延遲語音合成 — 記憶體內生成，零 file I/O
    回傳 WAV 二進位流（不寫檔），Gateway 直接讀取 bytes
    """
    if melotts_model is None:
        raise HTTPException(503, "MeloTTS 未載入")

    try:
        import asyncio
        import io
        import soundfile as sf
        speaker_id = melotts_speaker_ids["ZH"]
        loop = asyncio.get_event_loop()
        # output_path=None → 回傳 numpy array，不寫檔
        audio_np = await loop.run_in_executor(
            None, lambda: melotts_model.tts_to_file(
                request.text, speaker_id, output_path=None, speed=1.0, quiet=True
            )
        )
        # numpy → WAV bytes（記憶體內）
        buf = io.BytesIO()
        sf.write(buf, audio_np, melotts_model.hps.data.sampling_rate, format="WAV")
        buf.seek(0)
        return StreamingResponse(buf, media_type="audio/wav")
    except Exception as e:
        logger.error(f"MeloTTS 合成失敗: {e}")
        raise HTTPException(500, f"MeloTTS 合成失敗: {str(e)}")


# ============== 語音識別 STT ==============

@app.post("/api/v1/stt/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    """上傳音訊檔案（WAV/WebM）→ 文字轉錄"""
    if whisper_model is None:
        raise HTTPException(503, "Whisper 模型未載入")

    # 驗證檔案格式
    allowed_types = {"audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg"}
    allowed_extensions = {".wav", ".webm", ".ogg"}
    filename = audio.filename or ""
    ext = Path(filename).suffix.lower()

    if audio.content_type not in allowed_types and ext not in allowed_extensions:
        raise HTTPException(
            400,
            f"不支援的音訊格式。支援 WAV/WebM，收到: {audio.content_type} ({ext})",
        )

    # 儲存到臨時檔案（faster-whisper 需要檔案路徑或 numpy array）
    req_id = str(uuid.uuid4())
    suffix = ext if ext else ".wav"
    tmp_path = UPLOAD_DIR / f"stt_{req_id}{suffix}"

    try:
        content = await audio.read()
        with open(tmp_path, "wb") as f:
            f.write(content)

        start_t = time.time()
        segments, info = whisper_model.transcribe(
            str(tmp_path),
            beam_size=5,
            vad_filter=True,
        )

        # 合併所有 segment 文字
        full_text = "".join(seg.text for seg in segments).strip()
        elapsed = time.time() - start_t

        logger.info(
            f"STT 完成: lang={info.language} prob={info.language_probability:.2f} "
            f"duration={info.duration:.1f}s elapsed={elapsed:.2f}s"
        )

        return {
            "data": {
                "text": full_text,
                "language": info.language,
                "language_probability": round(info.language_probability, 3),
                "duration": round(info.duration, 2),
                "processing_time": round(elapsed, 3),
            },
            "error": None,
        }
    except Exception as e:
        logger.error(f"STT 轉錄失敗: {e}")
        raise HTTPException(500, f"語音轉錄失敗: {str(e)}")
    finally:
        # 清理臨時檔案
        if tmp_path.exists():
            tmp_path.unlink()


@app.post("/api/v1/stt/stream")
async def transcribe_stream(request: Request):
    """接收原始 PCM 音訊串流（16kHz, 16-bit, mono）→ 即時文字轉錄

    桌面應用程式可以直接將麥克風 PCM 資料 POST 到此端點。
    Content-Type 應為 application/octet-stream。
    """
    if whisper_model is None:
        raise HTTPException(503, "Whisper 模型未載入")

    try:
        # 讀取整個 request body（原始 PCM bytes）
        pcm_bytes = await request.body()
        if len(pcm_bytes) == 0:
            raise HTTPException(400, "空的音訊資料")

        # 將 PCM bytes 轉為 numpy float32 array（faster-whisper 接受 numpy array）
        # 格式：16kHz, 16-bit signed little-endian, mono
        audio_array = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        start_t = time.time()
        segments, info = whisper_model.transcribe(
            audio_array,
            beam_size=5,
            vad_filter=True,
        )

        full_text = "".join(seg.text for seg in segments).strip()
        elapsed = time.time() - start_t

        logger.info(
            f"STT 串流完成: lang={info.language} prob={info.language_probability:.2f} "
            f"samples={len(audio_array)} elapsed={elapsed:.2f}s"
        )

        return {
            "data": {
                "text": full_text,
                "language": info.language,
                "language_probability": round(info.language_probability, 3),
                "duration": round(len(audio_array) / 16000, 2),
                "processing_time": round(elapsed, 3),
            },
            "error": None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"STT 串流轉錄失敗: {e}")
        raise HTTPException(500, f"語音串流轉錄失敗: {str(e)}")


# ============== 臉部動畫 ==============

@app.post("/api/v1/avatar/generate-frame")
async def generate_avatar_frame(
    face_image: UploadFile = File(...),
    audio: UploadFile = File(...),
):
    """臉部照片 + 語音 → 說話影片"""
    if wav2lip_model is None:
        raise HTTPException(503, "Wav2Lip 模型未載入")

    # 儲存輸入檔案
    req_id = str(uuid.uuid4())
    face_path = UPLOAD_DIR / f"face_{req_id}.jpg"
    audio_path = UPLOAD_DIR / f"audio_{req_id}.wav"
    output_path = OUTPUT_DIR / f"video_{req_id}.mp4"

    with open(face_path, "wb") as f:
        f.write(await face_image.read())
    with open(audio_path, "wb") as f:
        f.write(await audio.read())

    try:
        wav2lip_model.generate_video(str(face_path), str(audio_path), str(output_path))
        return FileResponse(str(output_path), media_type="video/mp4")
    except Exception as e:
        raise HTTPException(500, f"影片生成失敗: {str(e)}")


@app.post("/api/v1/avatar/generate-stream")
async def generate_avatar_stream(
    face_image: UploadFile = File(...),
    audio: UploadFile = File(...),
):
    """臉部照片 + 語音 → 影片幀串流"""
    if wav2lip_model is None:
        raise HTTPException(503, "Wav2Lip 模型未載入")

    req_id = str(uuid.uuid4())
    face_path = UPLOAD_DIR / f"face_{req_id}.jpg"
    audio_path = UPLOAD_DIR / f"audio_{req_id}.wav"

    with open(face_path, "wb") as f:
        f.write(await face_image.read())
    with open(audio_path, "wb") as f:
        f.write(await audio.read())

    async def generate():
        try:
            for frame_data in wav2lip_model.generate_frames_stream(str(face_path), str(audio_path)):
                yield frame_data
        except Exception as e:
            logger.error(f"串流生成失敗: {e}")

    return StreamingResponse(generate(), media_type="application/octet-stream")


# ============== Mode 3: 合併 TTS + 臉部動畫 ==============

from typing import Optional

class TalkingAvatarRequest(BaseModel):
    text: str
    voice_id: str = "default"
    voice_gender: str = "female"  # "male" 或 "female"，僅 voice_id="default" 時使用
    face_image_url: str = "default"  # "default" 或圖片 URL
    face_image_base64: Optional[str] = None  # 即時 webcam 截圖（base64 JPEG）


@app.post("/api/v1/avatar/generate-talking")
async def generate_talking_avatar(request: TalkingAvatarRequest):
    """Mode 3: 文字 → TTS 語音 → Wav2Lip 臉部動畫影片"""
    if cosyvoice_model is None:
        raise HTTPException(503, "CosyVoice 模型未載入")

    req_id = str(uuid.uuid4())

    # Step 1: TTS 語音合成
    audio_filename = f"tts_{req_id}.wav"
    audio_path = OUTPUT_DIR / audio_filename
    try:
        if request.voice_id == "default":
            cosyvoice_model.synthesize_default(request.text, str(audio_path), voice_gender=request.voice_gender)
        else:
            cosyvoice_model.synthesize(request.text, request.voice_id, str(audio_path))
        logger.info(f"TTS 完成: {audio_filename}")
    except Exception as e:
        raise HTTPException(500, f"語音合成失敗: {str(e)}")

    # Step 2: 取得臉部圖片
    has_face = False
    face_path = UPLOAD_DIR / f"face_{req_id}.jpg"

    if request.face_image_base64:
        # 從 base64 解碼即時 webcam 截圖
        try:
            img_data = base64.b64decode(request.face_image_base64)
            with open(face_path, "wb") as f:
                f.write(img_data)
            has_face = True
            logger.info(f"Webcam 截圖已儲存: {face_path}")
        except Exception as e:
            logger.warning(f"解碼 webcam base64 失敗: {e}")
    elif request.face_image_url == "default":
        # 檢查是否有預設臉部圖片
        default_face = MODEL_DIR / "default_face.jpg"
        if default_face.exists():
            face_path = default_face
            has_face = True
        else:
            logger.info("無預設臉部圖片，跳過 Wav2Lip，僅回傳音訊")
    else:
        # 從 URL 下載臉部圖片
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(request.face_image_url)
                resp.raise_for_status()
                with open(face_path, "wb") as f:
                    f.write(resp.content)
            has_face = True
            logger.info(f"臉部圖片已下載: {face_path}")
        except Exception as e:
            logger.warning(f"下載臉部圖片失敗: {e}，僅回傳音訊")

    # Step 3: Wav2Lip 臉部動畫（如果有臉部圖片且模型已載入）
    video_filename = None
    if has_face and wav2lip_model is not None:
        video_filename = f"video_{req_id}.mp4"
        video_path = OUTPUT_DIR / video_filename
        try:
            wav2lip_model.generate_video(str(face_path), str(audio_path), str(video_path))
            logger.info(f"Wav2Lip 影片完成: {video_filename}")
        except Exception as e:
            logger.error(f"Wav2Lip 失敗: {e}")
            video_filename = None

    result = {"audio_url": f"/outputs/{audio_filename}"}
    if video_filename:
        result["video_url"] = f"/outputs/{video_filename}"

    return {"data": result, "error": None}


# ============== 從既有音訊生成臉部動畫（跳過 TTS） ==============

class AnimateFromAudioRequest(BaseModel):
    audio_url: str  # 音訊檔案相對路徑，例如 "/outputs/xxx.wav"
    face_image_base64: Optional[str] = None  # 即時 webcam 截圖（base64 JPEG）
    face_image_url: str = "default"  # "default" 或圖片 URL


@app.post("/api/v1/avatar/animate-from-audio")
async def animate_from_audio(request: AnimateFromAudioRequest):
    """從既有音訊檔案 + 臉部圖片生成 Wav2Lip 影片（不做 TTS）
    適用於 Edge TTS 已產生音訊，只需臉部動畫的場景
    """
    if wav2lip_model is None:
        raise HTTPException(503, "Wav2Lip 模型未載入")

    req_id = str(uuid.uuid4())

    # Step 1: 解析音訊檔案路徑（去掉 /outputs/ 前綴）
    audio_relative = request.audio_url.lstrip("/")
    if audio_relative.startswith("outputs/"):
        audio_relative = audio_relative[len("outputs/"):]
    audio_path = OUTPUT_DIR / audio_relative

    if not audio_path.exists():
        raise HTTPException(404, f"音訊檔案不存在: {request.audio_url}")

    # Step 2: 取得臉部圖片（與 generate_talking_avatar 相同邏輯）
    face_path = UPLOAD_DIR / f"face_{req_id}.jpg"

    if request.face_image_base64:
        # 從 base64 解碼即時 webcam 截圖
        try:
            img_data = base64.b64decode(request.face_image_base64)
            with open(face_path, "wb") as f:
                f.write(img_data)
            logger.info(f"Webcam 截圖已儲存: {face_path}")
        except Exception as e:
            raise HTTPException(400, f"解碼 webcam base64 失敗: {str(e)}")
    elif request.face_image_url == "default":
        # 使用預設臉部圖片
        default_face = MODEL_DIR / "default_face.jpg"
        if default_face.exists():
            face_path = default_face
        else:
            raise HTTPException(400, "無預設臉部圖片，請提供 face_image_base64 或 face_image_url")
    else:
        # 從 URL 下載臉部圖片
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(request.face_image_url)
                resp.raise_for_status()
                with open(face_path, "wb") as f:
                    f.write(resp.content)
            logger.info(f"臉部圖片已下載: {face_path}")
        except Exception as e:
            raise HTTPException(500, f"下載臉部圖片失敗: {str(e)}")

    # Step 3: Wav2Lip 臉部動畫
    video_filename = f"video_{req_id}.mp4"
    video_path = OUTPUT_DIR / video_filename
    try:
        wav2lip_model.generate_video(str(face_path), str(audio_path), str(video_path))
        logger.info(f"Wav2Lip 影片完成（從既有音訊）: {video_filename}")
    except Exception as e:
        logger.error(f"Wav2Lip 失敗: {e}")
        raise HTTPException(500, f"臉部動畫生成失敗: {str(e)}")

    return {"data": {"video_url": f"/outputs/{video_filename}"}, "error": None}


# ============== 快速 TTS（Edge TTS） ==============

class FastTTSRequest(BaseModel):
    text: str
    voice_gender: str = "female"  # "male" 或 "female"


@app.post("/api/v1/tts/fast-synthesize")
async def fast_synthesize_speech(request: FastTTSRequest):
    """快速語音合成（Edge TTS，<1 秒），適合不需要聲音克隆的場景"""
    try:
        from edge_tts_handler import fast_synthesize
        output_path = await fast_synthesize(request.text, request.voice_gender)
        filename = Path(output_path).name
        return {"data": {"audio_url": f"/outputs/{filename}"}, "error": None}
    except ImportError:
        raise HTTPException(503, "Edge TTS 未安裝（pip install edge-tts）")
    except Exception as e:
        logger.error(f"Edge TTS 失敗: {e}")
        raise HTTPException(500, f"快速語音合成失敗: {str(e)}")


# ============== 音訊合併（句子級 Pipeline 用） ==============

class ConcatenateRequest(BaseModel):
    audio_urls: list[str]  # 相對路徑列表，例如 ["/outputs/xxx.wav", "/outputs/yyy.wav"]


@app.post("/api/v1/tts/concatenate")
async def concatenate_audio(request: ConcatenateRequest):
    """合併多段音訊為一個檔案（支援句子級 TTS Pipeline）"""
    if len(request.audio_urls) == 0:
        raise HTTPException(400, "至少需要一段音訊")

    if len(request.audio_urls) == 1:
        # 只有一段，直接回傳
        return {"data": {"audio_url": request.audio_urls[0]}, "error": None}

    try:
        from pydub import AudioSegment

        combined = AudioSegment.empty()
        for url in request.audio_urls:
            relative = url.lstrip("/")
            if relative.startswith("outputs/"):
                relative = relative[len("outputs/"):]
            path = OUTPUT_DIR / relative
            if not path.exists():
                logger.warning(f"合併音訊：檔案不存在 {path}，跳過")
                continue
            combined += AudioSegment.from_wav(str(path))

        if len(combined) == 0:
            raise HTTPException(400, "沒有有效的音訊檔案可合併")

        filename = f"concat_{uuid.uuid4()}.wav"
        output_path = OUTPUT_DIR / filename
        # 統一格式：16kHz mono 16-bit（與 TTS 輸出一致）
        combined = combined.set_frame_rate(16000).set_channels(1).set_sample_width(2)
        combined.export(str(output_path), format="wav")

        logger.info(f"音訊合併完成: {len(request.audio_urls)} 段 → {filename} ({len(combined)}ms)")
        return {"data": {"audio_url": f"/outputs/{filename}"}, "error": None}
    except ImportError:
        raise HTTPException(503, "pydub 未安裝（pip install pydub）")
    except Exception as e:
        logger.error(f"音訊合併失敗: {e}")
        raise HTTPException(500, f"音訊合併失敗: {str(e)}")


# ============== MuseTalk 即時唇形動畫 ==============

class PrepareFaceRequest(BaseModel):
    face_id: str  # Session ID 或自訂 ID
    face_image_base64: str  # base64 JPEG


@app.post("/api/v1/avatar/prepare-face")
async def prepare_face(request: PrepareFaceRequest):
    """預處理臉部特徵（Session 開始時呼叫一次）
    回傳 face_id + bbox，後續用 face_id 進行即時唇形動畫
    """
    if musetalk_model is None:
        raise HTTPException(503, "MuseTalk 模型未載入")

    try:
        img_data = base64.b64decode(request.face_image_base64)
        result = musetalk_model.prepare_face(request.face_id, img_data)
        return {"data": result, "error": None}
    except Exception as e:
        logger.error(f"臉部預處理失敗: {e}")
        raise HTTPException(500, f"臉部預處理失敗: {str(e)}")


class StreamLipsyncRequest(BaseModel):
    face_id: str
    audio_url: Optional[str] = None  # 音訊檔案相對路徑（二擇一）
    audio_base64: Optional[str] = None  # base64 WAV/PCM 音訊（二擇一）
    sample_rate: int = 16000  # PCM 取樣率


@app.post("/api/v1/avatar/stream-lipsync")
async def stream_lipsync(request: StreamLipsyncRequest):
    """MuseTalk 唇形動畫 — 回傳 MJPEG 串流
    接受 audio_url 或 audio_base64，生成所有唇形幀（~38ms/frame）
    """
    if musetalk_model is None:
        raise HTTPException(503, "MuseTalk 模型未載入")

    # 取得音訊 bytes
    if request.audio_base64:
        audio_bytes = base64.b64decode(request.audio_base64)
    elif request.audio_url:
        audio_relative = request.audio_url.lstrip("/")
        if audio_relative.startswith("outputs/"):
            audio_relative = audio_relative[len("outputs/"):]
        audio_path = OUTPUT_DIR / audio_relative
        if not audio_path.exists():
            raise HTTPException(404, f"音訊檔案不存在: {request.audio_url}")
        with open(audio_path, "rb") as f:
            audio_bytes = f.read()
    else:
        raise HTTPException(400, "需提供 audio_url 或 audio_base64")

    # 確認 face_id 已預處理
    if request.face_id not in musetalk_model.face_cache:
        raise HTTPException(400, f"face_id '{request.face_id}' 未預處理，請先呼叫 /api/v1/avatar/prepare-face")

    try:
        import asyncio
        loop = asyncio.get_event_loop()
        # MuseTalk 生成所有幀（GPU 推論，在 executor 中執行避免阻塞）
        frames = await loop.run_in_executor(
            None,
            lambda: musetalk_model.generate_frames_from_audio(
                request.face_id, audio_bytes, request.sample_rate
            )
        )

        async def generate():
            for jpeg_frame in frames:
                # MJPEG 格式：每幀以 boundary 分隔
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + jpeg_frame + b"\r\n"
                )

        return StreamingResponse(
            generate(),
            media_type="multipart/x-mixed-replace; boundary=frame",
            headers={"X-Frame-Count": str(len(frames))},
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error(f"MuseTalk 唇形動畫失敗: {e}")
        raise HTTPException(500, f"唇形動畫失敗: {str(e)}")


class MuseTalkLipsyncRequest(BaseModel):
    """MuseTalk 唇形動畫（JSON frames 回傳，適合 WebSocket 整合）"""
    face_id: str
    audio_base64: str  # base64 WAV 音訊
    sample_rate: int = 16000


@app.post("/api/v1/avatar/musetalk-lipsync")
async def musetalk_lipsync(request: MuseTalkLipsyncRequest):
    """MuseTalk 唇形動畫 — 回傳 base64 JPEG frames 陣列
    適合 Gateway WebSocket 整合：一次拿到所有幀，逐幀推送給 client
    """
    if musetalk_model is None:
        raise HTTPException(503, "MuseTalk 模型未載入")

    if request.face_id not in musetalk_model.face_cache:
        raise HTTPException(400, f"face_id '{request.face_id}' 未預處理")

    try:
        import asyncio
        audio_bytes = base64.b64decode(request.audio_base64)
        loop = asyncio.get_event_loop()
        frames = await loop.run_in_executor(
            None,
            lambda: musetalk_model.generate_frames_from_audio(
                request.face_id, audio_bytes, request.sample_rate
            )
        )

        # 將 JPEG frames 轉為 base64
        frames_b64 = [base64.b64encode(f).decode() for f in frames]

        return {
            "data": {
                "frame_count": len(frames_b64),
                "frames": frames_b64,
                "fps": 25,
            },
            "error": None,
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.error(f"MuseTalk 唇形動畫失敗: {e}")
        raise HTTPException(500, f"唇形動畫失敗: {str(e)}")


@app.delete("/api/v1/avatar/face/{face_id}")
async def remove_face(face_id: str):
    """移除臉部快取"""
    if musetalk_model is None:
        raise HTTPException(503, "MuseTalk 模型未載入")
    musetalk_model.remove_face(face_id)
    return {"data": {"removed": face_id}, "error": None}


# ============== 模型管理 ==============

@app.get("/api/v1/models/status")
async def models_status():
    """查詢所有模型狀態（含 MuseTalk）"""
    gpu_mem = None
    if torch.cuda.is_available():
        gpu_mem = {
            "total_gb": round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1),
            "allocated_gb": round(torch.cuda.memory_allocated(0) / 1e9, 1),
            "cached_gb": round(torch.cuda.memory_reserved(0) / 1e9, 1),
        }

    return {
        "data": {
            "cosyvoice": {"loaded": cosyvoice_model is not None},
            "wav2lip": {"loaded": wav2lip_model is not None},
            "musetalk": {"loaded": musetalk_model is not None},
            "whisper": {
                "loaded": whisper_model is not None,
                "model_size": WHISPER_MODEL_SIZE if whisper_model is not None else None,
            },
            "gpu_memory": gpu_mem,
        },
        "error": None,
    }


# ============== 靜態檔案（提供音訊/影片下載） ==============
app.mount("/outputs", StaticFiles(directory=str(OUTPUT_DIR)), name="outputs")
