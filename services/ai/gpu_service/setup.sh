#!/bin/bash
# AI Avatar GPU Service — RunPod 一鍵安裝腳本
# 在 RunPod SSH 裡執行: bash setup.sh

set -e

echo "=========================================="
echo "  AI Avatar GPU Service 安裝"
echo "=========================================="

WORKSPACE="/workspace"
cd $WORKSPACE

# 1. 安裝系統依賴
echo ""
echo "--- 安裝系統依賴 ---"
apt-get update && apt-get install -y ffmpeg libsndfile1

# 2. 安裝 Python 依賴
echo ""
echo "--- 安裝基本 Python 依賴 ---"
pip install fastapi uvicorn torch torchaudio numpy opencv-python-headless pydantic python-multipart

# 3. 安裝 CosyVoice 2.0
echo ""
echo "--- 安裝 CosyVoice 2.0 ---"
if [ ! -d "$WORKSPACE/CosyVoice" ]; then
    git clone https://github.com/FunAudioLLM/CosyVoice.git
    cd CosyVoice
    pip install -r requirements.txt

    # 下載預訓練模型
    echo "下載 CosyVoice 預訓練模型..."
    pip install modelscope
    python -c "
from modelscope import snapshot_download
snapshot_download('iic/CosyVoice2-0.5B', local_dir='pretrained_models/CosyVoice2-0.5B')
"
    cd $WORKSPACE
else
    echo "CosyVoice 已存在，跳過"
fi

# 4. 安裝 Wav2Lip
echo ""
echo "--- 安裝 Wav2Lip ---"
if [ ! -d "$WORKSPACE/Wav2Lip" ]; then
    git clone https://github.com/Rudrabha/Wav2Lip.git
    cd Wav2Lip
    pip install -r requirements.txt

    # 下載 face detection 模型
    mkdir -p face_detection/detection/sfd
    wget -q "https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth" \
        -O face_detection/detection/sfd/s3fd_face_detector.pth

    # 提醒用戶下載 Wav2Lip 模型
    mkdir -p checkpoints
    echo ""
    echo "WARNING: 你需要手動下載 Wav2Lip 模型："
    echo "   1. 去 https://github.com/Rudrabha/Wav2Lip#getting-the-weights"
    echo "   2. 下載 wav2lip_gan.pth"
    echo "   3. 放到 $WORKSPACE/Wav2Lip/checkpoints/wav2lip_gan.pth"
    echo ""
    cd $WORKSPACE
else
    echo "Wav2Lip 已存在，跳過"
fi

# 5. 複製 GPU 服務程式碼
echo ""
echo "--- 設定 GPU 服務 ---"
mkdir -p $WORKSPACE/gpu_service
# 程式碼需要從 git clone 或手動複製

# 6. 建立啟動腳本
cat > $WORKSPACE/start_gpu_service.sh << 'SCRIPT'
#!/bin/bash
cd /workspace
export MODEL_DIR=/workspace/models
export UPLOAD_DIR=/workspace/uploads
export OUTPUT_DIR=/workspace/outputs
export PYTHONPATH=/workspace/CosyVoice:/workspace/Wav2Lip:$PYTHONPATH
mkdir -p $MODEL_DIR $UPLOAD_DIR $OUTPUT_DIR

echo "啟動 GPU AI Service on port 8001..."
cd /workspace/gpu_service
uvicorn main:app --host 0.0.0.0 --port 8001 --workers 1
SCRIPT
chmod +x $WORKSPACE/start_gpu_service.sh

echo ""
echo "=========================================="
echo "  安裝完成！"
echo "  啟動服務: bash /workspace/start_gpu_service.sh"
echo "=========================================="
