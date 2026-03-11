from fastapi import FastAPI, UploadFile, File
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


@app.on_event("startup")
def load_model():
    global whisper_model
    from faster_whisper import WhisperModel
    logger.info("Loading Whisper large-v3...")
    whisper_model = WhisperModel("large-v3", device="cuda", compute_type="float16")
    logger.info("Whisper model loaded")


@app.get("/health")
def health():
    return {"status": "ok", "whisper_loaded": whisper_model is not None}


@app.post("/api/v1/stt/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    if not whisper_model:
        return {"data": {"text": ""}, "error": "model not loaded"}
    suffix = os.path.splitext(audio.filename or ".wav")[1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name
    try:
        segments, info = whisper_model.transcribe(tmp_path)
        text = " ".join(seg.text for seg in segments).strip()
        return {"data": {"text": text, "language": info.language}}
    finally:
        os.unlink(tmp_path)
