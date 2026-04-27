import { getSupabaseAdminClient } from './supabase/admin'
import type { EntityType } from '@/types/database'

const BACKOFF_MINUTES = [5, 15, 60]

export async function enqueueRetry(
  entityType: EntityType,
  entityId: string,
  reason: string,
  currentAttempt = 0
) {
  const db = getSupabaseAdminClient()
  const delayMinutes = BACKOFF_MINUTES[Math.min(currentAttempt, BACKOFF_MINUTES.length - 1)]
  const nextRetryAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()

  await db.from('retry_queue').upsert({
    entity_type: entityType,
    entity_id: entityId,
    reason,
    attempt_count: currentAttempt,
    next_retry_at: nextRetryAt,
    status: 'pending',
  }, { onConflict: 'entity_id' })
}

export async function markRetrySucceeded(entityId: string) {
  const db = getSupabaseAdminClient()
  await db.from('retry_queue')
    .update({ status: 'succeeded' })
    .eq('entity_id', entityId)
}

export async function markRetryExhausted(entityId: string) {
  const db = getSupabaseAdminClient()
  await db.from('retry_queue')
    .update({ status: 'exhausted' })
    .eq('entity_id', entityId)
}
