"""TTS 服務 — 語音合成（Phase 2）"""

from fastapi import FastAPI

app = FastAPI(title="AI Avatar TTS Service", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "tts-service"}


# TODO: Phase 2 實作 CosyVoice 語音克隆
