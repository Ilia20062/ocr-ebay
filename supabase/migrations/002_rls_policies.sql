-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ebay_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE retry_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- profiles: users see only their own
CREATE POLICY "profiles_own" ON profiles FOR ALL USING (id = auth.uid());

-- ebay_connections: users see only their own
CREATE POLICY "ebay_connections_own" ON ebay_connections FOR ALL USING (user_id = auth.uid());

-- upload_batches: users see only their own
CREATE POLICY "upload_batches_own" ON upload_batches FOR ALL USING (user_id = auth.uid());

-- images: users see only their own
CREATE POLICY "images_own" ON images FOR ALL USING (user_id = auth.uid());

-- ocr_results: users see results for their own images
CREATE POLICY "ocr_results_own" ON ocr_results FOR ALL USING (
  image_id IN (SELECT id FROM images WHERE user_id = auth.uid())
);

-- product_searches: users see searches for their own ocr_results
CREATE POLICY "product_searches_own" ON product_searches FOR ALL USING (
  ocr_result_id IN (
    SELECT id FROM ocr_results WHERE image_id IN (
      SELECT id FROM images WHERE user_id = auth.uid()
    )
  )
);

-- listings: users see only their own
CREATE POLICY "listings_own" ON listings FOR ALL USING (user_id = auth.uid());

-- retry_queue: users see retries for their own entities (service role bypasses for cron)
CREATE POLICY "retry_queue_service_only" ON retry_queue FOR ALL USING (
  current_setting('role') = 'service_role'
);

-- audit_logs: users see only their own
CREATE POLICY "audit_logs_own" ON audit_logs FOR SELECT USING (user_id = auth.uid());
