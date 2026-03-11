"""LLM Service 綜合測試"""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from services.ai.llm_service.sentence_splitter import split_sentences


# ─── 句子分割測試 ───────────────────────────────────────────────────

class TestSentenceSplitter:
    """測試 split_sentences 各種情境"""

    def test_chinese_period(self):
        """中文句號分割"""
        result = split_sentences("這是第一句。這是第二句。")
        assert result == ["這是第一句。", "這是第二句。"]

    def test_chinese_mixed_punctuation(self):
        """中文混合標點分割"""
        result = split_sentences("你好嗎？我很好！謝謝。")
        assert result == ["你好嗎？", "我很好！", "謝謝。"]

    def test_english_sentences(self):
        """英文句子分割"""
        result = split_sentences("Hello world. How are you? I am fine!")
        assert result == ["Hello world.", "How are you?", "I am fine!"]

    def test_mixed_chinese_english(self):
        """中英混合分割"""
        result = split_sentences("你好。Hello! 再見。")
        assert result == ["你好。", "Hello!", "再見。"]

    def test_empty_string(self):
        """空字串回傳空列表"""
        assert split_sentences("") == []

    def test_whitespace_only(self):
        """純空白回傳空列表"""
        assert split_sentences("   ") == []

    def test_no_punctuation(self):
        """無標點的文本回傳整段"""
        result = split_sentences("這是沒有標點的文字")
        assert result == ["這是沒有標點的文字"]

    def test_abbreviations(self):
        """英文縮寫不應被分割"""
        result = split_sentences("Dr. Smith went to the store. He bought milk.")
        assert len(result) == 2
        assert "Dr." in result[0]

    def test_decimal_numbers(self):
        """小數點不應被分割"""
        result = split_sentences("The price is 3.14 dollars. That is cheap.")
        assert len(result) == 2
        assert "3.14" in result[0]

    def test_ellipsis(self):
        """省略號處理"""
        result = split_sentences("Well... I think so.")
        assert len(result) >= 1

    def test_multiple_punctuation(self):
        """連續標點不產生空句子"""
        result = split_sentences("真的嗎？！是的。")
        # 不應有空字串
        for s in result:
            assert s.strip() != ""

    def test_trailing_text(self):
        """結尾無標點的文字應被保留"""
        result = split_sentences("第一句。尚未結束")
        assert len(result) == 2
        assert result[0] == "第一句。"
        assert result[1] == "尚未結束"

    def test_chinese_question_mark(self):
        """中文問號分割"""
        result = split_sentences("你是誰？我是AI。")
        assert result == ["你是誰？", "我是AI。"]

    def test_single_sentence_with_period(self):
        """只有一句帶句號"""
        result = split_sentences("只有一句。")
        assert result == ["只有一句。"]

    def test_quoted_text(self):
        """引號內的標點"""
        result = split_sentences("他說「你好嗎？」然後離開了。")
        # 引號應被吸收到句子裡
        assert len(result) >= 1

    def test_mr_mrs_abbreviations(self):
        """Mr. Mrs. 縮寫不應分割"""
        result = split_sentences("Mr. and Mrs. Chen are here. They arrived today.")
        assert len(result) == 2


# ─── Health Endpoint 測試 ───────────────────────────────────────────

class TestHealthEndpoint:
    """測試 /health 端點"""

    @pytest.fixture
    def client(self):
        """建立測試用 FastAPI client"""
        # 避免 handler 初始化問題，mock 掉 handlers
        with patch("services.ai.llm_service.main.claude_handler"), \
             patch("services.ai.llm_service.main.gpt_handler"):
            from services.ai.llm_service.main import app
            with TestClient(app) as c:
                yield c

    def test_health_returns_200(self, client):
        """GET /health 回傳 200"""
        response = client.get("/health")
        assert response.status_code == 200

    def test_health_response_body(self, client):
        """GET /health 回傳正確的 JSON"""
        response = client.get("/health")
        body = response.json()
        assert body["status"] == "ok"
        assert body["service"] == "llm-service"


# ─── Models Endpoint 測試 ──────────────────────────────────────────

class TestModelsEndpoint:
    """測試 /models 端點"""

    @pytest.fixture
    def client(self):
        with patch("services.ai.llm_service.main.claude_handler"), \
             patch("services.ai.llm_service.main.gpt_handler"):
            from services.ai.llm_service.main import app
            with TestClient(app) as c:
                yield c

    def test_models_returns_200(self, client):
        """GET /models 回傳 200"""
        response = client.get("/models")
        assert response.status_code == 200

    def test_models_response_structure(self, client):
        """GET /models 回傳正確結構"""
        response = client.get("/models")
        body = response.json()
        assert "data" in body
        assert "error" in body
        assert body["error"] is None
        assert isinstance(body["data"], list)
        assert len(body["data"]) > 0

    def test_models_contain_claude(self, client):
        """模型清單包含 Claude 模型"""
        response = client.get("/models")
        models = response.json()["data"]
        claude_models = [m for m in models if m["provider"] == "anthropic"]
        assert len(claude_models) > 0

    def test_models_contain_gpt(self, client):
        """模型清單包含 GPT 模型"""
        response = client.get("/models")
        models = response.json()["data"]
        gpt_models = [m for m in models if m["provider"] == "openai"]
        assert len(gpt_models) > 0

    def test_model_fields(self, client):
        """每個模型都有必要欄位"""
        response = client.get("/models")
        models = response.json()["data"]
        for model in models:
            assert "id" in model
            assert "name" in model
            assert "provider" in model
            assert "description" in model


# ─── Chat Endpoint 測試 ────────────────────────────────────────────

