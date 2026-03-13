"""GPT API Handler"""

import json
import os
from typing import AsyncGenerator

import openai

from claude_handler import _find_cut_position


class GPTHandler:
    """處理 OpenAI GPT API 呼叫"""

    def __init__(self):
        api_key = os.getenv("OPENAI_API_KEY")
        if api_key:
            self.client = openai.AsyncOpenAI(api_key=api_key)
        else:
            self.client = None

    async def chat(
        self,
        model: str,
        system_prompt: str,
        messages: list[dict],
        temperature: float = 0.7,
    ) -> dict:
        """非串流對話"""
        if not self.client:
            raise RuntimeError("OPENAI_API_KEY 未設定")

        full_messages = [{"role": "system", "content": system_prompt}] + messages

        response = await self.client.chat.completions.create(
            model=model,
            messages=full_messages,
            temperature=temperature,
            max_tokens=512,
        )

        return {
            "text": response.choices[0].message.content,
            "model": model,
            "usage": {
                "input_tokens": response.usage.prompt_tokens,
                "output_tokens": response.usage.completion_tokens,
            },
        }

    async def chat_stream(
        self,
        model: str,
        system_prompt: str,
        messages: list[dict],
        temperature: float = 0.7,
    ) -> AsyncGenerator[str, None]:
        """串流對話 — 逗號級切段，更快開始 TTS"""
        if not self.client:
            raise RuntimeError("OPENAI_API_KEY 未設定")

        full_messages = [{"role": "system", "content": system_prompt}] + messages

        stream = await self.client.chat.completions.create(
            model=model,
            messages=full_messages,
            temperature=temperature,
            max_tokens=512,
            stream=True,
        )

        buffer = ""
        async for chunk in stream:
            if chunk.choices[0].delta.content:
                buffer += chunk.choices[0].delta.content
                while True:
                    cut_pos = _find_cut_position(buffer)
                    if cut_pos is None:
                        break
                    text_chunk = buffer[:cut_pos]
                    buffer = buffer[cut_pos:]
                    yield f"data: {json.dumps({'text': text_chunk}, ensure_ascii=False)}\n\n"

        if buffer.strip():
            yield f"data: {json.dumps({'text': buffer}, ensure_ascii=False)}\n\n"

        yield "data: [DONE]\n\n"
