import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { createAndPublishListing } from './inventory'
import { getBusinessPolicies } from './policies'
import { generateListingImageUrls } from './image-urls'
import { enqueueRetry } from '@/lib/retry'
import { generateListingDescription } from '@/lib/ai/generate-description'
import { describeEbayError } from './error'
import { withContext, type LogContext } from '@/lib/log'
import type { EbayItemSummary } from '@/types/ebay'

interface DraftParams {
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

export interface DraftListingResult {
  success: boolean
  /** Internal DB row id once the listing has been persisted as a draft. */
  listingId?: string
  /** AI-generated description body. */
  description?: string
  /** Whether the description came from OpenRouter or the placeholder fallback. */
  descriptionSource?: 'ai' | 'fallback'
  error?: string
  steps: AutoListStep[]
}

export interface PublishListingResult {
  success: boolean
  ebayListingId?: string
  ebayListingUrl?: string
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
 * Creates a *draft* listing from an eBay best-match result. Generates the AI
 * description and inserts a row into `listings` with `status='draft'`. Does
 * NOT contact eBay's Sell APIs. The user reviews the draft on the listings
 * page and explicitly clicks "Publish to eBay" to invoke `publishListing`.
 */
export async function autoCreateDraftListing({
  userId,
  searchId,
  batchId,
  bestMatch,
  imageUrls,
}: DraftParams): Promise<DraftListingResult> {
  const steps: AutoListStep[] = []
  const db = getSupabaseAdminClient()
  const sku = `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const logger = withContext({
    scope: 'ebay.draft',
    user_id: userId,
    search_id: searchId,
    batch_id: batchId ?? null,
    sku,
  })

  logger.info('draft START', {
    ebay_item_id: bestMatch.itemId,
    images: imageUrls.length,
  })

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

  // Generate AI-powered eBay description via OpenRouter
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

  // Insert draft row. `status='draft'` means "ready for user review, NOT yet
  // pushed to eBay". The Publish button on /listings turns this into 'active'.
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
    status: 'draft',
  }).select().single()

  if (insertError || !listing) {
    const msg = insertError?.message ?? 'unknown error'
    recordStep(steps, logger, 'Save Draft', 'fail', `DB insert failed: ${msg}`, {
      pg_code: insertError?.code,
      pg_details: insertError?.details,
      pg_hint: insertError?.hint,
    })
    return { success: false, error: `DB insert failed: ${msg}`, steps }
  }

  recordStep(steps, logger, 'Save Draft', 'ok',
    `Draft saved — open /listings and click Publish to eBay when ready (listing_id=${listing.id})`,
    { listing_id: listing.id },
  )

  logger.info('draft DONE — awaiting user publish', { listing_id: listing.id })

  return {
    success: true,
    listingId: listing.id,
    description,
    descriptionSource: aiResult.source,
    steps,
  }
}

/**
 * Publishes an existing draft (or retries a previously failed) listing to
 * eBay. Resolves business policies (auto-opting-in if needed), re-signs image
 * URLs from the originating batch, then calls the Sell APIs.
 *
 * Called by both `POST /api/listings/[id]/publish` (the user's explicit
 * publish action from the listings page) and `POST /api/listings/[id]/retry`
 * (which is now just a synonym for publish).
 */
export async function publishListing(
  userId: string,
  listingId: string,
): Promise<PublishListingResult> {
  const steps: AutoListStep[] = []
  const db = getSupabaseAdminClient()
  const logger = withContext({
    scope: 'ebay.publish',
    user_id: userId,
    listing_id: listingId,
  })

  logger.info('publish START')

  const { data: listing, error: lookupErr } = await db
    .from('listings')
    .select('*')
    .eq('id', listingId)
    .eq('user_id', userId)
    .single()

  if (lookupErr || !listing) {
    const msg = lookupErr?.message ?? 'not found'
    recordStep(steps, logger, 'Load Listing', 'fail', msg)
    return { success: false, error: msg, steps }
  }
  if (listing.status === 'active') {
    recordStep(steps, logger, 'Load Listing', 'fail', 'Listing already active on eBay')
    return { success: false, error: 'Listing already active', steps }
  }
  if (!listing.title || listing.price === null || !listing.category_id) {
    const msg = 'Listing missing required fields (title, price, category)'
    recordStep(steps, logger, 'Load Listing', 'fail', msg, {
      has_title: !!listing.title,
      has_price: listing.price !== null,
      has_category: !!listing.category_id,
    })
    return { success: false, error: msg, steps }
  }

  const sku = listing.sku ?? `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  recordStep(steps, logger, 'Load Listing', 'ok',
    `title="${listing.title}", price=${listing.price} ${listing.currency}, sku=${sku}, status was '${listing.status}'`,
    { sku, prior_status: listing.status, search_id: listing.search_id },
  )

  await db.from('listings').update({
    status: 'submitting',
    attempt_count: (listing.attempt_count ?? 0) + 1,
    last_attempted_at: new Date().toISOString(),
    error_message: null,
  }).eq('id', listingId)

  // Resolve business policies (with the auto-opt-in inside getBusinessPolicies).
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
    const { summary, ctx } = describeEbayError(err)
    recordStep(steps, logger, 'Fetch Policies', 'fail', summary, { ...ctx })
    await db.from('listings').update({
      status: 'failed',
      error_message: `Policies: ${summary}`.slice(0, 2000),
    }).eq('id', listingId)
    await enqueueRetry('listing', listingId, summary)
    return { success: false, error: summary, steps }
  }

