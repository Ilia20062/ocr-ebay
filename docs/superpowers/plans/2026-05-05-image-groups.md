# Image Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert per-image upload/listing flow into per-group flow: 1–24 images of the same item produce one eBay listing with all images attached, after human review of the OCR-detected serial.

**Architecture:** `upload_batches` table is repurposed as the group entity. OCR runs on every image; a pure-function resolver picks a winning code (consensus first, else highest confidence). The whole group goes to a single review card. Approval triggers eBay search + listing with all image URLs attached.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres + Storage, Zod, Tailwind, eBay Inventory API.

**Note on tests:** Repo has no test framework configured (`package.json`). Plan validates via TypeScript compilation, manual smoke testing in the dev server, and inline assertion comments in pure-function modules. Adding vitest is out of scope for this plan and tracked as future work.

**Spec:** `docs/superpowers/specs/2026-05-05-image-groups-design.md`

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/006_image_groups.sql`

- [ ] **Step 1: Write migration SQL**

Create `supabase/migrations/006_image_groups.sql`:

```sql
-- 006_image_groups.sql
-- Repurpose upload_batches as the group entity.
-- Wipes dev data in ocr_results / product_searches / listings (cascades from images).

BEGIN;

-- Wipe downstream data (cascade from images via FK)
TRUNCATE listings, product_searches, ocr_results, images, upload_batches CASCADE;

