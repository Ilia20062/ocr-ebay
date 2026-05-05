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
