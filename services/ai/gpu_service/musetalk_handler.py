"""MuseTalk 即時唇形動畫 Handler

單幀延遲 ~38ms (26 FPS)，VRAM ~4.1GB

流程：
1. prepare_face(image) → 預處理臉部 landmark + VAE latent（一次性）
2. generate_frame(face_id, audio_features) → 生成單幀 JPEG（~38ms）

安裝：
    cd /workspace/MuseTalk
    pip install mmengine mmcv==2.1.0 mmdet==3.3.0 mmpose==1.3.2
"""

import io
import os
import sys
import time
import logging
import tempfile
import numpy as np
from pathlib import Path

logger = logging.getLogger(__name__)


class MuseTalkHandler:
    """MuseTalk 即時唇形動畫 — ~38ms/frame"""

    def __init__(self, model_dir):
        self.model_dir = Path(model_dir) if not isinstance(model_dir, Path) else model_dir
        self.face_cache = {}  # face_id -> 預處理後的臉部資料

        # 加入 MuseTalk 路徑
        musetalk_path = Path("/workspace/MuseTalk")
        if not musetalk_path.exists():
            raise ImportError("MuseTalk 未安裝: /workspace/MuseTalk 不存在")

        sys.path.insert(0, str(musetalk_path))

        # MuseTalk 內部用相對路徑載入 config，需切換工作目錄
        original_cwd = os.getcwd()
        os.chdir(str(musetalk_path))

        try:
            import cv2
            import torch
            self.cv2 = cv2
            self.torch = torch

            # 載入模型
            from musetalk.utils.utils import load_all_model
            from musetalk.utils.preprocessing import get_landmark_and_bbox, coord_placeholder
            from musetalk.utils.blending import get_image_prepare_material, get_image_blending
            from musetalk.utils.audio_processor import AudioProcessor
            from transformers import WhisperModel

            self.get_landmark_and_bbox = get_landmark_and_bbox
            self.coord_placeholder = coord_placeholder
            self.get_image_prepare_material = get_image_prepare_material
            self.get_image_blending = get_image_blending

            # 載入 VAE + UNet + PE
            self.vae, self.unet, self.pe = load_all_model(
                unet_model_path="models/musetalk/pytorch_model.bin",
                vae_type="sd-vae",
                unet_config="models/musetalk/musetalk.json"
            )

            # 載入 Whisper（音訊特徵提取用）
            whisper_path = str(musetalk_path / "models" / "whisper")
            self.whisper = WhisperModel.from_pretrained(whisper_path).to("cuda").half()
            self.whisper.eval()

            # 載入音訊處理器
            self.audio_processor = AudioProcessor(feature_extractor_path=whisper_path)

            # Face parsing（混合用）
            from musetalk.utils.face_parsing import FaceParsing
            self.fp = FaceParsing()

            logger.info("MuseTalk 模型載入完成，VRAM: %.1fGB" % (torch.cuda.memory_allocated() / 1e9))
        except Exception as e:
            os.chdir(original_cwd)
            raise e

        # 保持在 MuseTalk 目錄（DWPose 需要相對路徑）
        # os.chdir(original_cwd)

    def prepare_face(self, face_id: str, image_bytes: bytes) -> dict:
        """預處理臉部特徵（Session 開始時呼叫一次，~2秒）

        回傳：face_id, bbox, frame_count
        """
        cv2 = self.cv2
        torch = self.torch

        # 解碼圖片
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("無法解碼臉部圖片")

        # 存為臨時檔案（get_landmark_and_bbox 需要檔案路徑）
        tmp_dir = tempfile.mkdtemp(prefix="musetalk_")
        tmp_path = os.path.join(tmp_dir, "face.png")
        cv2.imwrite(tmp_path, img)

        # 偵測臉部 landmark 和 bbox
        coord_list, frame_list = self.get_landmark_and_bbox([tmp_path], 0)

        if len(coord_list) == 0 or coord_list[0] == self.coord_placeholder:
            raise ValueError("未偵測到臉部")

        x1, y1, x2, y2 = coord_list[0]
        frame = frame_list[0]

        # 裁切臉部並編碼為 VAE latent
        crop = frame[y1:y2, x1:x2]
        crop_resized = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_LANCZOS4)
        latent = self.vae.get_latents_for_unet(crop_resized)

        # 準備 blending mask
        mask, crop_box = self.get_image_prepare_material(frame, [x1, y1, x2, y2], fp=self.fp)

        # 快取
        self.face_cache[face_id] = {
            "frame": frame,             # 原始完整幀
            "coord": [x1, y1, x2, y2],  # 臉部 bbox
            "latent": latent,            # VAE latent [1, 8, 32, 32]
            "mask": mask,               # blending mask
            "crop_box": crop_box,       # blending crop box
        }

        logger.info("臉部預處理完成: %s, bbox=[%d,%d,%d,%d]" % (face_id, x1, y1, x2, y2))

        # 清理臨時檔案
        try:
            os.unlink(tmp_path)
            os.rmdir(tmp_dir)
        except:
            pass

        return {"face_id": face_id, "bbox": [int(x1), int(y1), int(x2), int(y2)]}

    def _audio_bytes_to_numpy(self, audio_bytes: bytes, sample_rate: int) -> np.ndarray:
        """音訊 bytes → 16kHz float32 numpy（記憶體內，不寫檔）"""
        import soundfile as sf
        import librosa

        if audio_bytes[:4] == b"RIFF":
            # WAV 格式 — 用 soundfile 直接從記憶體讀取
            audio_np, sr = sf.read(io.BytesIO(audio_bytes), dtype='float32')
            if len(audio_np.shape) > 1:
                audio_np = audio_np.mean(axis=1)  # stereo → mono
            if sr != 16000:
                audio_np = librosa.resample(audio_np, orig_sr=sr, target_sr=16000)
        else:
            # Raw PCM 16bit mono
            audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            if sample_rate != 16000:
                import librosa
                audio_np = librosa.resample(audio_np, orig_sr=sample_rate, target_sr=16000)
        return audio_np

    def _extract_whisper_features(self, audio_np: np.ndarray) -> list:
        """從 numpy 音訊提取 whisper 特徵（記憶體內，不寫臨時檔）"""
        import math
        from einops import rearrange
        torch = self.torch

        t0 = time.time()

        # Mel-spectrogram 特徵（Whisper feature extractor）
        # 注意：feature_extractor 會自動 pad 到 30 秒
        input_features = self.audio_processor.feature_extractor(
            audio_np, return_tensors="pt", sampling_rate=16000
        ).input_features.to(dtype=torch.float16)

        t1 = time.time()

        # Whisper encoder（最耗時的步驟）
        input_features = input_features.to("cuda")
        with torch.no_grad():
            audio_feats = self.whisper.encoder(
                input_features, output_hidden_states=True
            ).hidden_states
            audio_feats = torch.stack(audio_feats, dim=2)  # [1, 1500, layers, dim]

        t2 = time.time()

        # 計算實際幀數和裁切
        sr = 16000
        audio_fps = 50
        fps = 25
        whisper_idx_multiplier = audio_fps / fps
        librosa_length = len(audio_np)
        num_frames = math.floor((librosa_length / sr) * fps)
        actual_length = math.floor((librosa_length / sr) * audio_fps)
        audio_feats = audio_feats[:, :actual_length, ...]

        # Padding
        audio_padding_length_left = 2
        audio_padding_length_right = 2
        audio_feature_length_per_frame = 2 * (audio_padding_length_left + audio_padding_length_right + 1)
        padding_nums = math.ceil(whisper_idx_multiplier)
        audio_feats = torch.cat([
            torch.zeros_like(audio_feats[:, :padding_nums * audio_padding_length_left]),
            audio_feats,
            torch.zeros_like(audio_feats[:, :padding_nums * 3 * audio_padding_length_right])
        ], 1)

        # 切分為每幀的 audio prompt
        audio_prompts = []
        for frame_index in range(num_frames):
            audio_index = math.floor(frame_index * whisper_idx_multiplier)
            audio_clip = audio_feats[:, audio_index: audio_index + audio_feature_length_per_frame]
            if audio_clip.shape[1] == audio_feature_length_per_frame:
                audio_prompts.append(audio_clip)

        if audio_prompts:
            audio_prompts = torch.cat(audio_prompts, dim=0)
            audio_prompts = rearrange(audio_prompts, 'b c h w -> b (c h) w')
        else:
            audio_prompts = torch.zeros(0)

        t3 = time.time()
        logger.info("Whisper 特徵: mel=%.0fms, encoder=%.0fms, chunk=%.0fms, 共 %d 幀" % (
            (t1 - t0) * 1000, (t2 - t1) * 1000, (t3 - t2) * 1000, len(audio_prompts)))

        return audio_prompts

    def generate_frames_from_audio(self, face_id: str, audio_bytes: bytes, sample_rate: int = 16000) -> list:
        """從完整音訊生成所有唇形動畫幀

        audio_bytes: WAV 或 raw PCM 音訊
        回傳: list of JPEG bytes（每幀一張）
        """
        cv2 = self.cv2
        torch = self.torch
        total_start = time.time()

        face_info = self.face_cache.get(face_id)
        if face_info is None:
            raise ValueError("找不到臉部快取: %s" % face_id)

        # 音訊 → numpy（記憶體內，不寫臨時檔）
        t0 = time.time()
        audio_np = self._audio_bytes_to_numpy(audio_bytes, sample_rate)
        t1 = time.time()
        logger.info("音訊解碼: %.0fms (%.1f 秒音訊)" % ((t1 - t0) * 1000, len(audio_np) / 16000))

        # Whisper 特徵提取（記憶體內）
        whisper_chunks = self._extract_whisper_features(audio_np)

        if len(whisper_chunks) == 0:
            logger.warning("Whisper 特徵為空，音訊太短？")
            return []

        # 生成每一幀
        frames = []
        latent = face_info["latent"]
        frame = face_info["frame"]
        coord = face_info["coord"]
        mask = face_info["mask"]
        crop_box = face_info["crop_box"]

        x1, y1, x2, y2 = coord
        # 預先計算常用 tensor
        timestep = torch.tensor([0], device="cuda")

        gen_start = time.time()

        for i, whisper_chunk in enumerate(whisper_chunks):
            # 加位置編碼（需要 3D: batch, seq_len, d_model）
            whisper_chunk = self.pe(whisper_chunk.unsqueeze(0))

            with torch.no_grad():
                pred = self.unet.model(
                    latent,
                    timestep=timestep,
                    encoder_hidden_states=whisper_chunk
                ).sample

            # VAE 解碼
            decoded = self.vae.decode_latents(pred)
            pred_face = decoded[0]  # (256, 256, 3) BGR

            # 混合回原圖
            pred_resized = cv2.resize(pred_face, (x2 - x1, y2 - y1))
            result = self.get_image_blending(
                frame.copy(), pred_resized, coord, mask, crop_box
            )

            # 編碼為 JPEG
            _, jpeg = cv2.imencode(".jpg", result, [cv2.IMWRITE_JPEG_QUALITY, 85])
            frames.append(jpeg.tobytes())

        gen_elapsed = (time.time() - gen_start) * 1000
        total_elapsed = (time.time() - total_start) * 1000
        if len(frames) > 0:
            logger.info("MuseTalk 生成 %d 幀: GPU=%.0fms (%.1fms/幀), 總計=%.0fms" % (
                len(frames), gen_elapsed, gen_elapsed / len(frames), total_elapsed))

        return frames

    def generate_frames_streaming(self, face_id: str, audio_bytes: bytes, sample_rate: int = 16000):
        """串流版本 — yield 每一幀 JPEG bytes（邊生成邊回傳）
        前幾幀可以更快送出，不用等全部完成
        """
        cv2 = self.cv2
        torch = self.torch
        total_start = time.time()

        face_info = self.face_cache.get(face_id)
        if face_info is None:
            raise ValueError("找不到臉部快取: %s" % face_id)

        audio_np = self._audio_bytes_to_numpy(audio_bytes, sample_rate)
        whisper_chunks = self._extract_whisper_features(audio_np)

        if len(whisper_chunks) == 0:
            return

        latent = face_info["latent"]
        frame = face_info["frame"]
        coord = face_info["coord"]
        mask = face_info["mask"]
        crop_box = face_info["crop_box"]
        x1, y1, x2, y2 = coord
        timestep = torch.tensor([0], device="cuda")
        num_frames = len(whisper_chunks)

        for i, whisper_chunk in enumerate(whisper_chunks):
            whisper_chunk = self.pe(whisper_chunk.unsqueeze(0))
            with torch.no_grad():
                pred = self.unet.model(
                    latent, timestep=timestep, encoder_hidden_states=whisper_chunk
                ).sample
            decoded = self.vae.decode_latents(pred)
            pred_face = decoded[0]
            pred_resized = cv2.resize(pred_face, (x2 - x1, y2 - y1))
            result = self.get_image_blending(frame.copy(), pred_resized, coord, mask, crop_box)
            _, jpeg = cv2.imencode(".jpg", result, [cv2.IMWRITE_JPEG_QUALITY, 85])
            yield jpeg.tobytes()

        total_elapsed = (time.time() - total_start) * 1000
        logger.info("MuseTalk 串流生成 %d 幀, 總計=%.0fms" % (num_frames, total_elapsed))

    def remove_face(self, face_id: str):
        """移除臉部快取"""
        if face_id in self.face_cache:
            del self.face_cache[face_id]
            logger.info("臉部快取已移除: %s" % face_id)
