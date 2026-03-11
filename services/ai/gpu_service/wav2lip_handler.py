"""Wav2Lip 臉部動畫 Handler

安裝：
    cd /workspace
    git clone https://github.com/Rudrabha/Wav2Lip.git
    cd Wav2Lip
    pip install -r requirements.txt

    # 下載預訓練模型
    mkdir -p checkpoints
    # 從 https://github.com/Rudrabha/Wav2Lip#getting-the-weights 下載
    # wav2lip_gan.pth 放到 checkpoints/
"""

import os
import sys
import cv2
import numpy as np
import subprocess
import logging
from pathlib import Path

import torch

logger = logging.getLogger(__name__)


class Wav2LipHandler:
    """Wav2Lip 臉部動畫生成"""

    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        self.device = "cuda" if torch.cuda.is_available() else "cpu"

        # 加入 Wav2Lip 路徑
        wav2lip_path = Path("/workspace/Wav2Lip")
        if wav2lip_path.exists():
            sys.path.insert(0, str(wav2lip_path))

        # 載入模型
        checkpoint_path = model_dir / "wav2lip_gan.pth"
        if not checkpoint_path.exists():
            checkpoint_path = wav2lip_path / "checkpoints" / "wav2lip_gan.pth"

        if not checkpoint_path.exists():
            raise FileNotFoundError(f"Wav2Lip 模型檔案不存在: {checkpoint_path}")

        self.checkpoint_path = str(checkpoint_path)
        self.wav2lip_path = str(wav2lip_path)
        logger.info(f"Wav2Lip 模型: {self.checkpoint_path}")

    def generate_video(self, face_path: str, audio_path: str, output_path: str):
        """生成說話影片"""
        cmd = [
            sys.executable,
            os.path.join(self.wav2lip_path, "inference.py"),
            "--checkpoint_path", self.checkpoint_path,
            "--face", face_path,
            "--audio", audio_path,
            "--outfile", output_path,
            "--resize_factor", "1",
            "--nosmooth",
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        if result.returncode != 0:
            logger.error(f"Wav2Lip 失敗: {result.stderr}")
            raise RuntimeError(f"影片生成失敗: {result.stderr[-500:]}")

        logger.info(f"影片生成完成: {output_path}")

    def generate_frames_stream(self, face_path: str, audio_path: str):
        """串流生成影片幀（用於即時傳輸）"""
        import tempfile

        # 先生成完整影片
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp_path = tmp.name

        self.generate_video(face_path, audio_path, tmp_path)

        # 讀取影片並逐幀輸出
        cap = cv2.VideoCapture(tmp_path)
        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                # 編碼為 JPEG
                _, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                frame_bytes = buffer.tobytes()
                # 發送幀大小 + 幀資料
                yield len(frame_bytes).to_bytes(4, "big") + frame_bytes
        finally:
            cap.release()
            os.unlink(tmp_path)
