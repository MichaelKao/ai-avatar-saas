"""Claude API Handler"""

import json
import os
from typing import AsyncGenerator

import anthropic


class ClaudeHandler:
    """處理 Claude API 呼叫"""

    def __init__(self):
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if api_key:
            self.client = anthropic.AsyncAnthropic(api_key=api_key)
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
            raise RuntimeError("ANTHROPIC_API_KEY 未設定")

        response = await self.client.messages.create(
            model=model,
            max_tokens=1024,
            system=system_prompt,
            messages=messages,
            temperature=temperature,
        )

        return {
            "text": response.content[0].text,
            "model": model,
            "usage": {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
            },
        }

    async def chat_stream(
        self,
        model: str,
        system_prompt: str,
        messages: list[dict],
        temperature: float = 0.7,
    ) -> AsyncGenerator[str, None]:
        """串流對話 — 逐句輸出"""
        if not self.client:
            raise RuntimeError("ANTHROPIC_API_KEY 未設定")

        async with self.client.messages.stream(
            model=model,
            max_tokens=1024,
            system=system_prompt,
            messages=messages,
            temperature=temperature,
        ) as stream:
            buffer = ""
            async for text in stream.text_stream:
                buffer += text
                # 句子級分割 — 遇到句號、問號、驚嘆號就輸出
                while any(sep in buffer for sep in ["。", "？", "！", ".", "?", "!"]):
                    for sep in ["。", "？", "！", ".", "?", "!"]:
                        if sep in buffer:
                            idx = buffer.index(sep) + len(sep)
                            sentence = buffer[:idx]
                            buffer = buffer[idx:]
                            yield f"data: {json.dumps({'text': sentence}, ensure_ascii=False)}\n\n"
                            break

            # 輸出剩餘文字
            if buffer.strip():
                yield f"data: {json.dumps({'text': buffer}, ensure_ascii=False)}\n\n"

            yield "data: [DONE]\n\n"
