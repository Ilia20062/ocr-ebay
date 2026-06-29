-- ============================================================================
-- OCR CRM — consolidated RDS PostgreSQL schema (AWS-native).
--
-- This is the final state after Supabase migrations 001..007, ported to a
-- standalone Postgres database:
--   * `profiles.id` is the Cognito user `sub` (no auth.users FK).
--   * Row-Level Security is NOT used — ownership is enforced in application
--     code via explicit user_id filters (the model the service-role client
--     already used). All access goes through one DB role.
--   * The `handle_new_user` trigger is replaced by the /api/auth/signup route.
--
-- Idempotent: safe to run repeatedly.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- updated_at helper -----------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---- profiles --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY,                 -- Cognito sub
  email       TEXT NOT NULL,
  full_name   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- ebay_connections ------------------------------------------------------
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

-- ---- upload_sessions (007) -------------------------------------------------
CREATE TABLE IF NOT EXISTS upload_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'uploading'
                  CHECK (status IN ('uploading','grouping','processing','review_ready','done','failed')),
  total_images  INT NOT NULL DEFAULT 0,
  group_count   INT NOT NULL DEFAULT 0,
  lot_label     TEXT,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- upload_batches (001 + 006 + 007) --------------------------------------
-- winning_ocr_result_id -> ocr_results FK is added at the end (circular dep).
CREATE TABLE IF NOT EXISTS upload_batches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','processing','awaiting_review','approved','listed','failed','discarded')),
  total_images          INT NOT NULL DEFAULT 0,
  processed             INT NOT NULL DEFAULT 0,
  winning_ocr_result_id UUID,
  final_code            TEXT,
  case_number           TEXT,
  upload_session_id     UUID REFERENCES upload_sessions(id) ON DELETE CASCADE,
  auto_grouped          BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- images (001 + 005 + 007) ----------------------------------------------
CREATE TABLE IF NOT EXISTS images (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           UUID REFERENCES upload_batches(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  storage_path       TEXT NOT NULL,
  original_filename  TEXT,
  file_size_bytes    INT,
  mime_type          TEXT,
  status             TEXT NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded','ocr_processing','ocr_done','needs_review','approved','failed','discarded')),
  error_message      TEXT,
  upload_session_id  UUID REFERENCES upload_sessions(id) ON DELETE CASCADE,
  captured_at        TIMESTAMPTZ,
  is_label_candidate BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- ocr_results (001) -----------------------------------------------------
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

-- ---- product_searches (001 + 006) ------------------------------------------
CREATE TABLE IF NOT EXISTS product_searches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  search_query      TEXT NOT NULL,
  search_provider   TEXT NOT NULL DEFAULT 'ebay_browse',
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','success','no_results','failed')),
  result_count      INT,
  results_raw       JSONB,
  selected_item_id  TEXT,
  error_message     TEXT,
  attempt_count     INT NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_searches_batch_unique UNIQUE (batch_id)
);

-- ---- listings (001) --------------------------------------------------------
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
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','submitting','active','failed','ended')),
  error_message     TEXT,
  error_code        TEXT,
  attempt_count     INT NOT NULL DEFAULT 1,
  last_attempted_at TIMESTAMPTZ,
  listed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- retry_queue (001 + 005) -----------------------------------------------
CREATE TABLE IF NOT EXISTS retry_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('image','product_search','listing')),
  entity_id     UUID NOT NULL UNIQUE,
  reason        TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','succeeded','exhausted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- audit_logs (001) ------------------------------------------------------
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

-- ---- deferred circular FK --------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'upload_batches_winning_ocr_fk'
  ) THEN
    ALTER TABLE upload_batches
      ADD CONSTRAINT upload_batches_winning_ocr_fk
      FOREIGN KEY (winning_ocr_result_id) REFERENCES ocr_results(id) ON DELETE SET NULL;
  END IF;
END$$;

-- ---- additive columns (idempotent — for already-created databases) ---------
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS case_number TEXT;

-- ---- computed view ---------------------------------------------------------
CREATE OR REPLACE VIEW ocr_results_with_final_code AS
SELECT
  *,
  COALESCE(
    manual_override,
    CASE WHEN auto_approved THEN extracted_code ELSE NULL END
  ) AS final_code
FROM ocr_results;

-- ---- indexes (003 + 006 + 007) ---------------------------------------------
CREATE INDEX IF NOT EXISTS idx_images_batch_id          ON images(batch_id);
CREATE INDEX IF NOT EXISTS idx_images_status            ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_user_id           ON images(user_id);
CREATE INDEX IF NOT EXISTS idx_ocr_results_image_id     ON ocr_results(image_id);
CREATE INDEX IF NOT EXISTS idx_product_searches_status  ON product_searches(status);
CREATE INDEX IF NOT EXISTS idx_listings_user_id         ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_listings_status          ON listings(status);
CREATE INDEX IF NOT EXISTS idx_retry_queue_next_retry   ON retry_queue(next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity        ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id       ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS product_searches_batch_id_idx ON product_searches(batch_id);
CREATE INDEX IF NOT EXISTS upload_batches_status_idx     ON upload_batches(status);
CREATE INDEX IF NOT EXISTS upload_batches_winning_ocr_idx ON upload_batches(winning_ocr_result_id);
CREATE INDEX IF NOT EXISTS images_upload_session_idx     ON images(upload_session_id);
CREATE INDEX IF NOT EXISTS images_captured_at_idx        ON images(upload_session_id, captured_at);
CREATE INDEX IF NOT EXISTS upload_batches_session_idx    ON upload_batches(upload_session_id);

-- ---- updated_at triggers (004 + 007) ---------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles','ebay_connections','upload_batches','images',
    'product_searches','listings','retry_queue','upload_sessions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t
    );
  END LOOP;
END$$;
