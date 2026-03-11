"""句子分割工具 — 支援中英文標點"""

import re


# 常見英文縮寫（不應該在此處分割）
_ABBREVIATIONS = {
    "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Jr.", "Sr.",
    "Inc.", "Ltd.", "Corp.", "Co.", "vs.", "etc.", "e.g.",
    "i.e.", "a.m.", "p.m.", "U.S.", "U.K.", "U.N.",
    "St.", "Ave.", "Blvd.", "Dept.", "Fig.", "Vol.",
    "No.", "Jan.", "Feb.", "Mar.", "Apr.", "Jun.",
    "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec.",
}

# 中文句尾標點
_CN_TERMINATORS = "。？！"
# 英文句尾標點
_EN_TERMINATORS = ".?!"
# 所有句尾標點
_ALL_TERMINATORS = _CN_TERMINATORS + _EN_TERMINATORS


def _is_abbreviation(text: str, dot_pos: int) -> bool:
    """檢查句點是否屬於縮寫"""
    # 向前找到最近的空白或句首
    start = dot_pos
    while start > 0 and text[start - 1] not in " \t\n":
        start -= 1
    word = text[start:dot_pos + 1]
    return word in _ABBREVIATIONS


def _is_decimal_dot(text: str, dot_pos: int) -> bool:
    """檢查句點是否是數字中的小數點（例如 3.14）"""
    if dot_pos <= 0 or dot_pos >= len(text) - 1:
        return False
    return text[dot_pos - 1].isdigit() and text[dot_pos + 1].isdigit()


def _is_ellipsis(text: str, dot_pos: int) -> bool:
    """檢查是否為省略號（...）"""
    # 如果前後也有句點，視為省略號的一部分
    if dot_pos > 0 and text[dot_pos - 1] == ".":
        return True
    if dot_pos < len(text) - 1 and text[dot_pos + 1] == ".":
        return True
    return False


def _is_url_or_path(text: str, dot_pos: int) -> bool:
    """檢查句點是否屬於 URL 或檔案路徑"""
    # 簡易檢查：句點前後都不是空白，且後面是字母
    if dot_pos >= len(text) - 1:
        return False
    if dot_pos <= 0:
        return False
    # 前面不是空白且後面是字母（像 example.com、file.txt）
    before = text[dot_pos - 1]
    after = text[dot_pos + 1]
    if before.isalnum() and after.isalpha():
        # 進一步檢查是否像 URL（含 :// 或 www.）
        line_start = text.rfind("\n", 0, dot_pos)
        line_start = 0 if line_start == -1 else line_start + 1
        segment = text[line_start:dot_pos + 5]
        if "://" in segment or "www." in segment:
            return True
        # 檔案副檔名（.py, .js, .go 等，通常 2-4 字元）
        ext_end = dot_pos + 1
        while ext_end < len(text) and text[ext_end].isalpha():
            ext_end += 1
        ext_len = ext_end - dot_pos - 1
        if 1 <= ext_len <= 4 and (ext_end >= len(text) or not text[ext_end].isalpha()):
            # 但只有在沒有空白跟隨的情況下才算
            if ext_end < len(text) and text[ext_end] in " \t\n":
                return False
            if ext_end >= len(text):
                return False
    return False


def split_sentences(text: str) -> list[str]:
    """
    將文本分割為句子列表。

    支援中文標點（。？！）和英文標點（.?!）。
    處理常見邊界情況：
    - 英文縮寫（Mr., Dr., etc.）
    - 小數點（3.14）
    - 省略號（...）
    - 連續標點不產生空句子

    Args:
        text: 要分割的文本

    Returns:
        句子列表，每個句子保留原始標點
    """
    if not text or not text.strip():
        return []

    sentences: list[str] = []
    current_start = 0
    i = 0

    while i < len(text):
        char = text[i]

        if char in _ALL_TERMINATORS:
            is_boundary = True

            # 英文句點需要額外檢查
            if char == ".":
                if _is_abbreviation(text, i):
                    is_boundary = False
                elif _is_decimal_dot(text, i):
                    is_boundary = False
                elif _is_ellipsis(text, i):
                    # 跳到省略號末尾
                    while i < len(text) - 1 and text[i + 1] == ".":
                        i += 1
                    is_boundary = True

            if is_boundary:
                # 包含當前標點符號
                end = i + 1

                # 吸收後面的引號或括號（例如「好嗎？」）
                while end < len(text) and text[end] in "」』\"')）】》":
                    end += 1

                sentence = text[current_start:end].strip()
                if sentence:
                    sentences.append(sentence)
                current_start = end
                i = end
                continue

        i += 1

    # 處理最後剩餘的文字
    remaining = text[current_start:].strip()
    if remaining:
        sentences.append(remaining)

    return sentences
