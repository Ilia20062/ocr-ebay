export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; email: string; full_name: string | null; created_at: string; updated_at: string }
        Insert: { id: string; email: string; full_name?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; email?: string; full_name?: string | null; updated_at?: string }
        Relationships: []
      }
      ebay_connections: {
        Row: { id: string; user_id: string; access_token: string; refresh_token: string; token_expires_at: string; ebay_user_id: string | null; marketplace_id: string; created_at: string; updated_at: string }
        Insert: { id?: string; user_id: string; access_token: string; refresh_token: string; token_expires_at: string; ebay_user_id?: string | null; marketplace_id?: string; created_at?: string; updated_at?: string }
        Update: { access_token?: string; refresh_token?: string; token_expires_at?: string; ebay_user_id?: string | null; marketplace_id?: string; updated_at?: string }
        Relationships: []
      }
      upload_batches: {
        Row: { id: string; user_id: string; status: string; total_images: number; processed: number; winning_ocr_result_id: string | null; final_code: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; user_id: string; status?: string; total_images?: number; processed?: number; winning_ocr_result_id?: string | null; final_code?: string | null; created_at?: string; updated_at?: string }
        Update: { status?: string; total_images?: number; processed?: number; winning_ocr_result_id?: string | null; final_code?: string | null; updated_at?: string }
        Relationships: []
      }
      images: {
        Row: { id: string; batch_id: string; user_id: string; storage_path: string; original_filename: string | null; file_size_bytes: number | null; mime_type: string | null; status: string; error_message: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; batch_id: string; user_id: string; storage_path: string; original_filename?: string | null; file_size_bytes?: number | null; mime_type?: string | null; status?: string; error_message?: string | null; created_at?: string; updated_at?: string }
        Update: { status?: string; error_message?: string | null; updated_at?: string }
        Relationships: []
      }
      ocr_results: {
        Row: { id: string; image_id: string; raw_response: Json | null; extracted_text: string | null; extracted_code: string | null; all_candidates: Json | null; confidence: number | null; provider: string; auto_approved: boolean; manual_override: string | null; reviewed_by: string | null; reviewed_at: string | null; created_at: string }
        Insert: { id?: string; image_id: string; raw_response?: Json | null; extracted_text?: string | null; extracted_code?: string | null; all_candidates?: Json | null; confidence?: number | null; provider?: string; auto_approved?: boolean; manual_override?: string | null; reviewed_by?: string | null; reviewed_at?: string | null; created_at?: string }
        Update: { raw_response?: Json | null; extracted_text?: string | null; extracted_code?: string | null; all_candidates?: Json | null; confidence?: number | null; auto_approved?: boolean; manual_override?: string | null; reviewed_by?: string | null; reviewed_at?: string | null }
        Relationships: []
      }
      product_searches: {
        Row: { id: string; batch_id: string; search_query: string; search_provider: string; status: string; result_count: number | null; results_raw: Json | null; selected_item_id: string | null; error_message: string | null; attempt_count: number; created_at: string; updated_at: string }
        Insert: { id?: string; batch_id: string; search_query: string; search_provider?: string; status?: string; result_count?: number | null; results_raw?: Json | null; selected_item_id?: string | null; error_message?: string | null; attempt_count?: number; created_at?: string; updated_at?: string }
        Update: { status?: string; result_count?: number | null; results_raw?: Json | null; selected_item_id?: string | null; error_message?: string | null; attempt_count?: number; updated_at?: string }
        Relationships: []
      }
      listings: {
        Row: { id: string; search_id: string; user_id: string; ebay_item_id: string | null; ebay_listing_url: string | null; title: string; description: string | null; price: number | null; currency: string; quantity: number; condition: string | null; category_id: string | null; sku: string | null; status: string; error_message: string | null; error_code: string | null; attempt_count: number; last_attempted_at: string | null; listed_at: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; search_id: string; user_id: string; ebay_item_id?: string | null; ebay_listing_url?: string | null; title: string; description?: string | null; price?: number | null; currency?: string; quantity?: number; condition?: string | null; category_id?: string | null; sku?: string | null; status?: string; error_message?: string | null; error_code?: string | null; attempt_count?: number; last_attempted_at?: string | null; listed_at?: string | null; created_at?: string; updated_at?: string }
        Update: { ebay_item_id?: string | null; ebay_listing_url?: string | null; title?: string; description?: string | null; price?: number | null; quantity?: number; condition?: string | null; category_id?: string | null; status?: string; error_message?: string | null; error_code?: string | null; attempt_count?: number; last_attempted_at?: string | null; listed_at?: string | null; updated_at?: string }
        Relationships: []
      }
      retry_queue: {
        Row: { id: string; entity_type: string; entity_id: string; reason: string | null; attempt_count: number; max_attempts: number; next_retry_at: string; status: string; created_at: string; updated_at: string }
        Insert: { id?: string; entity_type: string; entity_id: string; reason?: string | null; attempt_count?: number; max_attempts?: number; next_retry_at: string; status?: string; created_at?: string; updated_at?: string }
        Update: { attempt_count?: number; next_retry_at?: string; status?: string; updated_at?: string }
        Relationships: []
      }
      audit_logs: {
        Row: { id: string; user_id: string | null; entity_type: string | null; entity_id: string | null; action: string; old_value: Json | null; new_value: Json | null; ip_address: string | null; created_at: string }
        Insert: { id?: string; user_id?: string | null; entity_type?: string | null; entity_id?: string | null; action: string; old_value?: Json | null; new_value?: Json | null; ip_address?: string | null; created_at?: string }
        Update: Record<string, never>
        Relationships: []
      }
    }
    Views: {
      ocr_results_with_final_code: {
        Row: { id: string; image_id: string; extracted_code: string | null; manual_override: string | null; auto_approved: boolean; final_code: string | null; confidence: number | null; provider: string; created_at: string }
        Relationships: []
      }
    }
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
