-- 007_upload_sessions.sql
-- Auto-grouping uploads: one upload session can produce many batches.
-- Validated against test data D:\OCR Project\ocr-crm\3694 09.04.2026 IRA\
-- (257 files → 36 product batches via timestamp + label-anchor clustering).

BEGIN;

-- Parent of N batches produced by one auto-grouping pass.
CREATE TABLE upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading','grouping','processing','review_ready','done','failed')),
  total_images INT NOT NULL DEFAULT 0,
  group_count INT NOT NULL DEFAULT 0,
  lot_label TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An image lives under a session until grouping assigns a batch.
ALTER TABLE images
  ADD COLUMN upload_session_id UUID REFERENCES upload_sessions(id) ON DELETE CASCADE,
  ADD COLUMN captured_at TIMESTAMPTZ,
  ADD COLUMN is_label_candidate BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN batch_id DROP NOT NULL;

ALTER TABLE upload_batches
  ADD COLUMN upload_session_id UUID REFERENCES upload_sessions(id) ON DELETE CASCADE,
  ADD COLUMN auto_grouped BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX images_upload_session_idx ON images(upload_session_id);
CREATE INDEX images_captured_at_idx ON images(upload_session_id, captured_at);
CREATE INDEX upload_batches_session_idx ON upload_batches(upload_session_id);

ALTER TABLE upload_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "upload_sessions_own" ON upload_sessions FOR ALL
  USING (user_id = auth.uid());

-- Trigger to keep upload_sessions.updated_at fresh, mirroring the convention used
-- on the other mutable tables (see 004_triggers.sql).
CREATE OR REPLACE FUNCTION touch_upload_sessions_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER upload_sessions_updated_at
  BEFORE UPDATE ON upload_sessions
  FOR EACH ROW EXECUTE FUNCTION touch_upload_sessions_updated_at();

COMMIT;
