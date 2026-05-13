# PaddleOCR sidecar for ocr-crm.
# Slim image. PaddleOCR + paddlepaddle are large (~1.5GB once installed) but
# the resulting service runs comfortably on a small Railway / Fly box.

FROM python:3.10-slim

# System libs PaddleOCR/cv2/Pillow need on a slim base. ffmpeg is for image
# format coverage; libgl/libglib are for opencv-python that paddle pulls in.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 \
      libglib2.0-0 \
      libsm6 \
      libxext6 \
      libxrender1 \
      libgomp1 \
      ffmpeg \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so docker layer caching kicks in on code-only edits.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the English PaddleOCR models so the first request isn't a 15s
# cold start. The detection + recognition + classifier models together are
# ~10-15 MB compressed.
RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=True, lang='en', show_log=False)"

COPY main.py .

# Railway / Fly inject $PORT — default to 8080 for local docker runs.
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --timeout-keep-alive 60"]