  // Re-derive image URLs (signed URLs from draft creation will have expired).
  let imageUrls: string[] = []
  if (listing.search_id) {
    const { data: search } = await db
      .from('product_searches')
      .select('batch_id')
      .eq('id', listing.search_id)
      .single()
    if (search?.batch_id) {
      const { data: imgs } = await db
        .from('images')
        .select('id, storage_path')
        .eq('batch_id', search.batch_id)
        .order('created_at', { ascending: true })
      imageUrls = await generateListingImageUrls(db, imgs ?? [])
    }
  }
  recordStep(steps, logger, 'Re-sign Images', 'ok',
    `${imageUrls.length} fresh signed image URL(s) prepared`,
    { images: imageUrls.length },
  )

  try {
    const { listingId: ebayListingId, listingUrl } = await createAndPublishListing({
      userId,
      sku,
      title: listing.title,
      description: listing.description ?? '',
      price: listing.price,
      currency: listing.currency,
      quantity: listing.quantity,
      condition: listing.condition ?? 'USED_EXCELLENT',
      categoryId: listing.category_id,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId: policies.paymentPolicyId,
      returnPolicyId: policies.returnPolicyId,
      imageUrls,
    })

    recordStep(steps, logger, 'Publish to eBay', 'ok',
      `Listed! listingId=${ebayListingId}, url=${listingUrl}`,
      { ebay_listing_id: ebayListingId, ebay_listing_url: listingUrl },
    )

    const { error: updateErr } = await db.from('listings').update({
      ebay_item_id: ebayListingId,
      ebay_listing_url: listingUrl,
      status: 'active',
      listed_at: new Date().toISOString(),
      error_message: null,
    }).eq('id', listingId)

    if (updateErr) {
      recordStep(steps, logger, 'Update DB', 'warn',
        `Listing went live on eBay but DB update failed: ${updateErr.message}`,
        { pg_code: updateErr.code },
      )
    } else {
      recordStep(steps, logger, 'Update DB', 'ok', 'Listing marked as active')
    }

    logger.info('publish DONE', { ebay_listing_id: ebayListingId })
    return { success: true, ebayListingId, ebayListingUrl: listingUrl, steps }
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    recordStep(steps, logger, 'Publish to eBay', 'fail', summary, { ...ctx })

    await db.from('listings').update({
      status: 'failed',
      error_message: summary.slice(0, 2000),
    }).eq('id', listingId)

    await enqueueRetry('listing', listingId, summary)
    return { success: false, error: summary, steps }
  }
}
