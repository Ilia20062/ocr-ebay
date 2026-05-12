import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { createAndPublishListing } from './inventory'
import { getBusinessPolicies } from './policies'
import { enqueueRetry } from '@/lib/retry'
import { generateListingDescription } from '@/lib/ai/generate-description'
import { describeEbayError } from './error'
import { withContext, type LogContext } from '@/lib/log'
import type { EbayItemSummary } from '@/types/ebay'

interface AutoListParams {
  userId: string
  searchId: string
  batchId?: string | null
  bestMatch: EbayItemSummary
  imageUrls: string[]
}

export type AutoListStepStatus = 'ok' | 'warn' | 'fail'

export interface AutoListStep {
  step: string
  status: AutoListStepStatus
  detail: string
  timestamp: string
  /** Structured payload for debugging (status_code, request_id, ebay error codes, …). */
  context?: Record<string, unknown>
}

export interface AutoListResult {
  success: boolean
  listingUrl?: string
  listingId?: string
  error?: string
  steps: AutoListStep[]
}

function clean(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined || v === null || v === '') continue
    out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

function recordStep(
  steps: AutoListStep[],
  logger: ReturnType<typeof withContext>,
  step: string,
  status: AutoListStepStatus,
  detail: string,
  context?: Record<string, unknown>,
): void {
  const cleaned = clean(context)
  const entry: AutoListStep = {
    step,
    status,
    detail,
    timestamp: new Date().toISOString(),
    ...(cleaned ? { context: cleaned } : {}),
  }
  steps.push(entry)

  const logCtx: LogContext = { step, ...(cleaned ?? {}) }
  if (status === 'ok') logger.info(`step ok — ${step}: ${detail}`, logCtx)
  else if (status === 'warn') logger.warn(`step warn — ${step}: ${detail}`, logCtx)
  else logger.error(`step fail — ${step}: ${detail}`, logCtx)
}

/**
 * Automatically creates and publishes an eBay listing from a product search result.
 * Returns step-by-step results AND emits structured logs so a single search_id /
 * sku is grep-able across the whole pipeline.
 */
