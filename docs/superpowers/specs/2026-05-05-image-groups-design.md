# Image Groups — Design Spec

**Date:** 2026-05-05
**Status:** Approved (pending implementation plan)
**Branch:** `Vadim`

## Problem

The existing pipeline treats every uploaded image as an independent item: each image gets its own OCR result, product search, and eBay listing. Users in fact often have multiple photos of the **same item** (e.g., front, back, label with serial number, packaging) and want to list that item once with all photos attached.

## Goal

Process and list a **group** of images as a single item:

1. Accept 1–24 images per upload as a group of the same item.
2. Run OCR on every image in the group.
3. Identify the serial/code from whichever image contains it.
4. Require human review and approval of the detected code (no auto-approval).
5. Create one eBay listing using the approved code, with **all** group images attached to that listing.

## Non-goals (v1)

- Per-image discard within a group (whole-group discard only).
- Multiple groups in one upload session.
- Editable title/description in review (uses eBay best-match title, as today).
- Backfill of pre-existing data (dev DB will be wiped).

## Constraints

- **No auto-approval.** Client guideline: every detected code must be human-confirmed before any downstream action. The legacy `OCR_AUTO_APPROVE_THRESHOLD = 0.90` / `shouldAutoApprove()` path is removed.
- **eBay image limit:** 24 images per inventory item; group capped at 24.
- **Backward compatibility:** Not required for stored data; flow remains roughly the same shape (upload → OCR → review → list) but at group granularity.

## Architecture

### Concerns separation

| Concern              | Module                                | Responsibility                                                                 |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| Grouping             | `upload_batches` table + DropZone     | One upload session = one group. UI cap 24.                                     |
| Serial detection     | `src/lib/ocr/group-resolver.ts` (new) | Pure function: pick winning code from N OCR results.                           |
| Image URL generation | `src/lib/ebay/image-urls.ts` (new)    | Generate signed Supabase URLs (1h TTL) for a list of image rows.               |
| Listing              | `src/lib/ebay/inventory.ts` + `auto-list.ts` (modified) | Accepts `imageUrls[]`, attaches to eBay inventory item.        |
| Review               | `PATCH /api/batches/[id]/review` (new), `ReviewCard` (modified) | Single decision per group; runs search & listing on approve.    |

### Data model

Migration `supabase/migrations/006_image_groups.sql` (resets dev DB; truncates `ocr_results`, `product_searches`, `listings`).

```sql
-- upload_batches becomes the group
ALTER TABLE upload_batches
  ADD COLUMN winning_ocr_result_id UUID REFERENCES ocr_results(id) ON DELETE SET NULL,
  ADD COLUMN final_code TEXT;

ALTER TABLE upload_batches
  DROP CONSTRAINT IF EXISTS upload_batches_status_check;
ALTER TABLE upload_batches
  ADD CONSTRAINT upload_batches_status_check
  CHECK (status IN ('pending','processing','awaiting_review','approved','listed','failed','discarded'));

-- product_searches now hangs off the group
ALTER TABLE product_searches
  DROP CONSTRAINT product_searches_ocr_result_id_fkey,
  DROP COLUMN ocr_result_id;
ALTER TABLE product_searches
  ADD COLUMN batch_id UUID NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  ADD CONSTRAINT product_searches_batch_unique UNIQUE (batch_id);
```

`images`, `ocr_results`, `listings` keep their existing structure. `listings.search_id` still points at `product_searches`; transitively reaches batch & images.

### Data flow

```
User selects 1–24 photos of one item
  ↓
POST /api/batches               → batch_id (status: pending)
POST /api/images/presign        → image_id, signed PUT URL  (×N)
PUT to Supabase storage         (×N)
POST /api/images/confirm        (×N)
  ↓
POST /api/batches/{id}/process
  ├─ status → processing
  ├─ run OCR on all N images in parallel (concurrency cap 5)
  ├─ persist N ocr_results rows
  ├─ group-resolver picks winner
  ├─ update batch: winning_ocr_result_id, final_code (proposed)
  └─ status → awaiting_review
  ↓
User opens /review
  GET /api/batches?status=awaiting_review
  ReviewCard renders: image strip (all N), winning code (editable), candidates
  ↓
User clicks Approve | Override | Discard
PATCH /api/batches/{id}/review
  ├─ Discard: status → discarded; stop.
  ├─ Approve/Override:
  │   ├─ update batch.final_code, status → approved
  │   ├─ insert product_searches row (batch_id, search_query=final_code)
  │   ├─ search eBay; record results
  │   ├─ if best match: generate signed URLs for all N images
  │   ├─       call autoCreateListing({ imageUrls, … })
  │   └─       status → listed (or failed)
```

