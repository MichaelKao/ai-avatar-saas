"""LLM 服務 — 處理 AI 對話生成"""

import logging
import os
import time
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from .claude_handler import ClaudeHandler
from .gpt_handler import GPTHandler

load_dotenv()

# 設定日誌
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("llm_service")

# 可用模型清單
AVAILABLE_MODELS = [
    {
        "id": "claude-sonnet-4-20250514",
        "name": "Claude Sonnet 4",
        "provider": "anthropic",
        "description": "Anthropic 高效能模型，適合多數對話場景",
    },
    {
        "id": "claude-3-5-haiku-20241022",
        "name": "Claude 3.5 Haiku",
        "provider": "anthropic",
        "description": "Anthropic 快速模型，適合簡短回應",
    },
    {
        "id": "gpt-4o",
        "name": "GPT-4o",
        "provider": "openai",
        "description": "OpenAI 多模態模型",
    },
    {
        "id": "gpt-4o-mini",
        "name": "GPT-4o Mini",
        "provider": "openai",
        "description": "OpenAI 輕量模型，速度快、成本低",
    },
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """服務啟動/關閉生命週期"""
    logger.info("LLM Service 啟動")
    yield
    logger.info("LLM Service 關閉")


app = FastAPI(
    title="AI Avatar LLM Service",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS 中間件（開發環境允許所有來源）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    """對話請求"""
    model: str = "claude-sonnet-4-20250514"
    system_prompt: str = "你是一位專業的商業顧問，回答簡潔有力，使用繁體中文。"
    messages: list[dict]
    temperature: float = 0.7
    language: str = "zh-TW"
    stream: bool = True


class ChatResponse(BaseModel):
    """對話回應"""
    text: str
    model: str
    usage: dict | None = None


class ErrorResponse(BaseModel):
    """錯誤回應"""
    data: None = None
    error: str


# 初始化 handlers
claude_handler = ClaudeHandler()
gpt_handler = GPTHandler()


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    """請求日誌中間件 — 記錄每個請求的方法、路徑和耗時"""
    start_time = time.time()
    logger.info("收到請求: %s %s", request.method, request.url.path)

    response = await call_next(request)

    duration_ms = (time.time() - start_time) * 1000
    logger.info(
        "回應完成: %s %s → %d (%.1fms)",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    return response


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """統一 HTTP 錯誤回應格式"""
    return JSONResponse(
        status_code=exc.status_code,
        content={"data": None, "error": exc.detail},
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """統一未知錯誤回應格式"""
    logger.error("未預期的錯誤: %s %s → %s", request.method, request.url.path, str(exc))
    return JSONResponse(
        status_code=500,
        content={"data": None, "error": "伺服器內部錯誤"},
    )


@app.get("/health")
async def health():
    """健康檢查"""
    return {"status": "ok", "service": "llm-service"}


@app.get("/models")
async def list_models():
    """回傳可用模型清單"""
    return {
        "data": AVAILABLE_MODELS,
        "error": None,
    }


@app.post("/chat")
async def chat(request: ChatRequest):
    """處理對話請求（非串流）"""
    handler = _get_handler(request.model)

    try:
        result = await handler.chat(
            model=request.model,
            system_prompt=request.system_prompt,
            messages=request.messages,
            temperature=request.temperature,
        )
        return {"data": result, "error": None}
    except RuntimeError as e:
        logger.warning("對話請求失敗（設定問題）: %s", str(e))
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.error("對話請求失敗: %s", str(e))
        raise HTTPException(status_code=500, detail=f"對話生成失敗: {str(e)}")


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """處理對話請求（串流）"""
    handler = _get_handler(request.model)

    return StreamingResponse(
        handler.chat_stream(
            model=request.model,
            system_prompt=request.system_prompt,
            messages=request.messages,
            temperature=request.temperature,
        ),
        media_type="text/event-stream",
    )


def _get_handler(model: str):
    """根據模型名稱取得對應的 handler"""
    if model.startswith("claude"):
        return claude_handler
    elif model.startswith("gpt"):
        return gpt_handler
    else:
        raise HTTPException(status_code=400, detail=f"不支援的模型: {model}")
