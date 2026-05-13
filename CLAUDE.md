# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Critical Reading Before Code

- **`AGENTS.md` is binding** — Next.js 16 + React 19 in this repo have breaking changes from your training data. Always consult `node_modules/next/dist/docs/` before writing route handlers, layouts, server components, or `searchParams` patterns. Heed deprecation notices.
- **Tesseract.js cannot be bundled.** It is declared in `next.config.ts → serverExternalPackages` and `src/lib/ocr/tesseract.ts` resolves `workerPath` / `corePath` from disk via `process.cwd()/node_modules/…`. Do NOT use `require.resolve` here — under Turbopack it returns virtual `[externals]/…` paths that `node:worker_threads` rejects. Never pass `undefined` to `workerPath` / `corePath`; the option must be omitted entirely when the file isn't on disk.

## Commands

```bash
npm run dev      # next dev (Turbopack)
npm run build    # next build
npm run start    # next start -p ${PORT:-3000}
npm run lint     # eslint (flat config: eslint.config.mjs)
```

No test runner is configured. The grouping pipeline has an offline dry-run script:

```bash
node scripts/grouping-dryrun.mjs "path/to/image/folder" [--no-ocr] [--concurrency=N] [--gap-ms=15000] [--jpg-retake-ms=4000]
```

This runs the real `clusterByTime` + Tesseract pool against a local folder and writes `grouping-report.json` — use it to validate clustering/OCR changes without going through the upload UI.

Node `>=20.9.0` required.

## High-Level Architecture

The product is an OCR-driven eBay relisting CRM. Workflow:

1. User uploads a folder of product images → backend auto-groups them by capture timestamp into "batches".
2. Tesseract OCR extracts a part-number candidate per batch (consensus across cluster).
3. User reviews every group in the queue and confirms/overrides the code (**never auto-approved — see `memory/project_no_auto_approve.md`**).
4. Approved code → eBay Browse API search → best-match selection → AI description (OpenRouter) → **draft** listing row.
5. User clicks "Publish to eBay" on `/listings` → Sell APIs (Inventory + Offer) → live listing.

### Key pipelines

**Upload Session pipeline** (`src/app/api/upload-sessions/[id]/process/route.ts`)
- Drives a state machine on `upload_sessions.status`: `uploading → grouping → processing → review_ready` (or `failed`).
- The route returns immediately; real work runs in `processSessionInBackground` (fire-and-forget after status flip).
- Two-phase OCR: `pickLabelCandidates` returns bare `.jpg` files first (the molded-code close-ups); only fall back to the wider cluster if phase 1 finds no code. This both saves Tesseract cycles AND avoids watermark false positives like "90 DAYS" from product PNGs.
- `TesseractPool` (`src/lib/ocr/pool.ts`) amortizes the ~1–3 s worker init across many images. Default concurrency = 4.

**Time clustering** (`src/lib/grouping/timeCluster.ts`)
- Filename-based capture timestamps (`parseCapturedAt`).
- Default gap `15 000 ms` (well above in-burst ~8 s, below inter-product ~17 s). A bare-`.jpg` followed by another `.jpg` within `4 000 ms` is treated as a retake of the same product. Images with no parseable timestamp form a trailing "orphan" cluster.

**Group resolver** (`src/lib/ocr/group-resolver.ts`)
- Buckets candidate codes across all OCR results in a batch. Prefers codes that appear in ≥2 distinct images (consensus); otherwise picks by best single-image confidence.

**eBay integration** (`src/lib/ebay/`)
- OAuth tokens stored AES-256-GCM-encrypted via `src/lib/encryption.ts` (requires `ENCRYPTION_KEY`).
- `token-manager.ts` auto-refreshes tokens 5 minutes before expiry; `cron/refresh-tokens` is a defensive sweep.
- `client.ts` injects fresh tokens + `X-EBAY-C-MARKETPLACE-ID` on every request and retries 429s with `Retry-After`.
- `policies.ts` auto-opts-in to `SELLING_POLICY_MANAGEMENT` on first publish.
- `auto-list.ts` has two distinct entry points: `autoCreateDraftListing` (does NOT contact eBay — just persists a `status='draft'` row) and `publishListing` (the Sell-API push, invoked only by an explicit user click). Image URLs are re-signed at publish time because signed URLs from draft creation expire.
- `validate-candidates.ts` re-ranks OCR candidates by eBay Browse-API match count; the session-process pipeline calls it after `resolveGroupCode` so that a candidate with more eBay hits can be promoted over the OCR winner. Silent no-op when the user has no eBay connection.