export async function autoCreateListing({
  userId,
  searchId,
  batchId,
  bestMatch,
  imageUrls,
}: AutoListParams): Promise<AutoListResult> {
  const steps: AutoListStep[] = []
  const db = getSupabaseAdminClient()
  const sku = `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const logger = withContext({
    scope: 'ebay.auto-list',
    user_id: userId,
    search_id: searchId,
    batch_id: batchId ?? null,
    sku,
  })

  logger.info('auto-list START', {
    ebay_item_id: bestMatch.itemId,
    images: imageUrls.length,
  })

  // Step 1: Parse best match data
  const title = bestMatch.title.slice(0, 80)
  const price = parseFloat(bestMatch.price.value)
  const currency = bestMatch.price.currency || 'USD'
  const condition = bestMatch.condition || 'USED_EXCELLENT'
  const categoryId = bestMatch.categories?.[0]?.categoryId || ''

  recordStep(steps, logger, 'Parse Match', 'ok',
    `title="${title}", price=${price} ${currency}, condition=${condition}, category=${categoryId || 'NONE'}, sku=${sku}`,
    { title_len: title.length, price, currency, condition, category_id: categoryId },
  )
  recordStep(steps, logger, 'Image URLs', 'ok',
    `${imageUrls.length} image(s) attached to listing`,
    { images: imageUrls.length },
  )

  if (!categoryId) {
    const msg = 'No categoryId found on the matched product. eBay requires a category to list.'
    recordStep(steps, logger, 'Parse Match', 'fail', msg, { ebay_item_id: bestMatch.itemId })
    return { success: false, error: 'No category found on matched product', steps }
  }

  if (isNaN(price) || price <= 0) {
    const msg = `Invalid price: "${bestMatch.price.value}"`
    recordStep(steps, logger, 'Parse Match', 'fail', msg, { price_raw: bestMatch.price.value })
    return { success: false, error: msg, steps }
  }

  // Step 2: Generate AI-powered eBay description via OpenRouter
  const aiResult = await generateListingDescription(title, {
    searchId,
    batchId: batchId ?? null,
    sku,
    userId,
  })

  if (aiResult.source === 'ai') {
    recordStep(steps, logger, 'Generate Description', 'ok',
      `AI description generated (${aiResult.description.length} chars, ${aiResult.attempts} attempt(s), ${aiResult.durMs}ms)`,
      {
        source: 'ai',
        model: aiResult.model,
        request_id: aiResult.requestId,
        response_id: aiResult.responseId,
        prompt_tokens: aiResult.promptTokens,
        completion_tokens: aiResult.completionTokens,
        total_tokens: aiResult.totalTokens,
        dur_ms: aiResult.durMs,
        attempts: aiResult.attempts,
        chars: aiResult.description.length,
        finish_reason: aiResult.finishReason,
      },
    )
  } else {
    recordStep(steps, logger, 'Generate Description', 'warn',
      `AI generation failed after ${aiResult.attempts} attempt(s) — using fallback placeholder. Cause: ${aiResult.error ?? 'unknown'}`,
      {
        source: 'fallback',
        model: aiResult.model,
        request_id: aiResult.requestId,
        last_status: aiResult.lastStatus,
        dur_ms: aiResult.durMs,
        attempts: aiResult.attempts,
        err: aiResult.error,
      },
    )
  }
  const description = aiResult.description

  // Step 3: Create draft listing in DB
  const { data: listing, error: insertError } = await db.from('listings').insert({
    search_id: searchId,
    user_id: userId,
    title,
    description,
    price,
    currency,
    quantity: 1,
    condition,
    category_id: categoryId,
    sku,
    status: 'submitting',
    last_attempted_at: new Date().toISOString(),
  }).select().single()

  if (insertError || !listing) {
    const msg = insertError?.message ?? 'unknown error'
    recordStep(steps, logger, 'Create Draft', 'fail', `DB insert failed: ${msg}`, {
      pg_code: insertError?.code,
      pg_details: insertError?.details,
      pg_hint: insertError?.hint,
    })
    return { success: false, error: `DB insert failed: ${msg}`, steps }
  }

  recordStep(steps, logger, 'Create Draft', 'ok', `Draft listing created in DB: ${listing.id}`, {
    listing_id: listing.id,
  })

  // Step 4: Fetch business policies
  let policies
  try {
    policies = await getBusinessPolicies(userId)
    recordStep(steps, logger, 'Fetch Policies', 'ok',
      `fulfillment=${policies.fulfillmentPolicyId}, payment=${policies.paymentPolicyId}, return=${policies.returnPolicyId}`,
      {
        fulfillment_policy_id: policies.fulfillmentPolicyId,
        payment_policy_id: policies.paymentPolicyId,
        return_policy_id: policies.returnPolicyId,
      },
    )
  } catch (err) {
    const { summary, ctx: errCtx } = describeEbayError(err)
    recordStep(steps, logger, 'Fetch Policies', 'fail', summary, {
      ...errCtx,
      listing_id: listing.id,
    })
    await db.from('listings').update({
      status: 'failed',
      error_message: `Policies: ${summary}`.slice(0, 2000),
    }).eq('id', listing.id)
    await enqueueRetry('listing', listing.id, summary)
    return { success: false, error: summary, steps }
  }

  // Step 5: Create inventory item & publish on eBay
  try {
    const { listingId, listingUrl } = await createAndPublishListing({
      userId,
      sku,
      title,
      description,
      price,
      currency,
      quantity: 1,
      condition,
      categoryId,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId: policies.paymentPolicyId,
      returnPolicyId: policies.returnPolicyId,
      imageUrls,
    })

    recordStep(steps, logger, 'Publish to eBay', 'ok',
      `Listed! listingId=${listingId}, url=${listingUrl}`,
      { listing_id: listing.id, ebay_listing_id: listingId, ebay_listing_url: listingUrl },
    )

    // Step 6: Update DB with eBay details
    const { error: updateErr } = await db.from('listings').update({
      ebay_item_id: listingId,
      ebay_listing_url: listingUrl,
      status: 'active',
      listed_at: new Date().toISOString(),
    }).eq('id', listing.id)

    if (updateErr) {
      recordStep(steps, logger, 'Update DB', 'warn',
        `Listing went live on eBay but DB update failed: ${updateErr.message}`,
        { listing_id: listing.id, pg_code: updateErr.code },
      )
    } else {
      recordStep(steps, logger, 'Update DB', 'ok', 'Listing marked as active', {
        listing_id: listing.id,
      })
    }

    logger.info('auto-list DONE', { listing_id: listing.id, ebay_listing_id: listingId })
    return { success: true, listingUrl, listingId, steps }
  } catch (err) {
    const { summary, ctx: errCtx } = describeEbayError(err)
    recordStep(steps, logger, 'Publish to eBay', 'fail', summary, {
      ...errCtx,
      listing_id: listing.id,
    })

    await db.from('listings').update({
      status: 'failed',
      error_message: summary.slice(0, 2000),
    }).eq('id', listing.id)

    await enqueueRetry('listing', listing.id, summary)
    return { success: false, error: summary, steps }
  }
}
