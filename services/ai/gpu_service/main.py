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
cosyvoice_model = None
wav2lip_model = None
whisper_model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """啟動時載入模型"""
    global cosyvoice_model, wav2lip_model, whisper_model

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

    # 載入 Whisper STT 模型（faster-whisper）
    try:
        from faster_whisper import WhisperModel
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        whisper_model = WhisperModel(
            WHISPER_MODEL_SIZE,
            device=device,
            compute_type=compute_type,
            download_root=str(MODEL_DIR / "whisper"),
        )
        logger.info(f"Whisper ({WHISPER_MODEL_SIZE}) 模型載入完成 (device={device}, compute={compute_type})")
    except Exception as e:
        logger.warning(f"Whisper 載入失敗（可能尚未安裝 faster-whisper）: {e}")

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
        "whisper_loaded": whisper_model is not None,
        "whisper_model_size": WHISPER_MODEL_SIZE if whisper_model is not None else None,
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
    """文字 → 語音（使用克隆的聲音或預設聲音），回傳可下載的音訊 URL"""
    if cosyvoice_model is None:
        raise HTTPException(503, "CosyVoice 模型未載入")

    try:
        filename = f"tts_{uuid.uuid4()}.wav"
        output_path = OUTPUT_DIR / filename
        if request.voice_id == "default":
            cosyvoice_model.synthesize_default(request.text, str(output_path), voice_gender=request.voice_gender)
        else:
            cosyvoice_model.synthesize(request.text, request.voice_id, str(output_path))
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


# ============== 模型管理 ==============

@app.get("/api/v1/models/status")
async def models_status():
    """查詢所有模型狀態"""
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
