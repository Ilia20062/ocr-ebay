# OCR CRM — eBay Relisting Automation

> Photograph your inventory. Let the machine handle the rest.

An OCR-driven CRM that transforms product photo dumps into live eBay listings — automatically grouping images by capture time, extracting part numbers via multi-engine OCR and barcode scanning, validating against live eBay search, generating AI descriptions, and publishing through the Sell APIs with one click.

Available as a **web app** (Vercel) or a **native Windows desktop app** (Electron `.exe`).

---

## ✨ Features

| | Feature | Detail |
|---|---|---|
| 📸 | **Smart Image Grouping** | Clusters photos into product batches by filename timestamp (15 s gap · 4 s retake detection) |
| 🔍 | **Multi-Engine OCR** | Barcode pre-pass → PaddleOCR sidecar → Tesseract.js pool → Google Vision fallback |
| 🏷️ | **Part-Number Consensus** | Promotes codes seen in ≥ 2 images; re-ranks against live eBay Browse API hit count |
| 🤖 | **AI Descriptions** | OpenRouter generates listing copy from extracted product data |
| 🛒 | **One-Click Publish** | eBay Inventory + Offer Sell APIs; auto-enrolls in Selling Policy Management |
| 👤 | **Human-in-the-loop** | Every detected code requires explicit approval — nothing auto-publishes |
| 🖥️ | **Desktop App** | Ships as a Windows NSIS installer via Electron + Next.js standalone output |
| 🔐 | **Secure Token Storage** | eBay OAuth tokens encrypted at rest with AES-256-GCM |

---

## 🏗️ Architecture

```
Upload folder of product photos
          │
          ▼
┌─────────────────────────────────┐
│  Time Clustering  (15 s gap)    │  ← filename-encoded capture timestamps
│  [Batch 1]  [Batch 2]  [...]   │
└─────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  OCR Pipeline  (per batch)      │
│  1. Barcode scan  (@zxing)      │  → wins immediately if found (conf 1.0)
│  2. PaddleOCR sidecar           │  → optional FastAPI service
│  3. Tesseract.js  (pool × 4)    │  → in-process fallback
│  4. Google Vision               │  → weak-candidate fallback
└─────────────────────────────────┘
          │  part-number candidates
          ▼
┌─────────────────────────────────┐
│  eBay Browse API validation     │  re-ranks candidates by search hit count
└─────────────────────────────────┘
          │  best candidate
          ▼
     👤  User reviews & confirms
          │
          ▼
┌─────────────────────────────────┐
│  Draft  →  Publish              │
│  PUT  inventory_item            │  eBay Inventory API
│  POST offer                     │  eBay Offer API
│  POST offer/{id}/publish        │  → live listing URL
└─────────────────────────────────┘
```

### Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 + TypeScript |
| Database | Supabase Postgres — RLS, triggers, 7 migrations |
| Auth | Supabase Auth + eBay OAuth 2.0 |
| OCR | Tesseract.js 7 · PaddleOCR (FastAPI) · Google Cloud Vision · @zxing/library |
| AI | OpenRouter API |
| Styling | Tailwind CSS v4 · Radix UI primitives |
| Desktop | Electron 34 · electron-builder (Windows NSIS) |
| Deployment | Vercel (primary) · Railway (alternative) |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js ≥ 20.9.0**
- Supabase project
- eBay Developer account (Sandbox or Production)

### 1 — Clone & install

```bash
git clone https://github.com/<your-org>/ocr-crm.git
cd ocr-crm
npm install
```

### 2 — Configure environment

```bash
cp .env.example .env.local
```

Required variables in `.env.local`:

```env
# ── Supabase ────────────────────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# ── eBay ────────────────────────────────────────────────────────────────
EBAY_CLIENT_ID=<client-id>
EBAY_CLIENT_SECRET=<client-secret>
EBAY_RUNAME=<runame>
EBAY_ENVIRONMENT=sandbox          # sandbox | production
EBAY_MARKETPLACE_ID=EBAY_US

# ── Security ────────────────────────────────────────────────────────────
ENCRYPTION_KEY=<64 hex chars>     # openssl rand -hex 32
CRON_SECRET=<random string>

# ── AI ──────────────────────────────────────────────────────────────────
OPENROUTER_API_KEY=<key>

# ── App ─────────────────────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=http://localhost:3000

# ── Optional: PaddleOCR sidecar ─────────────────────────────────────────
PADDLE_OCR_URL=https://<your-service>/ocr
PADDLE_OCR_TOKEN=<token>

# ── Optional: Google Vision fallback ────────────────────────────────────
GOOGLE_VISION_API_KEY=<key>
```

