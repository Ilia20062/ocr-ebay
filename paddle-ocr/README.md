# PaddleOCR Sidecar

A small FastAPI microservice that wraps [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) so the Next.js app (running on Vercel or Railway) can call it over HTTP. PaddleOCR is noticeably more accurate than Tesseract on the kinds of labels this project deals with (molded plastic codes, embossed metal, small printed serials).

## API

`POST /ocr`
- Body: raw image bytes (`image/jpeg`, `image/png`, `image/webp`, or `application/octet-stream`).
- Header (optional): `Authorization: Bearer <PADDLE_OCR_TOKEN>`.
- Response: `{ "text": string, "words": [{ "text": string, "confidence": number }] }`.

`GET /healthz` → `{ "ok": true }` (Railway healthcheck).
`GET /` → status + auth-required flag.

## Deploy to Railway

1. From this folder, link a Railway project:
   ```bash
   railway login
   railway init       # in the paddle-ocr/ directory
   railway up         # builds the Dockerfile and deploys
   ```
2. In the Railway dashboard, set environment variables:
   - `PADDLE_OCR_TOKEN` — any long random string. Required if you want the service to reject unauthenticated requests. Recommended.
   - `PADDLE_LANG` — language code. Default `en`. Use `ml` for multilingual labels.
3. Note the public URL (`https://<name>.up.railway.app`).
4. On the **main app** side (Vercel or Railway), set:
   - `PADDLE_OCR_URL=https://<name>.up.railway.app`
   - `PADDLE_OCR_TOKEN=<same token>`
   That's it — `recognizeWithFallback` automatically prefers Paddle when `PADDLE_OCR_URL` is set, and silently falls back to Tesseract otherwise.

## Resource sizing

- Builds to a ~2 GB image (paddlepaddle + paddleocr + models).
- Idle RAM: ~600 MB.
- Per-request RAM: ~200-400 MB depending on image size.
- Latency: 200-800 ms on a small Railway box for typical phone-camera label shots.
- Suggested plan: any Railway tier with ≥1 GB RAM is fine.

## Local test

```bash
# Build & run
docker build -t paddle-ocr .
docker run --rm -p 8080:8080 -e PADDLE_OCR_TOKEN=devtoken paddle-ocr

# Hit it
curl -X POST http://localhost:8080/ocr \
  -H "Authorization: Bearer devtoken" \
  -H "Content-Type: image/jpeg" \
  --data-binary @./label.jpg | jq
```