### Group resolver (signature)

```ts
// src/lib/ocr/group-resolver.ts
export interface GroupResolverInput {
  ocrResults: Array<{
    id: string                      // ocr_results.id
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }>
}

export interface GroupResolverOutput {
  winningOcrResultId: string | null  // null if no image produced any candidate
  winningCode: string | null
  hadConsensus: boolean              // true iff ≥2 images agreed on the winning code
  alternatives: Array<{ code: string; ocrResultId: string; confidence: number }>
}

export function resolveGroupCode(input: GroupResolverInput): GroupResolverOutput
```

**Algorithm (hybrid):**
1. Gather every candidate from every image (`extracted_code` + entries in `all_candidates`).
2. Bucket by `text`. If any text appears in ≥2 distinct images, that's a consensus winner. If multiple consensus candidates, pick the one with the highest sum-of-confidences. `hadConsensus = true`.
3. Otherwise, pick the single highest-confidence candidate across all images. `hadConsensus = false`.
4. Record the source `ocr_result_id` (first image where it appeared) and surface alternatives (other distinct candidates with their source) for the review UI.
5. If no candidate of any kind, return all-null with `hadConsensus = false`.

The result of resolveGroupCode is a **proposed** code. Approval is still required.

### eBay image attachment

eBay's Inventory API accepts `product.imageUrls: string[]` on `PUT /sell/inventory/v1/inventory_item/{sku}`. eBay fetches the URLs at publish time, so 1-hour signed URLs from Supabase storage are sufficient. No public bucket needed.

```ts
// src/lib/ebay/image-urls.ts
export async function generateListingImageUrls(
  db: SupabaseAdminClient,
  images: Array<{ storage_path: string }>,
): Promise<string[]>
```

`createAndPublishListing` and `autoCreateListing` gain a required `imageUrls: string[]` param and pass it through to `inventoryItem.product.imageUrls`.

### Review API

```
PATCH /api/batches/{id}/review
Body: {
  action: 'approve' | 'override' | 'discard',
  manual_override?: string  // required when action === 'override'
}
Response (approve|override): {
  success: true,
  searchResult: 'found' | 'not_found' | 'no_code' | 'search_error',
  searchDebug?: { itemCount, bestMatchTitle, bestMatchId },
  listingResult?: AutoListResult,
  debugLog: string[]
}
```

Constraints:
- If `winning_ocr_result_id` is null and action is `approve` → 422 (must use override).
- Override empty string → 422.
- Batch must be in `awaiting_review`.

### Review UI

`/review` page lists batches with `status = 'awaiting_review'`, newest first. Each `ReviewCard`:

- Header: batch id, "N photos" pill.
- Horizontal scroll strip: all N image thumbnails. The image whose OCR contributed the winning code is highlighted (e.g., blue ring + "📄 source").
- Winner code field: pre-filled with `final_code`; editable when action is Override; shows confidence pill.
- Alternatives list (collapsible): other candidates from the group with their source image.
- Buttons: Accept / Override / Discard.
- Accept disabled when no winner exists (forces Override).

Result rendering reuses the existing post-action panel pattern (search debug, listing pipeline steps, eBay link).

### Process route changes

`src/app/api/batches/[id]/process/route.ts`:
- OCR loop becomes `Promise.all` with a small concurrency limiter (cap 5) over `images`.
- Per-image: download → OCR → insert `ocr_results`. **Drops** the `auto_approved` short-circuit and the inline `triggerProductSearch` call.
- After all images processed, call `resolveGroupCode` and write `winning_ocr_result_id` + `final_code` on the batch.
- Set batch status `awaiting_review`.

### Removed code

