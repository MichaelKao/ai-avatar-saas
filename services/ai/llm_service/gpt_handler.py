"""GPT API Handler"""

import json
import os
from typing import AsyncGenerator

import openai


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
            max_tokens=1024,
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
        """串流對話"""
        if not self.client:
            raise RuntimeError("OPENAI_API_KEY 未設定")

        full_messages = [{"role": "system", "content": system_prompt}] + messages

        stream = await self.client.chat.completions.create(
            model=model,
            messages=full_messages,
            temperature=temperature,
            max_tokens=1024,
            stream=True,
        )

        buffer = ""
        async for chunk in stream:
            if chunk.choices[0].delta.content:
                buffer += chunk.choices[0].delta.content
                while any(sep in buffer for sep in ["。", "？", "！", ".", "?", "!"]):
                    for sep in ["。", "？", "！", ".", "?", "!"]:
                        if sep in buffer:
                            idx = buffer.index(sep) + len(sep)
                            sentence = buffer[:idx]
                            buffer = buffer[idx:]
                            yield f"data: {json.dumps({'text': sentence}, ensure_ascii=False)}\n\n"
                            break

        if buffer.strip():
            yield f"data: {json.dumps({'text': buffer}, ensure_ascii=False)}\n\n"

        yield "data: [DONE]\n\n"