### 3 — Push database migrations

```bash
npx supabase db push
```

### 4 — Start dev server

```bash
npm run dev      # Turbopack at http://localhost:3000
```

---

## 🖥️ Desktop App (Windows)

```bash
# Run against the live dev server
npm run electron:dev

# Build a standalone Windows installer → /release
npm run dist
```

The NSIS installer adds a desktop shortcut and Start Menu entry.

---

## 🧪 Offline Dry-Run

Validate grouping and OCR logic against a local image folder — no UI, no database:

```bash
node scripts/grouping-dryrun.mjs "C:/path/to/images" --concurrency=4

# Skip OCR (layout analysis only)
node scripts/grouping-dryrun.mjs "C:/path/to/images" --no-ocr

# Custom timing thresholds
node scripts/grouping-dryrun.mjs "C:/path/to/images" \
  --gap-ms=15000 \
  --jpg-retake-ms=4000
```

Results are written to `grouping-report.json`.

---

## 📁 Project Structure

```
src/
├── app/
│   ├── (auth)/              # Login / signup — public layout
│   ├── (dashboard)/         # Auth-gated app shell + UploadProgressWidget
│   └── api/
│       ├── upload-sessions/ # Session state machine (uploading→review_ready)
│       ├── listings/        # Draft creation + publish endpoint
│       └── cron/            # Token refresh sweep · retry queue
├── lib/
│   ├── ebay/                # OAuth, client, inventory, search, policies, auto-list
│   ├── ocr/                 # Tesseract pool, PaddleOCR, barcode, group resolver
│   ├── grouping/            # timeCluster.ts — filename timestamp clustering
│   ├── supabase/            # server / admin / browser client helpers
│   ├── encryption.ts        # AES-256-GCM token encryption
│   ├── log.ts               # Structured contextual logger
│   └── retry.ts             # Exponential back-off queue [5, 15, 60 min]
├── types/                   # Database enums, eBay API types
└── components/              # Radix UI + Tailwind component library

paddle-ocr/                  # Python FastAPI OCR sidecar (optional)
supabase/migrations/         # 001_initial_schema → 007_upload_sessions
scripts/                     # grouping-dryrun.mjs
electron/                    # Electron main process
```

---

## 🔄 End-to-End Workflow

1. **Upload** — drag a folder into the UI; a concurrent upload pipeline fans out requests and tracks live session progress.
2. **Group** — `clusterByTime` splits images into product batches using filename-encoded timestamps.
3. **OCR** — `TesseractPool` (default concurrency 4) processes each batch; barcode scan short-circuits when a code can be decoded directly.
4. **Validate** — OCR candidates are re-ranked by live eBay Browse API search hit count.
5. **Review** — every batch surfaces in the review queue; users confirm or override the suggested code.
6. **Draft** — AI description generated; a `status='draft'` listing row is persisted locally — **no eBay call yet**.
7. **Publish** — user clicks **Publish to eBay** on `/listings`; image URLs are re-signed and the Inventory + Offer APIs are called.

---

## 🚢 Deployment

### Vercel

```bash
npm i -g vercel
vercel env pull        # sync env vars from Vercel dashboard
vercel deploy --prod
```

Automated cron jobs (`vercel.json`):

| Schedule | Route | Purpose |
|---|---|---|
| Every 5 min | `/api/cron/retry` | Process retry queue (exponential back-off) |
| Hourly | `/api/cron/refresh-tokens` | Proactive eBay token refresh |

### Railway (alternative)

A `railway.json` is included — set the same environment variables in the Railway dashboard and deploy.

### PaddleOCR Sidecar

See [`paddle-ocr/README.md`](paddle-ocr/README.md) for Docker + Railway deployment steps.

---

## 🔒 Security

- eBay tokens encrypted at rest — AES-256-GCM via `ENCRYPTION_KEY`
- Service-role Supabase client enforces explicit `user_id` ownership on every write
- Cron routes protected by `CRON_SECRET` bearer token
- Row-Level Security policies enforced at the Postgres layer
- **No listing auto-publishes** — human approval is a hard requirement

---

## 📜 License

Private / proprietary. All rights reserved.

---

<p align="center">
  Built with&nbsp;
  <a href="https://nextjs.org">Next.js</a>&nbsp;·&nbsp;
  <a href="https://supabase.com">Supabase</a>&nbsp;·&nbsp;
  <a href="https://developer.ebay.com">eBay Sell APIs</a>&nbsp;·&nbsp;
  <a href="https://tesseract.projectnaptha.com">Tesseract.js</a>
</p>