- `shouldAutoApprove()` and `OCR_AUTO_APPROVE_THRESHOLD` in `src/lib/ocr/index.ts` — unused after removal of auto-approval.
- `triggerProductSearch()` inside the process route — now handled by review endpoint.
- `PATCH /api/ocr-results/[id]` — replaced by batch review. (`GET` may stay if needed by older UI; remove once no caller exists.)

### Source of truth for the approved code

- The **batch** is the source of truth for the approved code: `upload_batches.final_code`, `winning_ocr_result_id`, `status`.
- The review endpoint does **not** mutate `ocr_results` rows. Existing per-image fields (`auto_approved`, `manual_override`, `reviewed_by`, `reviewed_at`) become unused by the new flow; they're left in place but orphaned. A later cleanup can drop them.

## Edge cases

| Case | Behavior |
| ---- | -------- |
| No serial detected in any image | `winning_ocr_result_id = null`. Review forces Override. Accept disabled. |
| Consensus across multiple images | Consensus code wins. Review still required. UI shows ✔ consensus badge. |
| No consensus, multiple candidates | Highest-confidence wins; alternatives shown. Review still required. |
| Stray/unrelated image in group | OCR runs anyway; if no code, contributes nothing. Image is still uploaded to eBay listing as an extra photo. User discards entire group if unacceptable. |
| OCR fails on individual image | Image marked `failed`, retry queue receives it; group still proceeds with remaining images' candidates. |
| Group has zero successful OCRs | All-null winner; review forces Override or Discard. |
| Upload exceeds 24 images | Rejected client-side (DropZone) and server-side (presign). |

## Testing

**Unit**
- `group-resolver.spec.ts` — fixtures: zero candidates, single-image winner, consensus across two images, three-way disagreement, identical confidences with consensus tiebreaker.
- `image-urls.spec.ts` — mocked storage client; asserts URL count, expiry, error propagation.

**Integration** (in-memory or test Supabase)
- Happy path: 3 images, one with a code → process → review approve → eBay search/list (mocked) → batch listed, listing has imageUrls.
- No-code path: 2 blurry images → review forces Override → user submits manual code → listing proceeds.
- Discard path: review discard → batch.status = 'discarded', no listing created.

## Migration & rollout

1. Apply migration `006_image_groups.sql` in dev. Truncates downstream tables.
2. Deploy code in a single PR (DB + API + UI together — no half-state).
3. Smoke test: end-to-end with sandbox eBay credentials.
4. Manual QA: upload group of 3 images including one with a real code; confirm review + listing flow.

## File checklist

New:
- `supabase/migrations/006_image_groups.sql`
- `src/lib/ocr/group-resolver.ts`
- `src/lib/ebay/image-urls.ts`
- `src/app/api/batches/[id]/review/route.ts`
- Tests: `src/lib/ocr/group-resolver.spec.ts`, `src/lib/ebay/image-urls.spec.ts`

Modified:
- `src/types/database.ts` — `UploadBatch` gains fields; `BatchStatus` enum extended; `ProductSearch.ocr_result_id` → `batch_id`.
- `src/types/supabase.ts` — regen or hand-update.
- `src/lib/validators/upload.ts` — image cap 24.
- `src/lib/validators/ocr.ts` — keep for override schema; reused by review endpoint.
- `src/components/upload/DropZone.tsx` — `MAX_IMAGES = 24`, copy.
- `src/app/(dashboard)/upload/page.tsx` — copy update; otherwise unchanged.
- `src/app/api/batches/[id]/process/route.ts` — drop auto-approve, add resolver, mark `awaiting_review`.
- `src/app/api/images/presign/route.ts` — server-side cap of 24 images per batch.
- `src/lib/ebay/inventory.ts` — accept `imageUrls`, set on inventory item.
- `src/lib/ebay/auto-list.ts` — accept `imageUrls`, pass through.
- `src/components/review/ReviewCard.tsx` — refactor for group input.
- `src/app/(dashboard)/review/ReviewQueue.tsx` and `page.tsx` — fetch batches not ocr_results.
- `src/lib/ocr/index.ts` — remove `shouldAutoApprove` and threshold const.

Removed:
- `src/app/api/ocr-results/[id]/route.ts` PATCH handler (GET removed if unused).
