-- Enable pgcrypto for encryption
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Profiles table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  full_name   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- eBay OAuth connections
CREATE TABLE IF NOT EXISTS ebay_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  token_expires_at  TIMESTAMPTZ NOT NULL,
  ebay_user_id      TEXT,
  marketplace_id    TEXT NOT NULL DEFAULT 'EBAY_US',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upload batches
CREATE TABLE IF NOT EXISTS upload_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','awaiting_review','completed','failed')),
  total_images  INT NOT NULL DEFAULT 0,
  processed     INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Individual images
CREATE TABLE IF NOT EXISTS images (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  storage_path      TEXT NOT NULL,
  original_filename TEXT,
  file_size_bytes   INT,
  mime_type         TEXT,
  status            TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','ocr_processing','ocr_done','needs_review','approved','failed','discarded')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OCR results
CREATE TABLE IF NOT EXISTS ocr_results (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id         UUID NOT NULL UNIQUE REFERENCES images(id) ON DELETE CASCADE,
  raw_response     JSONB,
  extracted_text   TEXT,
  extracted_code   TEXT,
  all_candidates   JSONB,
  confidence       NUMERIC(5,4) CHECK (confidence >= 0 AND confidence <= 1),
  provider         TEXT NOT NULL DEFAULT 'google_vision',
  auto_approved    BOOLEAN NOT NULL DEFAULT false,
  manual_override  TEXT,
  reviewed_by      UUID REFERENCES profiles(id),
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Computed final_code view
CREATE OR REPLACE VIEW ocr_results_with_final_code AS
SELECT
  *,
  COALESCE(
    manual_override,
    CASE WHEN auto_approved THEN extracted_code ELSE NULL END
  ) AS final_code
FROM ocr_results;

-- Product searches
CREATE TABLE IF NOT EXISTS product_searches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ocr_result_id     UUID NOT NULL REFERENCES ocr_results(id) ON DELETE CASCADE,
  search_query      TEXT NOT NULL,
  search_provider   TEXT NOT NULL DEFAULT 'ebay_browse',
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','no_results','failed')),
  result_count      INT,
  results_raw       JSONB,
  selected_item_id  TEXT,
  error_message     TEXT,
  attempt_count     INT NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- eBay listings
CREATE TABLE IF NOT EXISTS listings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id         UUID NOT NULL REFERENCES product_searches(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  ebay_item_id      TEXT,
  ebay_listing_url  TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  price             NUMERIC(10,2),
  currency          TEXT NOT NULL DEFAULT 'USD',
  quantity          INT NOT NULL DEFAULT 1,
  condition         TEXT,
  category_id       TEXT,
  sku               TEXT,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitting','active','failed','ended')),
  error_message     TEXT,
  error_code        TEXT,
  attempt_count     INT NOT NULL DEFAULT 1,
  last_attempted_at TIMESTAMPTZ,
  listed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retry queue
CREATE TABLE IF NOT EXISTS retry_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('image','product_search','listing')),
  entity_id     UUID NOT NULL,
  reason        TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','succeeded','exhausted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES profiles(id),
  entity_type  TEXT,
  entity_id    UUID,
  action       TEXT NOT NULL,
  old_value    JSONB,
  new_value    JSONB,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
