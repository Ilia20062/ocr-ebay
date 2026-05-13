"""
PaddleOCR microservice for the OCR-CRM project.

Endpoint:
  POST /ocr
    Content-Type: image/jpeg | image/png | image/webp | application/octet-stream
    Body: raw image bytes
    Returns: { text: str, words: [{ text: str, confidence: float }] }

Auth:
  When PADDLE_OCR_TOKEN env var is set, the service requires
  `Authorization: Bearer <token>` on every request. Match this with the same
  env var on the Node side (see src/lib/ocr/paddle.ts).

Why FastAPI: single-file, async, easy to deploy on Railway/Fly/Render. The
PaddleOCR model loads once at startup and is reused across requests.
"""

import io
import logging
import os
import time
from typing import Optional

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
from paddleocr import PaddleOCR

LOG = logging.getLogger("paddle-ocr")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")

# ── one-time model load ───────────────────────────────────────────────────────
# - `use_angle_cls=True` handles rotated labels (very common with phone photos).
# - `lang="en"` keeps the model small; switch to "ml" (multilingual) if needed.
# - Models download to ~/.paddleocr on first call (~50-150 MB). Cache survives
#   container restarts because Railway persists the home dir.
LOG.info("loading PaddleOCR model …")
_t0 = time.time()
_ocr = PaddleOCR(use_angle_cls=True, lang=os.environ.get("PADDLE_LANG", "en"), show_log=False)
LOG.info("model loaded in %.1fs", time.time() - _t0)

_TOKEN = os.environ.get("PADDLE_OCR_TOKEN") or None

app = FastAPI(title="ocr-crm-paddle", version="1.0.0")


# ── helpers ───────────────────────────────────────────────────────────────────
def _check_auth(authorization: Optional[str]) -> None:
    """Bearer-token check. No-op when PADDLE_OCR_TOKEN is unset."""
    if not _TOKEN:
        return
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    if authorization[7:].strip() != _TOKEN:
        raise HTTPException(status_code=401, detail="Bad bearer token")


def _decode_image(raw: bytes) -> np.ndarray:
    """Bytes → RGB ndarray (Paddle expects HxWx3, uint8)."""
    img = Image.open(io.BytesIO(raw))
    img = ImageOps.exif_transpose(img)  # honor EXIF orientation
    img = img.convert("RGB")
    return np.array(img)


def _run_paddle(img: np.ndarray) -> dict:
    """
    Run PaddleOCR and produce { text, words[] }.
    PaddleOCR returns a list of [box, (text, confidence)] tuples; we flatten.
    """
    result = _ocr.ocr(img, cls=True)

    # Paddle returns `[None]` for empty results. Normalize to [].
    lines = result[0] if result and result[0] else []
    words: list[dict] = []
    text_parts: list[str] = []
    for entry in lines:
        # entry = [box, (text, confidence)]
        if not entry or len(entry) < 2:
            continue
        payload = entry[1]
        if not isinstance(payload, (list, tuple)) or len(payload) < 2:
            continue
        text, confidence = payload[0], float(payload[1])
        if not text:
            continue
        words.append({"text": text, "confidence": confidence})
        text_parts.append(text)
    return {"text": "\n".join(text_parts), "words": words}


# ── routes ────────────────────────────────────────────────────────────────────
@app.get("/")
def root() -> dict:
    return {"status": "ok", "service": "ocr-crm-paddle", "auth_required": bool(_TOKEN)}


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/ocr")
async def ocr(request: Request, authorization: Optional[str] = Header(default=None)) -> JSONResponse:
    _check_auth(authorization)

    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty body")
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (>25 MB)")

    t_start = time.time()
    try:
        img = _decode_image(raw)
    except Exception as e:
        LOG.warning("decode failed: %s", e)
        raise HTTPException(status_code=400, detail=f"Cannot decode image: {e}")

    try:
        out = _run_paddle(img)
    except Exception as e:
        LOG.exception("paddle failed")
        raise HTTPException(status_code=500, detail=f"OCR failed: {e}")

    dur_ms = int((time.time() - t_start) * 1000)
    LOG.info("ocr ok bytes=%d w=%d h=%d words=%d dur_ms=%d",
             len(raw), img.shape[1], img.shape[0], len(out["words"]), dur_ms)
    return JSONResponse(out, headers={"X-OCR-Duration-Ms": str(dur_ms)})
