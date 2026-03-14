"""Claude API Handler"""

import json
import os
from typing import AsyncGenerator

import anthropic


# 句子級分隔符（優先級高 → 遇到就切）
SENTENCE_SEPARATORS = ["。", "？", "！", ".", "?", "!"]
# 逗號級分隔符（最小 chunk 2 字元才切 — 越早切越快開始 TTS）
CLAUSE_SEPARATORS = ["，", "、", "；", ",", ";", "：", ":"]
# 最小 chunk 長度（2 字元即切，讓首句盡快送出 TTS）
MIN_CHUNK_LEN = 2
# 最大 chunk 長度（超過就強制切斷，不等標點）
MAX_CHUNK_LEN = 5


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
            max_tokens=512,
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
        """串流對話 — 逗號級切段，更快開始 TTS"""
        if not self.client:
            raise RuntimeError("ANTHROPIC_API_KEY 未設定")

        async with self.client.messages.stream(
            model=model,
            max_tokens=512,
            system=system_prompt,
            messages=messages,
            temperature=temperature,
        ) as stream:
            buffer = ""
            async for text in stream.text_stream:
                buffer += text
                # 嘗試切段：先找句子分隔符，再找逗號分隔符
                while True:
                    cut_pos = _find_cut_position(buffer)
                    if cut_pos is None:
                        break
                    chunk = buffer[:cut_pos]
                    buffer = buffer[cut_pos:]
                    yield f"data: {json.dumps({'text': chunk}, ensure_ascii=False)}\n\n"

            # 輸出剩餘文字
            if buffer.strip():
                yield f"data: {json.dumps({'text': buffer}, ensure_ascii=False)}\n\n"

            yield "data: [DONE]\n\n"


def _find_cut_position(buffer: str) -> int | None:
    """找到最佳切段位置 — 越早切越好，讓 TTS 盡快開始
    1. 句子分隔符（。？！.?!）→ 任何長度都切
    2. 逗號級分隔符（，、；,;：:）→ 至少 MIN_CHUNK_LEN 字元才切
    3. 超過 MAX_CHUNK_LEN → 強制切斷，不等標點
    """
    # 合併所有分隔符一起找最早的切點
    earliest = None
    for sep in SENTENCE_SEPARATORS:
        pos = buffer.find(sep)
        if pos >= 0:
            cut = pos + len(sep)
            if earliest is None or cut < earliest:
                earliest = cut

    # 句子分隔符找到就直接切（不管長度）
    if earliest is not None:
        return earliest

    # 逗號級分隔符（需要最小長度 MIN_CHUNK_LEN）
    if len(buffer) >= MIN_CHUNK_LEN:
        for sep in CLAUSE_SEPARATORS:
            pos = buffer.find(sep)
            if pos >= 0:
                cut = pos + len(sep)
                if cut >= MIN_CHUNK_LEN:
                    if earliest is None or cut < earliest:
                        earliest = cut
        if earliest is not None:
            return earliest

    # 超過 MAX_CHUNK_LEN 強制切斷（不等任何標點）
    if len(buffer) >= MAX_CHUNK_LEN:
        return MAX_CHUNK_LEN

    return None
