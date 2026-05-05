export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export type BatchStatus =
  | 'pending'
  | 'processing'
  | 'awaiting_review'
  | 'approved'
  | 'listed'
  | 'failed'
  | 'discarded'
export type ImageStatus = 'uploaded' | 'ocr_processing' | 'ocr_done' | 'needs_review' | 'approved' | 'failed' | 'discarded'
export type SearchStatus = 'pending' | 'success' | 'no_results' | 'failed'
export type ListingStatus = 'draft' | 'submitting' | 'active' | 'failed' | 'ended'
export type RetryStatus = 'pending' | 'processing' | 'succeeded' | 'exhausted'
export type EntityType = 'image' | 'product_search' | 'listing'

export interface Profile {
  id: string
  email: string
  full_name: string | null
  created_at: string
  updated_at: string
}

export interface EbayConnection {
  id: string
  user_id: string
  access_token: string
  refresh_token: string
  token_expires_at: string
  ebay_user_id: string | null
  marketplace_id: string
  created_at: string
  updated_at: string
}

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

export interface Image {
  id: string
  batch_id: string
  user_id: string
  storage_path: string
  original_filename: string | null
  file_size_bytes: number | null
  mime_type: string | null
  status: ImageStatus
  created_at: string
  updated_at: string
}

export interface OcrResult {
  id: string
  image_id: string
  raw_response: Json | null
  extracted_text: string | null
  extracted_code: string | null
  all_candidates: Json | null
  confidence: number | null
  provider: string
  auto_approved: boolean
  manual_override: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  final_code?: string | null
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

export interface Listing {
  id: string
  search_id: string
  user_id: string
  ebay_item_id: string | null
  ebay_listing_url: string | null
  title: string
  description: string | null
  price: number | null
  currency: string
  quantity: number
  condition: string | null
  category_id: string | null
  sku: string | null
  status: ListingStatus
  error_message: string | null
  error_code: string | null
  attempt_count: number
  last_attempted_at: string | null
  listed_at: string | null
  created_at: string
  updated_at: string
}

export interface RetryQueueItem {
  id: string
  entity_type: EntityType
  entity_id: string
  reason: string | null
  attempt_count: number
  max_attempts: number
  next_retry_at: string
  status: RetryStatus
  created_at: string
  updated_at: string
}

export interface AuditLog {
  id: string
  user_id: string | null
  entity_type: string | null
  entity_id: string | null
  action: string
  old_value: Json | null
  new_value: Json | null
  ip_address: string | null
  created_at: string
}
