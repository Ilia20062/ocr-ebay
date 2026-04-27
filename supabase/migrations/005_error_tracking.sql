-- Add error_message to images for direct failure visibility
ALTER TABLE images ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Add unique constraint on retry_queue.entity_id so upsert works
ALTER TABLE retry_queue ADD CONSTRAINT retry_queue_entity_id_unique UNIQUE (entity_id);
