"""Avatar 服務 — 臉部動畫（Phase 2）"""

from fastapi import FastAPI

app = FastAPI(title="AI Avatar Service", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "avatar-service"}


# TODO: Phase 2 實作 Wav2Lip / LivePortrait
