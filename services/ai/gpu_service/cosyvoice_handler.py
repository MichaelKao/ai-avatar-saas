"""CosyVoice 2.0 語音克隆 Handler

安裝：
    cd /workspace
    git clone https://github.com/FunAudioLLM/CosyVoice.git
    cd CosyVoice
    pip install -r requirements.txt
    # 下載預訓練模型
    python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice2-0.5B', local_dir='pretrained_models/CosyVoice2-0.5B')"
"""

import os
import sys
import numpy as np
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class CosyVoiceHandler:
    """CosyVoice 2.0 語音克隆"""

    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        self.voice_profiles = {}  # voice_id -> speaker embedding

        # 加入 CosyVoice 路徑
        cosyvoice_path = Path("/workspace/CosyVoice")
        if cosyvoice_path.exists():
            sys.path.insert(0, str(cosyvoice_path))

        # 載入模型
        try:
            from cosyvoice.cli.cosyvoice import CosyVoice2
            model_path = model_dir / "CosyVoice2-0.5B"
            if not model_path.exists():
                model_path = Path("/workspace/CosyVoice/pretrained_models/CosyVoice2-0.5B")

            self.model = CosyVoice2(str(model_path))
            logger.info(f"CosyVoice 模型載入自 {model_path}")
        except ImportError:
            logger.error("CosyVoice 未安裝，請先 clone CosyVoice repo")
            raise

    def create_voice_profile(self, voice_id: str, sample_path: str):
        """從語音樣本建立聲音檔案"""
        import torchaudio

        # 讀取語音樣本
        waveform, sr = torchaudio.load(sample_path)

        # 儲存 voice profile（CosyVoice 使用 prompt 音訊）
        profile_path = self.model_dir / f"voice_profile_{voice_id}.wav"
        if sr != 16000:
            resampler = torchaudio.transforms.Resample(sr, 16000)
            waveform = resampler(waveform)
        torchaudio.save(str(profile_path), waveform, 16000)

        self.voice_profiles[voice_id] = str(profile_path)
        logger.info(f"聲音檔案已建立: {voice_id}")

    def synthesize(self, text: str, voice_id: str, output_path: str):
        """文字轉語音"""
        profile_path = self.voice_profiles.get(voice_id)
        if not profile_path:
            raise ValueError(f"找不到聲音檔案: {voice_id}")

        # 使用 CosyVoice 的 zero-shot 合成
        import torchaudio

        # CosyVoice2 的 inference_zero_shot 方法
        output = self.model.inference_zero_shot(
            tts_text=text,
            prompt_text="",  # 自動從音訊提取
            prompt_speech_16k=profile_path,
            stream=False,
        )

        # 儲存輸出
        for result in output:
            tts_speech = result["tts_speech"]
            torchaudio.save(output_path, tts_speech, 22050)
            break

        logger.info(f"語音合成完成: {output_path}")

    def synthesize_stream(self, text: str, voice_id: str):
        """串流語音合成（逐句）"""
        profile_path = self.voice_profiles.get(voice_id)
        if not profile_path:
            raise ValueError(f"找不到聲音檔案: {voice_id}")

        output = self.model.inference_zero_shot(
            tts_text=text,
            prompt_text="",
            prompt_speech_16k=profile_path,
            stream=True,
        )

        for result in output:
            tts_speech = result["tts_speech"]
            # 轉成 bytes 串流
            audio_bytes = (tts_speech.numpy() * 32767).astype(np.int16).tobytes()
            yield audio_bytes