class TestChatEndpoint:
    """測試 /chat 端點（使用 mock Claude client）"""

    @pytest.fixture
    def client(self):
        """建立帶 mock handler 的測試 client"""
        mock_claude = MagicMock()
        mock_claude.chat = AsyncMock(return_value={
            "text": "你好，我是AI助理。",
            "model": "claude-sonnet-4-20250514",
            "usage": {"input_tokens": 10, "output_tokens": 20},
        })

        with patch("services.ai.llm_service.main.claude_handler", mock_claude), \
             patch("services.ai.llm_service.main.gpt_handler"):
            from services.ai.llm_service.main import app
            with TestClient(app) as c:
                yield c, mock_claude

    def test_chat_returns_200(self, client):
        """POST /chat 成功回傳 200"""
        c, _ = client
        response = c.post("/chat", json={
            "model": "claude-sonnet-4-20250514",
            "messages": [{"role": "user", "content": "你好"}],
        })
        assert response.status_code == 200

    def test_chat_response_structure(self, client):
        """POST /chat 回傳正確結構"""
        c, _ = client
        response = c.post("/chat", json={
            "model": "claude-sonnet-4-20250514",
            "messages": [{"role": "user", "content": "你好"}],
        })
        body = response.json()
        assert "data" in body
        assert "error" in body
        assert body["error"] is None
        assert body["data"]["text"] == "你好，我是AI助理。"
        assert body["data"]["model"] == "claude-sonnet-4-20250514"

    def test_chat_includes_usage(self, client):
        """POST /chat 回傳 token 使用量"""
        c, _ = client
        response = c.post("/chat", json={
            "model": "claude-sonnet-4-20250514",
            "messages": [{"role": "user", "content": "你好"}],
        })
        usage = response.json()["data"]["usage"]
        assert usage["input_tokens"] == 10
        assert usage["output_tokens"] == 20

    def test_chat_calls_handler(self, client):
        """POST /chat 正確呼叫 handler"""
        c, mock_claude = client
        c.post("/chat", json={
            "model": "claude-sonnet-4-20250514",
            "system_prompt": "你是助理",
            "messages": [{"role": "user", "content": "測試"}],
            "temperature": 0.5,
        })
        mock_claude.chat.assert_called_once_with(
            model="claude-sonnet-4-20250514",
            system_prompt="你是助理",
            messages=[{"role": "user", "content": "測試"}],
            temperature=0.5,
        )

    def test_chat_unsupported_model(self, client):
        """POST /chat 不支援的模型回傳 400"""
        c, _ = client
        response = c.post("/chat", json={
            "model": "unknown-model",
            "messages": [{"role": "user", "content": "你好"}],
        })
        assert response.status_code == 400

    def test_chat_missing_messages(self, client):
        """POST /chat 缺少 messages 回傳 422"""
        c, _ = client
        response = c.post("/chat", json={
            "model": "claude-sonnet-4-20250514",
        })
        assert response.status_code == 422

    def test_chat_handler_runtime_error(self):
        """POST /chat handler RuntimeError 回傳 503"""
        mock_claude = MagicMock()
        mock_claude.chat = AsyncMock(side_effect=RuntimeError("ANTHROPIC_API_KEY 未設定"))

        with patch("services.ai.llm_service.main.claude_handler", mock_claude), \
             patch("services.ai.llm_service.main.gpt_handler"):
            from services.ai.llm_service.main import app
            with TestClient(app) as c:
                response = c.post("/chat", json={
                    "model": "claude-sonnet-4-20250514",
                    "messages": [{"role": "user", "content": "你好"}],
                })
                assert response.status_code == 503

    def test_chat_handler_general_error(self):
        """POST /chat handler 一般錯誤回傳 500"""
        mock_claude = MagicMock()
        mock_claude.chat = AsyncMock(side_effect=Exception("API 連線超時"))

        with patch("services.ai.llm_service.main.claude_handler", mock_claude), \
             patch("services.ai.llm_service.main.gpt_handler"):
            from services.ai.llm_service.main import app
            with TestClient(app) as c:
                response = c.post("/chat", json={
                    "model": "claude-sonnet-4-20250514",
                    "messages": [{"role": "user", "content": "你好"}],
                })
                assert response.status_code == 500


# ─── Claude Handler 無 Key 測試 ────────────────────────────────────

class TestClaudeHandlerNoKey:
    """測試 Claude handler 未設定 API Key 時的行為"""

    @pytest.mark.asyncio
    async def test_chat_raises_without_key(self):
        """未設定 ANTHROPIC_API_KEY 時 chat 應拋出 RuntimeError"""
        original = os.environ.get("ANTHROPIC_API_KEY")
        os.environ.pop("ANTHROPIC_API_KEY", None)

        try:
            from services.ai.llm_service.claude_handler import ClaudeHandler
            handler = ClaudeHandler()

            with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
                await handler.chat(
                    model="claude-sonnet-4-20250514",
                    system_prompt="test",
                    messages=[{"role": "user", "content": "test"}],
                )
        finally:
            if original:
                os.environ["ANTHROPIC_API_KEY"] = original

    @pytest.mark.asyncio
    async def test_stream_raises_without_key(self):
        """未設定 ANTHROPIC_API_KEY 時 chat_stream 應拋出 RuntimeError"""
        original = os.environ.get("ANTHROPIC_API_KEY")
        os.environ.pop("ANTHROPIC_API_KEY", None)

        try:
            from services.ai.llm_service.claude_handler import ClaudeHandler
            handler = ClaudeHandler()

            with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
                async for _ in handler.chat_stream(
                    model="claude-sonnet-4-20250514",
                    system_prompt="test",
                    messages=[{"role": "user", "content": "test"}],
                ):
                    pass
        finally:
            if original:
                os.environ["ANTHROPIC_API_KEY"] = original
