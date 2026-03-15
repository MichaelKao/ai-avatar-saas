"""CosyVoice 語音克隆 Handler

支援兩種模型：
- CosyVoice-300M-SFT: 有內建中文聲音（中文女/中文男/英文女/英文男/日語男/粵語女/韓語女），用於預設語音
- CosyVoice2-0.5B: zero-shot 語音克隆，用於自訂聲音

安裝：
    cd /workspace
    git clone https://github.com/FunAudioLLM/CosyVoice.git
    cd CosyVoice
    git submodule update --init --recursive
    pip install -r requirements.txt
    cd third_party/Matcha-TTS && pip install -e .
    # 下載模型
    python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice-300M-SFT', local_dir='pretrained_models/CosyVoice-300M-SFT')"
    python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice2-0.5B', local_dir='pretrained_models/CosyVoice2-0.5B')"
"""

import os
import sys
import numpy as np
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class CosyVoiceHandler:
    """CosyVoice TTS — 支援 SFT 內建聲音 + zero-shot 語音克隆"""

    def __init__(self, model_dir):
        self.model_dir = Path(model_dir) if not isinstance(model_dir, Path) else model_dir
        self.voice_profiles = {}  # voice_id -> speaker embedding
        self.sft_model = None  # 300M-SFT（有內建 speaker）
        self.zs_model = None   # 2.0-0.5B（zero-shot 克隆）

        # 加入 CosyVoice 路徑
        cosyvoice_path = Path("/workspace/CosyVoice")
        if cosyvoice_path.exists():
            sys.path.insert(0, str(cosyvoice_path))

        try:
            from cosyvoice.cli.cosyvoice import CosyVoice, CosyVoice2

            # 載入 SFT 模型（有內建中文女/男 speaker）
            sft_paths = [
                self.model_dir / "CosyVoice-300M-SFT",
                Path("/workspace/CosyVoice/pretrained_models/CosyVoice-300M-SFT"),
            ]
            for p in sft_paths:
                if p.exists():
                    self.sft_model = CosyVoice(str(p))
                    logger.info(f"CosyVoice SFT 模型載入自 {p}")
                    logger.info(f"可用 speakers: {self.sft_model.list_available_spks()}")
                    break

            # 載入 zero-shot 模型（語音克隆用）
            zs_paths = [
                self.model_dir / "CosyVoice2-0.5B",
                Path("/workspace/CosyVoice/pretrained_models/CosyVoice2-0.5B"),
            ]
            for p in zs_paths:
                if p.exists():
                    self.zs_model = CosyVoice2(str(p))
                    logger.info(f"CosyVoice2 zero-shot 模型載入自 {p}")
                    break

            if self.sft_model is None and self.zs_model is None:
                raise RuntimeError("找不到任何 CosyVoice 模型")

        except ImportError:
            logger.error("CosyVoice 未安裝，請先 clone CosyVoice repo")
            raise

    # 性別對應 CosyVoice SFT 內建 speaker
    GENDER_SPEAKER_MAP = {
        "male": "中文男",
        "female": "中文女",
    }

    def create_voice_profile(self, voice_id: str, sample_path: str):
        """從語音樣本建立聲音檔案"""
        import torchaudio

        waveform, sr = torchaudio.load(sample_path)
        profile_path = self.model_dir / f"voice_profile_{voice_id}.wav"
        if sr != 16000:
            resampler = torchaudio.transforms.Resample(sr, 16000)
            waveform = resampler(waveform)
        torchaudio.save(str(profile_path), waveform, 16000)

        self.voice_profiles[voice_id] = str(profile_path)
        logger.info(f"聲音檔案已建立: {voice_id}")

    def synthesize_default(self, text: str, output_path: str, voice_gender: str = "female"):
        """使用 SFT 內建聲音 TTS"""
        import torchaudio

        if self.sft_model is None:
            raise RuntimeError("CosyVoice SFT 模型未載入")

        speaker = self.GENDER_SPEAKER_MAP.get(voice_gender, "中文女")
        output = self.sft_model.inference_sft(
            tts_text=text,
            spk_id=speaker,
            stream=False,
        )

        for result in output:
            tts_speech = result["tts_speech"]
            torchaudio.save(output_path, tts_speech, 22050)
            break

        logger.info(f"預設聲音合成完成: {output_path}")

    def synthesize(self, text: str, voice_id: str, output_path: str):
        """文字轉語音"""
        if voice_id == "default":
            return self.synthesize_default(text, output_path)

        profile_path = self.voice_profiles.get(voice_id)
        if not profile_path:
            raise ValueError(f"找不到聲音檔案: {voice_id}")

        model = self.zs_model or self.sft_model
        if model is None:
            raise RuntimeError("CosyVoice 模型未載入")

        import torchaudio

        output = model.inference_zero_shot(
            tts_text=text,
            prompt_text="",
            prompt_speech_16k=profile_path,
            stream=False,
        )

        for result in output:
            tts_speech = result["tts_speech"]
            torchaudio.save(output_path, tts_speech, 22050)
            break

        logger.info(f"語音合成完成: {output_path}")

    def synthesize_stream(self, text: str, voice_id: str):
        """串流語音合成（zero-shot 模式）"""
        profile_path = self.voice_profiles.get(voice_id)
        if not profile_path:
            raise ValueError(f"找不到聲音檔案: {voice_id}")

        model = self.zs_model or self.sft_model
        if model is None:
            raise RuntimeError("CosyVoice 模型未載入")

        output = model.inference_zero_shot(
            tts_text=text,
            prompt_text="",
            prompt_speech_16k=profile_path,
            stream=True,
        )

        for result in output:
            tts_speech = result["tts_speech"]
            audio_bytes = (tts_speech.numpy() * 32767).astype(np.int16).tobytes()
            yield audio_bytes

    def synthesize_stream_sft(self, text: str, voice_gender: str = "female"):
        """串流語音合成（SFT 內建聲音，首 chunk < 100ms）"""
        if self.sft_model is None:
            raise RuntimeError("CosyVoice SFT 模型未載入")

        speaker = self.GENDER_SPEAKER_MAP.get(voice_gender, "中文女")
        output = self.sft_model.inference_sft(
            tts_text=text,
            spk_id=speaker,
            stream=True,
        )

        for result in output:
            tts_speech = result["tts_speech"]
            # 轉成 16bit PCM bytes（22050Hz mono）
            audio_bytes = (tts_speech.numpy() * 32767).astype(np.int16).tobytes()
            yield audio_bytes
