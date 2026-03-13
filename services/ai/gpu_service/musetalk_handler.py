"""MuseTalk 即時唇形動畫 Handler

安裝：
    cd /workspace
    git clone https://github.com/TMElyralab/MuseTalk.git
    cd MuseTalk
    pip install -r requirements.txt
    pip install mmlab-mim && mim install mmengine mmcv==2.1.0 mmdet==3.2.0 mmpose==1.3.1
    python -c "from huggingface_hub import snapshot_download; snapshot_download('TMElyralab/MuseTalk', local_dir='models')"
"""

import io
import os
import sys
import logging
import numpy as np
from pathlib import Path

logger = logging.getLogger(__name__)


class MuseTalkHandler:
    """MuseTalk 即時唇形動畫 — 30-50ms/frame"""

    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        self.face_cache = {}  # face_id -> 預處理後的臉部特徵

        # 加入 MuseTalk 路徑
        musetalk_path = Path("/workspace/MuseTalk")
        if musetalk_path.exists():
            sys.path.insert(0, str(musetalk_path))

        try:
            # MuseTalk 內部用相對路徑載入 config，需切換工作目錄
            original_cwd = os.getcwd()
            os.chdir(str(musetalk_path))

            # 載入 MuseTalk 推論模組
            from musetalk.utils.preprocessing import get_landmark_and_bbox
            from musetalk.utils.blending import get_image
            from musetalk.utils.utils import load_all_model

            self.audio_processor, self.vae, self.unet, self.pe = load_all_model()
            self.get_landmark_and_bbox = get_landmark_and_bbox
            self.get_image = get_image

            # 切回原工作目錄
            os.chdir(original_cwd)
            logger.info("MuseTalk 模型載入完成")
        except ImportError as e:
            logger.error(f"MuseTalk 未安裝: {e}")
            raise
        except Exception as e:
            logger.error(f"MuseTalk 載入失敗: {e}")
            raise

    def prepare_face(self, face_id: str, image_bytes: bytes) -> dict:
        """預處理臉部特徵（Session 開始時呼叫一次）
        回傳臉部資訊 dict，快取在記憶體中
        """
        import cv2
        import torch

        # 解碼圖片
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("無法解碼臉部圖片")

        # 偵測臉部 landmark 和 bounding box
        landmark, bbox = self.get_landmark_and_bbox(img)
        if landmark is None:
            raise ValueError("未偵測到臉部")

        # 裁切臉部區域
        x1, y1, x2, y2 = bbox
        face_crop = img[y1:y2, x1:x2]

        # 編碼臉部特徵（VAE latent）
        face_tensor = torch.from_numpy(face_crop).permute(2, 0, 1).unsqueeze(0).float() / 255.0
        face_tensor = face_tensor.to("cuda") if torch.cuda.is_available() else face_tensor

        with torch.no_grad():
            face_latent = self.vae.encode(face_tensor * 2 - 1).latent_dist.sample()

        face_info = {
            "original_image": img,
            "bbox": bbox,
            "landmark": landmark,
            "face_latent": face_latent,
            "face_crop_shape": face_crop.shape,
        }

        self.face_cache[face_id] = face_info
        logger.info(f"臉部預處理完成: {face_id}, bbox={bbox}")
        return {"face_id": face_id, "bbox": list(bbox)}

    def generate_frame(self, face_id: str, audio_chunk: bytes) -> bytes:
        """從音訊 chunk 生成單幀唇形動畫
        audio_chunk: 16kHz 16bit mono PCM
        回傳: JPEG bytes
        """
        import cv2
        import torch

        face_info = self.face_cache.get(face_id)
        if face_info is None:
            raise ValueError(f"找不到臉部快取: {face_id}")

        # 音訊特徵提取
        audio_array = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32) / 32768.0
        whisper_feature = self.audio_processor.audio2feat(audio_array)

        # UNet 推論生成嘴形
        with torch.no_grad():
            whisper_tensor = torch.from_numpy(whisper_feature).unsqueeze(0)
            if torch.cuda.is_available():
                whisper_tensor = whisper_tensor.to("cuda")

            # MuseTalk UNet：臉部 latent + 音訊特徵 → 新臉部 latent
            pred_latent = self.unet(face_info["face_latent"], whisper_tensor).sample

            # VAE 解碼
            pred_face = self.vae.decode(pred_latent / 0.18215).sample
            pred_face = (pred_face.squeeze().permute(1, 2, 0).cpu().numpy() + 1) / 2 * 255
            pred_face = pred_face.clip(0, 255).astype(np.uint8)

        # 混合回原圖
        x1, y1, x2, y2 = face_info["bbox"]
        result = face_info["original_image"].copy()
        pred_face_resized = cv2.resize(pred_face, (x2 - x1, y2 - y1))
        result = self.get_image(result, pred_face_resized, [x1, y1, x2, y2])

        # 編碼為 JPEG
        _, jpeg_bytes = cv2.imencode(".jpg", result, [cv2.IMWRITE_JPEG_QUALITY, 85])
        return jpeg_bytes.tobytes()

    def generate_frames_stream(self, face_id: str, audio_iter):
        """串流生成唇形動畫幀
        audio_iter: 產生 PCM chunks 的 iterator
        yield: JPEG bytes（每幀）
        """
        for audio_chunk in audio_iter:
            try:
                frame = self.generate_frame(face_id, audio_chunk)
                yield frame
            except Exception as e:
                logger.error(f"幀生成失敗: {e}")
                continue

    def remove_face(self, face_id: str):
        """移除臉部快取"""
        if face_id in self.face_cache:
            del self.face_cache[face_id]
            logger.info(f"臉部快取已移除: {face_id}")
