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

    def generate_frames_from_audio(self, face_id: str, audio_bytes: bytes, sample_rate: int = 16000) -> list:
        """從完整音訊生成所有唇形動畫幀

        audio_bytes: WAV 或 raw PCM 音訊
        回傳: list of JPEG bytes（每幀一張）
        """
        cv2 = self.cv2
        torch = self.torch

        face_info = self.face_cache.get(face_id)
        if face_info is None:
            raise ValueError("找不到臉部快取: %s" % face_id)

        # 將音訊存為臨時 WAV 檔
        tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        try:
            # 如果是 raw PCM，加上 WAV header
            if not audio_bytes[:4] == b"RIFF":
                import struct
                num_samples = len(audio_bytes) // 2  # 16bit
                wav_header = struct.pack(
                    '<4sI4s4sIHHIIHH4sI',
                    b'RIFF', 36 + len(audio_bytes), b'WAVE',
                    b'fmt ', 16, 1, 1, sample_rate, sample_rate * 2, 2, 16,
                    b'data', len(audio_bytes)
                )
                tmp_wav.write(wav_header + audio_bytes)
            else:
                tmp_wav.write(audio_bytes)
            tmp_wav.flush()
            tmp_wav_path = tmp_wav.name
        finally:
            tmp_wav.close()

        try:
            # 提取音訊 whisper 特徵
            whisper_input_features, librosa_length = self.audio_processor.get_audio_feature(
                tmp_wav_path, weight_dtype=torch.float16
            )
            whisper_chunks = self.audio_processor.get_whisper_chunk(
                whisper_input_features,
                device="cuda",
                weight_dtype=torch.float16,
                whisper=self.whisper,
                librosa_length=librosa_length,
                fps=25,
            )
        finally:
            os.unlink(tmp_wav_path)

        # 生成每一幀
        frames = []
        latent = face_info["latent"]
        frame = face_info["frame"]
        coord = face_info["coord"]
        mask = face_info["mask"]
        crop_box = face_info["crop_box"]

        x1, y1, x2, y2 = coord
        gen_start = time.time()

        for i, whisper_chunk in enumerate(whisper_chunks):
            # 加位置編碼（需要 3D: batch, seq_len, d_model）
            whisper_chunk = self.pe(whisper_chunk.unsqueeze(0))

            with torch.no_grad():
                pred = self.unet.model(
                    latent,
                    timestep=torch.tensor([0]).to("cuda"),
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
        if len(frames) > 0:
            logger.info("MuseTalk 生成 %d 幀, 總耗時 %.0fms, 平均 %.1fms/幀" % (
                len(frames), gen_elapsed, gen_elapsed / len(frames)))

        return frames

    def remove_face(self, face_id: str):
        """移除臉部快取"""
        if face_id in self.face_cache:
            del self.face_cache[face_id]
            logger.info("臉部快取已移除: %s" % face_id)