-- Extend upload_batches with group fields
ALTER TABLE upload_batches
  ADD COLUMN IF NOT EXISTS winning_ocr_result_id UUID REFERENCES ocr_results(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS final_code TEXT;

-- Extend status enum
ALTER TABLE upload_batches
  DROP CONSTRAINT IF EXISTS upload_batches_status_check;
ALTER TABLE upload_batches
  ADD CONSTRAINT upload_batches_status_check
  CHECK (status IN ('pending','processing','awaiting_review','approved','listed','failed','discarded'));

-- product_searches now hangs off the batch, not a single ocr_result
ALTER TABLE product_searches
  DROP CONSTRAINT IF EXISTS product_searches_ocr_result_id_fkey;
ALTER TABLE product_searches
  DROP COLUMN IF EXISTS ocr_result_id;
ALTER TABLE product_searches
  ADD COLUMN batch_id UUID NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  ADD CONSTRAINT product_searches_batch_unique UNIQUE (batch_id);

CREATE INDEX IF NOT EXISTS product_searches_batch_id_idx ON product_searches(batch_id);
CREATE INDEX IF NOT EXISTS upload_batches_status_idx ON upload_batches(status);
CREATE INDEX IF NOT EXISTS upload_batches_winning_ocr_idx ON upload_batches(winning_ocr_result_id);

COMMIT;
```

- [ ] **Step 2: Apply migration to dev database**

Run: `npx supabase db push` (or whatever local apply mechanism the repo uses; if unsure, check `supabase/` README or commit history for prior migration application).

Expected: migration runs without error. Dev data is wiped.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/006_image_groups.sql
git commit -m "feat(db): add image-groups schema (006)"
```

---

## Task 2: Update TypeScript database types

**Files:**
- Modify: `src/types/database.ts`
- Modify: `src/types/supabase.ts` (hand-edit; spec says regenerate is optional)

- [ ] **Step 1: Update `src/types/database.ts`**

Replace the `BatchStatus` and `UploadBatch` and `ProductSearch` blocks:

```ts
export type BatchStatus =
  | 'pending'
  | 'processing'
  | 'awaiting_review'
  | 'approved'
  | 'listed'
  | 'failed'
  | 'discarded'

export interface UploadBatch {
  id: string
  user_id: string
  status: BatchStatus
  total_images: number
  processed: number
  winning_ocr_result_id: string | null
  final_code: string | null
  created_at: string
  updated_at: string
}

export interface ProductSearch {
  id: string
  batch_id: string
  search_query: string
  search_provider: string
  status: SearchStatus
  result_count: number | null
  results_raw: Json | null
  selected_item_id: string | null
  error_message: string | null
  attempt_count: number
  created_at: string
  updated_at: string
}
```

- [ ] **Step 2: Update `src/types/supabase.ts` to match**

Open `src/types/supabase.ts` and:
- In `Tables.upload_batches.Row`/`Insert`/`Update`, add `winning_ocr_result_id: string | null` and `final_code: string | null`. Update `status` literal union.
- In `Tables.product_searches.Row`/`Insert`/`Update`, remove `ocr_result_id`, add `batch_id: string`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: errors in files that still reference `product_searches.ocr_result_id` (process route, ocr-results PATCH route, listings POST route). These will be fixed in later tasks.

- [ ] **Step 4: Commit**

```bash
git add src/types/database.ts src/types/supabase.ts
git commit -m "feat(types): batch group fields + product_searches.batch_id"
```

---

## Task 3: Pure-function group resolver

**Files:**
- Create: `src/lib/ocr/group-resolver.ts`

- [ ] **Step 1: Write the module**

```ts
// src/lib/ocr/group-resolver.ts
import type { OcrCandidate } from '@/types/ocr'

export interface GroupResolverInput {
  ocrResults: Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }>
}

export interface GroupResolverAlternative {
  code: string
  ocrResultId: string
  imageId: string
  confidence: number
}

export interface GroupResolverOutput {
  winningOcrResultId: string | null
  winningImageId: string | null
  winningCode: string | null
  winningConfidence: number | null
  hadConsensus: boolean
  alternatives: GroupResolverAlternative[]
}

interface CandidateBucket {
  text: string
  appearances: Array<{ ocrResultId: string; imageId: string; confidence: number }>
  bestConfidence: number
  sumConfidence: number
  imagesSeen: Set<string>
}

const DUPLICATE_SENTINEL = '__DUPLICATE__'

function bucketCandidates(input: GroupResolverInput): Map<string, CandidateBucket> {
  const buckets = new Map<string, CandidateBucket>()
  for (const r of input.ocrResults) {
    const seen = new Set<string>()
    for (const c of r.all_candidates ?? []) {
      if (!c?.text || c.text === DUPLICATE_SENTINEL) continue
      // dedupe within a single image's candidates
      if (seen.has(c.text)) continue
      seen.add(c.text)

      let b = buckets.get(c.text)
      if (!b) {
        b = { text: c.text, appearances: [], bestConfidence: 0, sumConfidence: 0, imagesSeen: new Set() }
        buckets.set(c.text, b)
      }
      b.appearances.push({ ocrResultId: r.id, imageId: r.image_id, confidence: c.confidence ?? 0 })
      b.bestConfidence = Math.max(b.bestConfidence, c.confidence ?? 0)
      b.sumConfidence += c.confidence ?? 0
      b.imagesSeen.add(r.image_id)
    }
  }
  return buckets
}

export function resolveGroupCode(input: GroupResolverInput): GroupResolverOutput {
  const buckets = bucketCandidates(input)
  if (buckets.size === 0) {
    return {
      winningOcrResultId: null,
      winningImageId: null,
      winningCode: null,
      winningConfidence: null,
      hadConsensus: false,
      alternatives: [],
    }
  }

  const all = [...buckets.values()]
  const consensusBuckets = all.filter((b) => b.imagesSeen.size >= 2)

  let winner: CandidateBucket
  let hadConsensus: boolean

  if (consensusBuckets.length > 0) {
    // Highest sum-of-confidences among consensus candidates
    consensusBuckets.sort((a, b) => b.sumConfidence - a.sumConfidence || b.bestConfidence - a.bestConfidence)
    winner = consensusBuckets[0]
    hadConsensus = true
  } else {
    // No consensus: highest single confidence wins
    all.sort((a, b) => b.bestConfidence - a.bestConfidence || b.sumConfidence - a.sumConfidence)
    winner = all[0]
    hadConsensus = false
  }

  // Source = appearance with the highest confidence within the winning bucket
  const winningAppearance = [...winner.appearances].sort((a, b) => b.confidence - a.confidence)[0]

  // Build alternatives: every other bucket's best appearance
  const alternatives: GroupResolverAlternative[] = all
    .filter((b) => b.text !== winner.text)
    .map((b) => {
      const top = [...b.appearances].sort((x, y) => y.confidence - x.confidence)[0]
      return {
        code: b.text,
        ocrResultId: top.ocrResultId,
        imageId: top.imageId,
        confidence: top.confidence,
      }
    })
    .sort((a, b) => b.confidence - a.confidence)

  return {
    winningOcrResultId: winningAppearance.ocrResultId,
    winningImageId: winningAppearance.imageId,
    winningCode: winner.text,
    winningConfidence: winner.bestConfidence,
    hadConsensus,
    alternatives,
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit src/lib/ocr/group-resolver.ts`
Expected: clean.

- [ ] **Step 3: Smoke check by inspection**

Open the file and trace through these mental scenarios; the code should produce these outputs:

| Scenario | Expected `winningCode` | `hadConsensus` |
| -- | -- | -- |
| Empty `ocrResults: []` | null | false |
| Single result with one candidate "ABC" conf 0.5 | "ABC" | false |
| Two results both candidate "XYZ" (one 0.4, one 0.7) | "XYZ" | true |
| Two results, A: "AAA" 0.95, B: "BBB" 0.9 (no overlap) | "AAA" | false |
| Three results: A&B agree on "QQQ" 0.5/0.5, C: "ZZZ" 0.99 | "QQQ" | true |

If any line above wouldn't match, fix the code first.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ocr/group-resolver.ts
git commit -m "feat(ocr): group resolver picks winning code across images"
```

---

## Task 4: Image URL helper for eBay

**Files:**
- Create: `src/lib/ebay/image-urls.ts`

- [ ] **Step 1: Write the module**

```ts
// src/lib/ebay/image-urls.ts
import type { getSupabaseAdminClient } from '@/lib/supabase/admin'

type Db = ReturnType<typeof getSupabaseAdminClient>

const SIGNED_URL_TTL_SECONDS = 60 * 60 // 1 hour — eBay fetches at publish time
const EBAY_MAX_IMAGES = 24

export async function generateListingImageUrls(
  db: Db,
  images: Array<{ id: string; storage_path: string }>,
): Promise<string[]> {
  const limited = images.slice(0, EBAY_MAX_IMAGES)
  const urls: string[] = []

  for (const img of limited) {
    const { data, error } = await db.storage
      .from('images')
      .createSignedUrl(img.storage_path, SIGNED_URL_TTL_SECONDS)
    if (error || !data?.signedUrl) {
      console.warn(`[image-urls] could not sign ${img.storage_path}: ${error?.message ?? 'no url'}`)
      continue
    }
    urls.push(data.signedUrl)
  }

  return urls
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ebay/image-urls.ts
git commit -m "feat(ebay): helper to generate signed image URLs for listings"
```

---

## Task 5: Extend eBay inventory + auto-list to accept image URLs

**Files:**
- Modify: `src/types/ebay.ts`
- Modify: `src/lib/ebay/inventory.ts`
- Modify: `src/lib/ebay/auto-list.ts`

- [ ] **Step 1: Add `imageUrls` to `EbayInventoryItem.product` in `src/types/ebay.ts`**

Replace the `EbayInventoryItem` interface:

```ts
export interface EbayInventoryItem {
  sku: string
  product: {
    title: string
    description: string
    aspects?: Record<string, string[]>
    imageUrls?: string[]
  }
  condition: string
  availability: {
    shipToLocationAvailability: { quantity: number }
  }
}
```

- [ ] **Step 2: Update `createAndPublishListing` in `src/lib/ebay/inventory.ts`**

Add `imageUrls` to `CreateListingParams` and into the payload:

```ts
interface CreateListingParams {
  userId: string
  sku: string
  title: string
  description: string
  price: number
  currency: string
  quantity: number
  condition: string
  categoryId: string
  fulfillmentPolicyId: string
  paymentPolicyId: string
  returnPolicyId: string
  imageUrls: string[]  // NEW — empty array allowed
}
```

In the function body, change the `inventoryItem` build:

```ts
const inventoryItem: EbayInventoryItem = {
  sku,
  product: {
    title,
    description,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
  },
  condition: condition.toUpperCase().replace(/\s/g, '_'),
  availability: { shipToLocationAvailability: { quantity } },
}
```

And destructure `imageUrls` from `params` at the top of the function.

- [ ] **Step 3: Update `autoCreateListing` in `src/lib/ebay/auto-list.ts`**

Add `imageUrls: string[]` to `AutoListParams`:

```ts
interface AutoListParams {
  userId: string
  searchId: string
  bestMatch: EbayItemSummary
  imageUrls: string[]  // NEW
}
```

Destructure it: `export async function autoCreateListing({ userId, searchId, bestMatch, imageUrls }: AutoListParams)`.

In the call to `createAndPublishListing`, pass it through:

```ts
const { listingId, listingUrl } = await createAndPublishListing({
  userId,
  sku,
  title,
  description: `${title} - Listed automatically via OCR-CRM`,
  price,
  currency,
  quantity: 1,
  condition,
  categoryId,
  fulfillmentPolicyId: policies.fulfillmentPolicyId,
  paymentPolicyId: policies.paymentPolicyId,
  returnPolicyId: policies.returnPolicyId,
  imageUrls,
})
```

Also add a log line near the top of the function:

```ts
log(steps, 'Image URLs', 'ok', `${imageUrls.length} image(s) attached to listing`)
```

- [ ] **Step 4: Update other callers of `createAndPublishListing`**

Search for callers: `npx tsc --noEmit` will surface them. The other caller is `src/app/api/listings/route.ts` (the manual-create POST). For that route, pass `imageUrls: []` for now (manual create flow is not in scope for the new feature):

```ts
const { listingId, listingUrl } = await createAndPublishListing({
  userId,
  sku,
  title: data.title,
  description: data.description ?? '',
  price: data.price,
  currency: data.currency,
  quantity: data.quantity,
  condition: data.condition,
  categoryId: data.category_id,
  fulfillmentPolicyId: data.fulfillment_policy_id,
  paymentPolicyId: data.payment_policy_id,
  returnPolicyId: data.return_policy_id,
  imageUrls: [],
})
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/types/ebay.ts`, `src/lib/ebay/inventory.ts`, `src/lib/ebay/auto-list.ts`, `src/app/api/listings/route.ts`. Errors in `src/app/api/ocr-results/[id]/route.ts` and process route are fine — fixed later.

- [ ] **Step 6: Commit**

```bash
git add src/types/ebay.ts src/lib/ebay/inventory.ts src/lib/ebay/auto-list.ts src/app/api/listings/route.ts
git commit -m "feat(ebay): pass imageUrls through inventory + auto-list"
```

---

## Task 6: Update validators

**Files:**
- Modify: `src/lib/validators/upload.ts`
- Modify: `src/lib/validators/ocr.ts`
- Create: schema in `src/lib/validators/upload.ts` for batch review (or new file)

- [ ] **Step 1: Update `src/lib/validators/upload.ts`**

Replace contents:

```ts
import { z } from 'zod'

export const MAX_IMAGES_PER_BATCH = 24

export const presignSchema = z.object({
  batch_id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']),
  file_size_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
})

export const confirmSchema = z.object({
  image_id: z.string().uuid(),
  batch_id: z.string().uuid(),
  storage_path: z.string().min(1),
  original_filename: z.string().optional(),
  file_size_bytes: z.number().int().optional(),
  mime_type: z.string().optional(),
})

export const batchReviewSchema = z
  .object({
    action: z.enum(['approve', 'override', 'discard']),
    manual_override: z.string().min(1).max(100).optional(),
  })
  .refine(
    (d) => d.action !== 'override' || !!d.manual_override,
    { message: 'manual_override required when action is override' },
  )

export type PresignInput = z.infer<typeof presignSchema>
export type ConfirmInput = z.infer<typeof confirmSchema>
export type BatchReviewInput = z.infer<typeof batchReviewSchema>
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/validators/upload.ts
git commit -m "feat(validators): MAX_IMAGES_PER_BATCH=24 and batchReviewSchema"
```

---

## Task 7: Server-side image cap in presign

**Files:**
- Modify: `src/app/api/images/presign/route.ts`

- [ ] **Step 1: Add cap check before insert**

After `if (!batch) return apiError('Batch not found', 404)` and before creating the image row, count existing images and reject if at the cap:

```ts
import { MAX_IMAGES_PER_BATCH } from '@/lib/validators/upload'
// ...

const { count: existingCount } = await db
  .from('images')
  .select('id', { count: 'exact', head: true })
  .eq('batch_id', batch_id)

if ((existingCount ?? 0) >= MAX_IMAGES_PER_BATCH) {
  return apiError(`Group is at the ${MAX_IMAGES_PER_BATCH}-image limit`, 422, 'BATCH_FULL')
}
```

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit && npx eslint src/app/api/images/presign/route.ts`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/images/presign/route.ts
git commit -m "feat(api): enforce 24-image cap per batch on presign"
```

---

## Task 8: DropZone + upload page UI

**Files:**
- Modify: `src/components/upload/DropZone.tsx`
- Modify: `src/app/(dashboard)/upload/page.tsx`

- [ ] **Step 1: Update `DropZone.tsx` cap and copy**

Replace the `validate` function and the description copy:

```tsx
const validate = useCallback((files: File[]): File[] => {
  setError('')
  const valid: File[] = []
  for (const f of files) {
    if (!ALLOWED_TYPES.includes(f.type)) {
      setError(`"${f.name}" is not a supported image type`)
      continue
    }
    if (f.size > MAX_SIZE_MB * 1024 * 1024) {
      setError(`"${f.name}" exceeds ${MAX_SIZE_MB}MB limit`)
      continue
    }
    valid.push(f)
  }
  if (valid.length > 24) {
    setError('Maximum 24 images per group (eBay listing limit)')
    return valid.slice(0, 24)
  }
  return valid
}, [])
```

Replace the description text:

```tsx
<p className="text-sm font-medium text-gray-700">
  Drop all photos of <strong>one item</strong> here, or <span className="text-blue-600">browse</span>
</p>
<p className="text-xs text-gray-400 mt-1">
  JPEG, PNG, WEBP, TIFF — up to 10MB each, max 24 images per item
</p>
```

- [ ] **Step 2: Update upload page copy**

In `src/app/(dashboard)/upload/page.tsx`, replace the subtitle paragraph:

```tsx
<p className="text-sm text-gray-500 mb-6">
  Upload all photos of a single item. We&apos;ll find the serial number across the group and
  create one listing with every photo attached.
</p>
```

- [ ] **Step 3: Smoke test in dev**

Run: `npm run dev` (in another shell). Open `/upload`. Try dropping 25 files — should clamp to 24 and show error.

- [ ] **Step 4: Commit**

```bash
git add src/components/upload/DropZone.tsx src/app/(dashboard)/upload/page.tsx
git commit -m "feat(ui): drop zone — group of one item, 24-image cap"
```

---

## Task 9: Rewrite the batch process route

**Files:**
- Modify: `src/app/api/batches/[id]/process/route.ts`
- Modify: `src/lib/ocr/index.ts` (remove dead exports)

- [ ] **Step 1: Replace `src/app/api/batches/[id]/process/route.ts` body**

```ts
import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { runOcr } from '@/lib/ocr'
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import { enqueueRetry } from '@/lib/retry'
import type { Json } from '@/types/supabase'
import type { OcrCandidate } from '@/types/ocr'

const OCR_CONCURRENCY = 5

export const POST = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const batchId = params!.id

  const { data: batch } = await db
    .from('upload_batches')
    .select('*')
    .eq('id', batchId)
    .eq('user_id', userId)
    .single()

  if (!batch) return apiError('Batch not found', 404)
  if (batch.status === 'processing') return apiError('Batch already processing', 409)

  await db.from('upload_batches').update({ status: 'processing' }).eq('id', batchId)

  const { data: images } = await db
    .from('images')
    .select('id, storage_path')
    .eq('batch_id', batchId)
    .eq('status', 'uploaded')

  if (!images || images.length === 0) {
    await db.from('upload_batches').update({ status: 'failed' }).eq('id', batchId)
    return apiError('No images to process', 422)
  }

  await db.from('upload_batches').update({ total_images: images.length }).eq('id', batchId)

  // Run OCR in background; return immediately
  void processGroupInBackground(images, userId, batchId, db)

  return NextResponse.json({ message: 'Processing started', total: images.length })
})

