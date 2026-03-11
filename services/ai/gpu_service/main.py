"""GPU AI Service — 語音克隆 + 臉部動畫
在 RunPod GPU 伺服器上運行
"""

import os
import time
import uuid
import logging
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
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

# 全域模型變數
cosyvoice_model = None
wav2lip_model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """啟動時載入模型"""
    global cosyvoice_model, wav2lip_model

    logger.info(f"GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'}")
    logger.info(f"VRAM: {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB" if torch.cuda.is_available() else "No GPU")

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
        "gpu_memory_gb": round(torch.cuda.get_device_properties(0).total_mem / 1e9, 1) if torch.cuda.is_available() else 0,
        "cosyvoice_loaded": cosyvoice_model is not None,
        "wav2lip_loaded": wav2lip_model is not None,
    }


# ============== 語音克隆 TTS ==============

class TTSRequest(BaseModel):
    text: str
    voice_id: str  # 用戶的聲音模型 ID


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
    """文字 → 語音（使用克隆的聲音）"""
    if cosyvoice_model is None:
        raise HTTPException(503, "CosyVoice 模型未載入")

    try:
        output_path = OUTPUT_DIR / f"tts_{uuid.uuid4()}.wav"
        cosyvoice_model.synthesize(request.text, request.voice_id, str(output_path))
        return FileResponse(str(output_path), media_type="audio/wav")
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


# ============== 模型管理 ==============

@app.get("/api/v1/models/status")
async def models_status():
    """查詢所有模型狀態"""
    gpu_mem = None
    if torch.cuda.is_available():
        gpu_mem = {
            "total_gb": round(torch.cuda.get_device_properties(0).total_mem / 1e9, 1),
            "allocated_gb": round(torch.cuda.memory_allocated(0) / 1e9, 1),
            "cached_gb": round(torch.cuda.memory_reserved(0) / 1e9, 1),
        }

    return {
        "data": {
            "cosyvoice": {"loaded": cosyvoice_model is not None},
            "wav2lip": {"loaded": wav2lip_model is not None},
            "gpu_memory": gpu_mem,
        },
        "error": None,
    }
