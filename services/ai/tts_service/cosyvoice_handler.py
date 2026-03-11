"""CosyVoice Handler — Phase 2 實作"""


class CosyVoiceHandler:
    """CosyVoice 2.0 語音克隆 handler（Phase 2）"""

    def __init__(self):
        pass

    async def clone_voice(self, voice_sample_path: str) -> str:
        """克隆聲音模型"""
        raise NotImplementedError("Phase 2 實作")

    async def synthesize(self, text: str, voice_model_id: str) -> bytes:
        """文字轉語音"""
        raise NotImplementedError("Phase 2 實作")
