FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

WORKDIR /workspace

# 系統依賴
RUN apt-get update && apt-get install -y ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*

# Python 依賴
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製服務程式碼
COPY . /workspace/gpu_service/

# 建立目錄
RUN mkdir -p /workspace/models /workspace/uploads /workspace/outputs

ENV MODEL_DIR=/workspace/models
ENV UPLOAD_DIR=/workspace/uploads
ENV OUTPUT_DIR=/workspace/outputs

EXPOSE 8001

CMD ["uvicorn", "gpu_service.main:app", "--host", "0.0.0.0", "--port", "8001"]