async function processGroupInBackground(
  images: Array<{ id: string; storage_path: string }>,
  userId: string,
  batchId: string,
  db: ReturnType<typeof getSupabaseAdminClient>,
) {
  // Concurrency-limited per-image OCR
  const queue = [...images]
  const ocrRows: Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }> = []
  let processed = 0

  async function worker() {
    while (queue.length > 0) {
      const image = queue.shift()
      if (!image) return
      try {
        await db.from('images').update({ status: 'ocr_processing' }).eq('id', image.id)

        const { data: blob, error: dlError } = await db.storage.from('images').download(image.storage_path)
        if (dlError || !blob) throw new Error('Could not download image')

        const ab = await blob.arrayBuffer()
        const base64 = Buffer.from(ab).toString('base64')
        const ocrResult = await runOcr(base64, blob.type || 'image/jpeg')

        const { data: inserted } = await db
          .from('ocr_results')
          .insert({
            image_id: image.id,
            raw_response: ocrResult.rawResponse as unknown as Json,
            extracted_text: ocrResult.extractedText,
            extracted_code: ocrResult.topCandidate?.text ?? null,
            all_candidates: ocrResult.candidates as unknown as Json,
            confidence: ocrResult.topCandidate?.confidence ?? null,
            provider: ocrResult.provider,
            auto_approved: false,
          })
          .select('id, image_id, extracted_code, confidence, all_candidates')
          .single()

        if (inserted) {
          ocrRows.push({
            id: inserted.id,
            image_id: inserted.image_id,
            extracted_code: inserted.extracted_code,
            confidence: inserted.confidence,
            all_candidates: (inserted.all_candidates as unknown as OcrCandidate[]) ?? [],
          })
        }

        await db.from('images').update({ status: 'ocr_done' }).eq('id', image.id)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[process] OCR failed for image ${image.id}:`, errMsg)
        await db.from('images').update({ status: 'failed', error_message: errMsg }).eq('id', image.id)
        await enqueueRetry('image', image.id, errMsg)
      } finally {
        processed++
        await db.from('upload_batches').update({ processed }).eq('id', batchId)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, images.length) }, worker))

  // Group resolver
  const resolved = resolveGroupCode({ ocrResults: ocrRows })

  await db
    .from('upload_batches')
    .update({
      status: 'awaiting_review',
      winning_ocr_result_id: resolved.winningOcrResultId,
      final_code: resolved.winningCode,
      processed,
    })
    .eq('id', batchId)
}
```

- [ ] **Step 2: Remove dead code in `src/lib/ocr/index.ts`**

Delete the `OCR_AUTO_APPROVE_THRESHOLD` constant and the `shouldAutoApprove` function. The file should end at the closing brace of `_runOcr`'s caller — i.e., the `runOcr` wrapper and `_runOcr` function remain; everything after is removed.

Final state, last lines:

```ts
  return {
    rawResponse: { vision: visionResult.rawResponse, tesseract: tesseractResult.rawResponse },
    extractedText,
    candidates: allCandidates,
    topCandidate,
    provider: 'google_vision',
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: errors remaining only in `src/app/api/ocr-results/[id]/route.ts` (still imports removed `shouldAutoApprove` references? — actually no, that file references `auto-list` only). Confirm with the output. Errors in that file get cleaned in Task 13.

The new `images.status='ocr_done'` value: confirm the existing CHECK constraint on `images.status` includes `'ocr_done'`. It does (per `001_initial_schema.sql`).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/batches/[id]/process/route.ts src/lib/ocr/index.ts
git commit -m "feat(api): batch process drops auto-approve, runs group resolver"
```

---

## Task 10: Batch review endpoint

**Files:**
- Create: `src/app/api/batches/[id]/review/route.ts`

- [ ] **Step 1: Write the route**

```ts
// src/app/api/batches/[id]/review/route.ts
import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { batchReviewSchema } from '@/lib/validators/upload'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { autoCreateListing, type AutoListResult } from '@/lib/ebay/auto-list'
import { generateListingImageUrls } from '@/lib/ebay/image-urls'
import { enqueueRetry } from '@/lib/retry'
import type { Json } from '@/types/supabase'

export const PATCH = withAuth(async (req, userId, params) => {
  const debugLog: string[] = []
  const debug = (msg: string) => {
    const ts = new Date().toISOString()
    debugLog.push(`[${ts}] ${msg}`)
    console.log(`[batch-review] ${msg}`)
  }

  const batchId = params!.id
  debug(`PATCH /api/batches/${batchId}/review — user=${userId}`)

  const body = await req.json()
  const parsed = batchReviewSchema.safeParse(body)
  if (!parsed.success) return apiError(parsed.error.message, 422)
  const { action, manual_override } = parsed.data

  const db = getSupabaseAdminClient()

  const { data: batch } = await db
    .from('upload_batches')
    .select('*')
    .eq('id', batchId)
    .eq('user_id', userId)
    .single()

  if (!batch) return apiError('Batch not found', 404)
  if (batch.status !== 'awaiting_review') {
    return apiError(`Batch is in status ${batch.status}; review not allowed`, 409)
  }

  if (action === 'discard') {
    await db.from('upload_batches').update({ status: 'discarded' }).eq('id', batchId)
    debug('Batch discarded')
    return NextResponse.json({ success: true, discarded: true, debugLog })
  }

  if (action === 'approve' && !batch.final_code) {
    return apiError('Cannot approve — no code detected. Use override.', 422)
  }

  const finalCode = action === 'override' ? manual_override! : batch.final_code!
  debug(`Approved code: "${finalCode}"`)

  await db
    .from('upload_batches')
    .update({ status: 'approved', final_code: finalCode })
    .eq('id', batchId)

  // Fetch images to attach to listing
  const { data: images } = await db
    .from('images')
    .select('id, storage_path')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true })

  const groupImages = images ?? []
  debug(`${groupImages.length} image(s) in group`)

  // Create product_searches row for the batch
  const { data: search, error: searchErr } = await db
    .from('product_searches')
    .insert({ batch_id: batchId, search_query: finalCode, status: 'pending' })
    .select()
    .single()

  if (searchErr || !search) {
    debug(`Failed to create product_searches row: ${searchErr?.message ?? 'unknown'}`)
    await db.from('upload_batches').update({ status: 'failed' }).eq('id', batchId)
    return NextResponse.json({
      success: true,
      searchResult: 'search_error',
      debugLog,
    })
  }

  let searchResult: 'found' | 'not_found' | 'no_code' | 'search_error' = 'no_code'
  let listingResult: AutoListResult | undefined
  const searchDebug: { itemCount?: number; bestMatchTitle?: string; bestMatchId?: string } = {}

  try {
    const items = await searchEbayProducts(userId, finalCode)
    debug(`eBay returned ${items.length} item(s)`)
    searchDebug.itemCount = items.length

    const best = selectBestMatch(items, finalCode)

    await db
      .from('product_searches')
      .update({
        status: items.length > 0 ? 'success' : 'no_results',
        result_count: items.length,
        results_raw: items as unknown as Json,
        selected_item_id: best?.itemId ?? null,
      })
      .eq('id', search.id)

    if (best) {
      searchDebug.bestMatchTitle = best.title
      searchDebug.bestMatchId = best.itemId
      searchResult = 'found'

      const imageUrls = await generateListingImageUrls(db, groupImages)
      debug(`Signed ${imageUrls.length} image URL(s) for eBay`)

      listingResult = await autoCreateListing({
        userId,
        searchId: search.id,
        bestMatch: best,
        imageUrls,
      })

      await db
        .from('upload_batches')
        .update({ status: listingResult.success ? 'listed' : 'failed' })
        .eq('id', batchId)
    } else {
      searchResult = 'not_found'
      await db.from('upload_batches').update({ status: 'failed' }).eq('id', batchId)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    debug(`Search/list error: ${msg}`)
    searchResult = 'search_error'
    await enqueueRetry('product_search', search.id, msg)
    await db.from('upload_batches').update({ status: 'failed' }).eq('id', batchId)
  }

  return NextResponse.json({
    success: true,
    searchResult,
    searchDebug,
    listingResult,
    debugLog,
  })
})
```

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit && npx eslint src/app/api/batches/[id]/review/route.ts`
Expected: clean (other than legacy file errors).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/batches/[id]/review/route.ts
git commit -m "feat(api): batch review endpoint runs search + list with imageUrls"
```

---

## Task 11: Review page — fetch batches, not ocr_results

**Files:**
- Modify: `src/app/(dashboard)/review/page.tsx`
- Modify: `src/app/(dashboard)/review/ReviewQueue.tsx`

- [ ] **Step 1: Replace `src/app/(dashboard)/review/page.tsx`**

```tsx
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import ReviewQueue, { type GroupForReview } from './ReviewQueue'
import type { OcrCandidate } from '@/types/ocr'

export const dynamic = 'force-dynamic'

const SIGNED_TTL = 3600

export default async function ReviewPage() {
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  const db = getSupabaseAdminClient()
  const { data: batches } = await db
    .from('upload_batches')
    .select('id, status, final_code, winning_ocr_result_id, total_images, created_at')
    .eq('user_id', user!.id)
    .eq('status', 'awaiting_review')
    .order('created_at', { ascending: true })
    .limit(50)

  const groups: GroupForReview[] = []
  for (const b of batches ?? []) {
    const { data: imgs } = await db
      .from('images')
      .select('id, storage_path, original_filename')
      .eq('batch_id', b.id)
      .order('created_at', { ascending: true })

    const signedImages = await Promise.all(
      (imgs ?? []).map(async (img) => {
        const { data } = await db.storage.from('images').createSignedUrl(img.storage_path, SIGNED_TTL)
        return { id: img.id, signed_url: data?.signedUrl ?? null, original_filename: img.original_filename }
      }),
    )

    // Get all OCR candidates for the batch (for alternatives display)
    const { data: ocrRows } = await db
      .from('ocr_results')
      .select('id, image_id, extracted_code, confidence, all_candidates')
      .in('image_id', (imgs ?? []).map((i) => i.id))

    groups.push({
      batchId: b.id,
      finalCode: b.final_code,
      winningOcrResultId: b.winning_ocr_result_id,
      totalImages: b.total_images,
      images: signedImages,
      ocrResults: (ocrRows ?? []).map((r) => ({
        id: r.id,
        image_id: r.image_id,
        extracted_code: r.extracted_code,
        confidence: r.confidence,
        all_candidates: (r.all_candidates as unknown as OcrCandidate[]) ?? [],
      })),
    })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Review Queue</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {groups.length} group{groups.length !== 1 ? 's' : ''} waiting for review
          </p>
        </div>
      </div>
      <ReviewQueue initialGroups={groups} />
    </div>
  )
}
```

- [ ] **Step 2: Replace `src/app/(dashboard)/review/ReviewQueue.tsx`**

```tsx
'use client'

import { useState } from 'react'
import ReviewCard from '@/components/review/ReviewCard'
import type { OcrCandidate } from '@/types/ocr'

export interface GroupForReview {
  batchId: string
  finalCode: string | null
  winningOcrResultId: string | null
  totalImages: number
  images: Array<{ id: string; signed_url: string | null; original_filename: string | null }>
  ocrResults: Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }>
}

interface AutoListStep {
  step: string
  status: 'ok' | 'fail'
  detail: string
  timestamp: string
}

export interface ReviewResponse {
  success: boolean
  discarded?: boolean
  searchResult?: string
  searchDebug?: { itemCount?: number; bestMatchTitle?: string; bestMatchId?: string }
  listingResult?: {
    success: boolean
    listingUrl?: string
    error?: string
    steps?: AutoListStep[]
  }
  debugLog?: string[]
}

interface Props {
  initialGroups: GroupForReview[]
}

export default function ReviewQueue({ initialGroups }: Props) {
  const [groups] = useState(initialGroups)

  async function handleReview(
    batchId: string,
    action: 'approve' | 'override' | 'discard',
    override?: string,
  ): Promise<ReviewResponse> {
    const res = await fetch(`/api/batches/${batchId}/review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, manual_override: override }),
    })
    return res.json()
  }

  if (groups.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-4xl mb-3">✓</p>
        <p className="font-medium text-gray-600">All caught up!</p>
        <p className="text-sm mt-1">No groups need review right now.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-4xl">
      {groups.map((g) => (
        <ReviewCard key={g.batchId} group={g} onSubmit={handleReview} />
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: errors only in `ReviewCard.tsx` (next task).

- [ ] **Step 4: Commit**

```bash
git add src/app/(dashboard)/review/page.tsx src/app/(dashboard)/review/ReviewQueue.tsx
git commit -m "feat(review): page fetches groups instead of single OCR results"
```

---

## Task 12: ReviewCard — group view

**Files:**
- Modify: `src/components/review/ReviewCard.tsx`

- [ ] **Step 1: Replace the entire file**

```tsx
'use client'

import { useMemo, useState } from 'react'
import Image from 'next/image'
import type { GroupForReview, ReviewResponse } from '@/app/(dashboard)/review/ReviewQueue'

interface Props {
  group: GroupForReview
  onSubmit: (
    batchId: string,
    action: 'approve' | 'override' | 'discard',
    override?: string,
  ) => Promise<ReviewResponse>
}

export default function ReviewCard({ group, onSubmit }: Props) {
  const noCode = !group.finalCode
  const [action, setAction] = useState<'approve' | 'override' | 'discard'>(noCode ? 'override' : 'approve')
  const [manualCode, setManualCode] = useState(group.finalCode ?? '')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<ReviewResponse | null>(null)
  const [showDebug, setShowDebug] = useState(false)

  const winningOcr = useMemo(
    () => group.ocrResults.find((r) => r.id === group.winningOcrResultId) ?? null,
    [group.ocrResults, group.winningOcrResultId],
  )
  const winningImageId = winningOcr?.image_id ?? null
  const confidence = winningOcr?.confidence ? Math.round(winningOcr.confidence * 100) : 0

  // Alternatives = distinct codes other than finalCode, sorted by confidence
  const alternatives = useMemo(() => {
    const map = new Map<string, { code: string; confidence: number; imageId: string }>()
    for (const r of group.ocrResults) {
      for (const c of r.all_candidates ?? []) {
        if (!c?.text || c.text === '__DUPLICATE__') continue
        if (c.text === group.finalCode) continue
        const existing = map.get(c.text)
        if (!existing || c.confidence > existing.confidence) {
          map.set(c.text, { code: c.text, confidence: c.confidence ?? 0, imageId: r.image_id })
        }
      }
    }
    return [...map.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 6)
  }, [group.ocrResults, group.finalCode])

  async function handleSubmit() {
    setLoading(true)
    try {
      const res = await onSubmit(group.batchId, action, action === 'override' ? manualCode : undefined)
      setResponse(res)
    } catch (err) {
      setResponse({
        success: false,
        debugLog: [`Client error: ${err instanceof Error ? err.message : String(err)}`],
      })
    }
    setLoading(false)
  }

  if (response) {
    const isDiscarded = response.discarded
    const isListed = response.listingResult?.success
    const listingFailed = response.listingResult && !response.listingResult.success
    const noMatch = response.searchResult === 'not_found'
    const searchError = response.searchResult === 'search_error'

    let bgColor = 'bg-green-50 border-green-200'
    let textColor = 'text-green-700'
    let icon = '✅'
    let message = 'Group reviewed successfully'

    if (isDiscarded) {
      bgColor = 'bg-yellow-50 border-yellow-200'; textColor = 'text-yellow-700'; icon = '⚠️'; message = 'Group discarded'
    } else if (isListed) {
      message = `Listed on eBay with ${group.totalImages} photo${group.totalImages !== 1 ? 's' : ''}!`
    } else if (listingFailed) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-700'; icon = '❌'
      message = `Listing failed: ${response.listingResult!.error}`
    } else if (noMatch) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-700'; icon = '❌'
      message = 'No matching product found on eBay for this code'
    } else if (searchError) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-700'; icon = '❌'
      message = 'Search/listing error — see debug log'
    }

    return (
      <div className={`rounded-xl border ${bgColor} overflow-hidden`}>
        <div className="p-5">
          <p className={`font-semibold text-base ${textColor}`}>{icon} {message}</p>
          {response.listingResult?.listingUrl && (
            <a
              href={response.listingResult.listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm text-blue-600 hover:underline font-medium"
            >
              View on eBay ↗
            </a>
          )}
          {response.searchDebug && (
            <div className="mt-3 text-xs text-gray-600 space-y-1">
              <p>🔍 eBay returned <strong>{response.searchDebug.itemCount ?? 0}</strong> items</p>
              {response.searchDebug.bestMatchTitle && (
                <p>🏷️ Best match: &quot;{response.searchDebug.bestMatchTitle}&quot;</p>
              )}
            </div>
          )}
          {response.listingResult?.steps && response.listingResult.steps.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-xs font-semibold text-gray-700 mb-1">Listing Pipeline:</p>
              {response.listingResult.steps.map((step, i) => (
                <div key={i} className={`text-xs px-2 py-1 rounded ${step.status === 'ok' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                  <span className="font-medium">{step.status === 'ok' ? '✓' : '✗'} {step.step}:</span>{' '}
                  <span className="break-all">{step.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {response.debugLog && response.debugLog.length > 0 && (
          <div className="border-t border-gray-200">
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="w-full px-5 py-2 text-left text-xs font-medium text-gray-500 hover:bg-gray-50 transition-colors"
            >
              {showDebug ? '▼' : '▶'} Debug Log ({response.debugLog.length} entries)
            </button>
            {showDebug && (
              <div className="px-5 pb-4 max-h-64 overflow-y-auto">
                <pre className="text-[10px] leading-4 text-gray-600 font-mono whitespace-pre-wrap break-all bg-white rounded p-2 border border-gray-200">
                  {response.debugLog.join('\n')}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-4 border-b border-gray-100 flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-700">
          Group · {group.images.length} photo{group.images.length !== 1 ? 's' : ''}
        </p>
        {noCode ? (
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">No code detected</span>
        ) : (
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${confidence >= 90 ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
            {confidence}% confidence
          </span>
        )}
      </div>

      {/* Image strip */}
      <div className="p-4 bg-gray-50 border-b border-gray-100">
        <div className="flex gap-2 overflow-x-auto">
          {group.images.map((img) => {
            const isSource = img.id === winningImageId
            return (
              <div key={img.id} className="relative shrink-0">
                {img.signed_url ? (
                  <Image
                    src={img.signed_url}
                    alt={img.original_filename ?? 'photo'}
                    width={120}
                    height={120}
                    className={`h-28 w-28 object-cover rounded-lg ${isSource ? 'ring-4 ring-blue-500' : 'ring-1 ring-gray-200'}`}
                    unoptimized
                  />
                ) : (
                  <div className="h-28 w-28 bg-gray-200 rounded-lg flex items-center justify-center text-xs text-gray-400">no preview</div>
                )}
                {isSource && (
                  <span className="absolute bottom-1 left-1 bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded">
                    📄 source
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* OCR data + actions */}
      <div className="p-5 space-y-3">
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Detected code</p>
          <p className="font-mono text-sm font-semibold text-gray-900 bg-gray-50 px-2 py-1 rounded">
            {group.finalCode ?? <span className="text-gray-400 italic">No code found — please override</span>}
          </p>
        </div>

        {alternatives.length > 0 && (
          <details className="text-xs text-gray-600">
            <summary className="cursor-pointer font-medium">{alternatives.length} other candidate{alternatives.length !== 1 ? 's' : ''}</summary>
            <ul className="mt-2 space-y-1 pl-2">
              {alternatives.map((a) => (
                <li key={a.code} className="font-mono">
                  <span className="text-gray-900">{a.code}</span>{' '}
                  <span className="text-gray-400">— {Math.round(a.confidence * 100)}%</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="space-y-2 pt-1">
          <div className="flex gap-2">
            {(['approve', 'override', 'discard'] as const).map((a) => {
              const disabled = a === 'approve' && noCode
              return (
                <button
                  key={a}
                  onClick={() => !disabled && setAction(a)}
                  disabled={disabled}
                  className={`px-3 py-1 text-xs rounded-lg font-medium transition-colors ${
                    action === a
                      ? a === 'discard' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed'
                  }`}
                >
                  {a === 'approve' ? 'Accept' : a === 'override' ? 'Correct' : 'Discard'}
                </button>
              )
            })}
          </div>

          {action === 'override' && (
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value.toUpperCase())}
              placeholder="Enter correct code"
              className="w-full px-2 py-1.5 border border-gray-300 rounded font-mono text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}

          <button
            onClick={handleSubmit}
            disabled={loading || (action === 'override' && !manualCode)}
            className="w-full py-1.5 bg-blue-600 text-white text-sm rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Processing… (searching eBay & listing)' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit && npx eslint src/components/review/ReviewCard.tsx`
Expected: clean. Errors elsewhere only in legacy `src/app/api/ocr-results/[id]/route.ts` (next task).

- [ ] **Step 3: Commit**

```bash
git add src/components/review/ReviewCard.tsx
git commit -m "feat(review): ReviewCard renders group with image strip + alternatives"
```

---

## Task 13: Remove legacy per-image OCR review endpoint

**Files:**
- Delete: `src/app/api/ocr-results/[id]/route.ts`
- Modify: `src/lib/validators/ocr.ts` (remove unused `ocrReviewSchema`)

- [ ] **Step 1: Confirm no callers remain**

Run: `grep -rn 'api/ocr-results' src` (use Grep tool)
Expected: only the legacy file path. ReviewQueue now hits `/api/batches/[id]/review`.

- [ ] **Step 2: Delete the file**

Delete `src/app/api/ocr-results/[id]/route.ts` (entire file). The directory may become empty — that's fine.

- [ ] **Step 3: Remove `ocrReviewSchema` from `src/lib/validators/ocr.ts`**

Replace file contents with an empty export to keep the path resolvable for any historic import:

```ts
// All review validation now lives in src/lib/validators/upload.ts (batchReviewSchema).
export {}
```

(Or delete the file and remove its imports if any exist — `npx tsc --noEmit` will tell you.)

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc --noEmit && npx eslint .`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove legacy per-image OCR review endpoint"
```

---

## Task 14: End-to-end smoke test

**Files:** none (manual)

- [ ] **Step 1: Apply migration if not already**

Confirm `supabase/migrations/006_image_groups.sql` is applied to the dev DB.

- [ ] **Step 2: Run dev server**

```bash
npm run dev
```

Open `http://localhost:3000`.

- [ ] **Step 3: Happy path**

1. Sign in.
2. Connect eBay (Settings → eBay) if not already.
3. Go to `/upload`. Drop 3 images of the same item; one should clearly contain a serial number / part code.
4. Wait for "uploaded successfully" + processing message.
5. Go to `/review`. Confirm: ONE group card appears with 3 thumbnails. The image with the serial has a blue ring + "📄 source" badge. The detected code is shown.
6. Click Accept → Confirm.
7. Expected: result panel shows search result, listing pipeline steps, and "View on eBay ↗" link if listing succeeded.
8. Open the eBay listing in the browser. Confirm all 3 images are attached.

- [ ] **Step 4: Override path**

1. Upload a group where OCR is unlikely to find a code (random images).
2. On `/review`, the card should show "No code detected"; Accept disabled.
3. Click Correct, type a code, click Confirm.
4. Expected: search runs with the manual code. Listing created (or `not_found` if no eBay match).

- [ ] **Step 5: Discard path**

1. Upload a group; on `/review`, click Discard → Confirm.
2. Expected: card shows "Group discarded". DB: `upload_batches.status = 'discarded'`.

- [ ] **Step 6: 24-image cap**

1. On `/upload`, attempt to drop 25+ images.
2. Expected: only 24 accepted; error "Maximum 24 images per group" shown.

- [ ] **Step 7: Commit no code; just confirm test pass to user**

(No commit — manual verification only.)

---

## Self-review

- [x] **Spec coverage:**
  - Group definition (one batch = one group): Tasks 1, 8.
  - OCR on every image: Task 9.
  - Hybrid winner selection (consensus + confidence): Task 3.
  - No auto-approval, always review: Task 9 (process route drops auto-approve), Task 10 (review endpoint required).
  - eBay imageUrls attached: Tasks 4, 5, 10.
  - DB-only association: Task 1 (`product_searches.batch_id`).
  - Image strip review UI: Tasks 11, 12.
  - 24-image cap: Tasks 6, 7, 8.
  - Edge cases (no serial, no consensus, stray images, oversize group): Tasks 9, 12, 7, 8.
  - Cleanup of legacy code: Tasks 9, 13.
- [x] **No placeholders:** every step has full code or exact commands.
- [x] **Type consistency:** `BatchStatus`, `UploadBatch.winning_ocr_result_id`, `UploadBatch.final_code`, `ProductSearch.batch_id`, `imageUrls` on `EbayInventoryItem.product` and `CreateListingParams` and `AutoListParams` — all referenced consistently across tasks 1, 2, 5, 9, 10.
