from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
import tempfile, os, logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("stt")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

whisper_model = None


def load():
    """載入 Whisper 模型（combined.py 呼叫）"""
    global whisper_model
    from faster_whisper import WhisperModel
    model_size = os.environ.get("WHISPER_MODEL_SIZE", "large-v3")
    compute = "int8_float16" if model_size == "large-v3" else "float16"
    logger.info(f"Loading Whisper {model_size} (compute={compute})...")
    whisper_model = WhisperModel(model_size, device="cuda", compute_type=compute)
    logger.info(f"Whisper {model_size} loaded")


@app.on_event("startup")
def load_model():
    load()


@app.get("/health")
def health():
    return {"status": "ok", "whisper_loaded": whisper_model is not None}


@app.post("/api/v1/stt/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: str = Form("zh"),
    initial_prompt: str = Form(""),
):
    """語音轉文字 — 預設中文，支援 initial_prompt 引導辨識"""
    if not whisper_model:
        return {"data": {"text": ""}, "error": "model not loaded"}
    suffix = os.path.splitext(audio.filename or ".wav")[1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name
    try:
        # 指定語言避免自動偵測把中文辨識成英文/日文
        # initial_prompt 引導 Whisper 辨識常見會議用語，提升準確度
        segments, info = whisper_model.transcribe(
            tmp_path,
            language=language,
            initial_prompt=initial_prompt if initial_prompt else None,
        )
        text = " ".join(seg.text for seg in segments).strip()
        return {"data": {"text": text, "language": info.language}}
    finally:
        os.unlink(tmp_path)
