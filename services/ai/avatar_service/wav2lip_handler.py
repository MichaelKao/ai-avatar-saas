"""Wav2Lip Handler — Phase 2 實作"""


class Wav2LipHandler:
    """Wav2Lip 臉部動畫 handler（Phase 2）"""

    async def generate_frames(self, face_image: bytes, audio: bytes) -> bytes:
        """生成說話影片幀"""
        raise NotImplementedError("Phase 2 實作")