**OCR providers** (`src/lib/ocr/`)
- `pool.ts:recognizeWithFallback` runs a fixed pipeline per image:
  1. **Barcode pre-pass** (`barcode.ts`, `@zxing/library` + `sharp`) — decodes EAN/UPC/Code128/QR/DataMatrix. If a barcode is present, it wins with confidence 1.0 and we skip OCR entirely.
  2. **Primary OCR** — PaddleOCR sidecar if `PADDLE_OCR_URL` is set (`paddle.ts` posts the buffer to the FastAPI service in `paddle-ocr/`), otherwise in-process Tesseract.
  3. **Google Vision fallback** if `GOOGLE_VISION_API_KEY` is set and primary returned no/weak candidates.
- The candidate extractor (`code-extractor.ts:isWatermark`) rejects warranty stamps (`90DAYS`), dates (`11/06/15`), times, version strings, and a literal blacklist of dataset-specific scraps. Keep `scripts/grouping-dryrun.mjs` in sync if you change the patterns.
- PaddleOCR sidecar is a separate deployable in `paddle-ocr/` (Dockerfile + Railway config). See `paddle-ocr/README.md` for deploy steps.

**Retry queue** (`src/lib/retry.ts` + `src/app/api/cron/retry/route.ts`)
- Exponential backoff `[5, 15, 60]` minutes, max attempts before `exhausted`.
- Vercel cron (`vercel.json`) hits `/api/cron/retry` every 5 min and `/api/cron/refresh-tokens` hourly. Both routes are guarded by `withCron` (Bearer `CRON_SECRET`).

### Cross-cutting infra

- **Auth/route guards:** `src/lib/middleware.ts` exports `withAuth(handler)` (Supabase session required, injects `userId` and resolved `params`) and `withCron(handler)` (Bearer `CRON_SECRET`). Use these — do NOT call `supabase.auth.getUser()` manually inside route handlers.
- **Supabase clients:** `lib/supabase/server.ts` for SSR cookies, `lib/supabase/admin.ts` (service-role) for background work and writes from API routes, `lib/supabase/client.ts` for the browser. Service-role client bypasses RLS — ownership must be enforced in code (`.eq('user_id', userId)`).
- **Logging:** `src/lib/log.ts` — use `withContext({ scope, user_id, session_id, batch_id, … })` at the top of any handler/background task so structured fields flow into every line. Errors include stack traces automatically. Prefer this over `console.log`.
- **Validation:** Zod schemas live in `src/lib/validators/`. Per-batch image cap = 24; per-session cap = 300; max 10 MB per file (`MAX_IMAGES_PER_BATCH`, `MAX_IMAGES_PER_SESSION`).
- **Path alias:** `@/*` → `./src/*` (`tsconfig.json`).

### Routing layout (App Router)

- `src/app/(auth)/…` — public login/signup, separate layout.
- `src/app/(dashboard)/…` — auth-gated layout (`(dashboard)/layout.tsx` does the `redirect('/login')` and wraps everything in `UploadSessionProvider` + the `UploadProgressWidget` so an in-flight upload stays visible across navigations).
- `src/app/api/…` — route handlers.
- `src/app/privacy/page.tsx` — public.

### Database

Supabase Postgres. Schema lives in `supabase/migrations/001..007_*.sql`. Key tables:
- `profiles`, `ebay_connections` (encrypted tokens)
- `upload_sessions` → `upload_batches` → `images` → `ocr_results`
- `product_searches` (eBay Browse results) → `listings` (drafts + live)
- `retry_queue` (typed `entity_type`: `image | product_search | listing`)
- `audit_logs`

Status enums are in `src/types/database.ts` — keep these in sync with migrations.

### Deployment

- **Vercel** is primary (`vercel.json` defines the two crons). `NEXT_PUBLIC_APP_URL`, `EBAY_CLIENT_ID/SECRET/RUNAME`, `EBAY_ENVIRONMENT` (`sandbox|production`), `EBAY_MARKETPLACE_ID`, `ENCRYPTION_KEY` (64 hex chars), `CRON_SECRET`, `OPENROUTER_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are required at minimum. Optional: `PADDLE_OCR_URL` + `PADDLE_OCR_TOKEN` (PaddleOCR sidecar), `GOOGLE_VISION_API_KEY` (Vision fallback).
- **Railway** config exists (`railway.json`) as an alternative — uses `npm run start` with `PORT` injected.
- `next.config.ts` whitelists `*.supabase.co/storage/v1/object/sign/**` for `next/image`.
