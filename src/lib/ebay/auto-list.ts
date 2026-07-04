import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { createAndPublishListing } from './inventory'
import { getBusinessPolicies, type BusinessPolicies } from './policies'
import { generateListingImageUrls } from './image-urls'
import {
  pickLeafFromCategories,
  suggestLeafCategoryId,
  suggestLeafCategoryIds,
  ensureLeafCategoryId,
} from './taxonomy'
import { enqueueRetry } from '@/lib/retry'
import { generateListingDescription } from '@/lib/ai/generate-description'
import { parseListingFields, buildAspects, conditionStatement } from '@/lib/ai/parse-listing'
import { computeListingPrice, applyPriceFloor } from './pricing'
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

  // Pull comparables (for pricing), the OEM part number (the search query), and
  // the case number (used as the SKU and the "Case" aspect, per spec).
  const { data: searchRow } = await db
    .from('product_searches')
    .select('batch_id, results_raw, search_query')
    .eq('id', searchId)
    .single()
  const comparables = (searchRow?.results_raw as EbayItemSummary[] | null) ?? []
  const partNumber: string | null = searchRow?.search_query ?? null
  const resolvedBatchId = batchId ?? searchRow?.batch_id ?? null
  let caseNumber: string | null = null
  if (resolvedBatchId) {
    const { data: batchRow } = await db
      .from('upload_batches')
      .select('case_number')
      .eq('id', resolvedBatchId)
      .single()
    caseNumber = batchRow?.case_number ?? null
  }
  // SKU = case number (spec). Sanitize to eBay's allowed SKU charset.
  const sku = caseNumber
    ? caseNumber.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 50) || `SKU-${Date.now()}`
    : `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
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

  // Structured fields via AI: clean "Year Make Model Part OEM <PN>" title +
  // Brand/Placement/Color for the item aspects. Price = average of comparables
  // − 7% (spec: 5–8%), falling back to the best-match price, then floored at the
  // minimum ($29 by default, overridable via EBAY_MIN_PRICE) — no item ever
  // lists below the minimum (client spec).
  const fields = await parseListingFields(bestMatch.title, partNumber)
  const title = (fields?.title ?? bestMatch.title).slice(0, 80)
  const currency = bestMatch.price.currency || 'USD'
  const computedPrice = computeListingPrice(comparables, 7) ?? parseFloat(bestMatch.price.value)
  const price = applyPriceFloor(computedPrice)
  const condition = bestMatch.condition || 'USED_EXCELLENT'
  const aspects = buildAspects({ fields, partNumber, caseNumber })
  const conditionDescription = conditionStatement(fields?.brand ?? fields?.make ?? null)
  // Resolve a leaf category. Taxonomy is the trusted source: Browse-API
  // `categories` arrays are inconsistent (sometimes leaf-first, sometimes
  // root-first, sometimes a retired parent the seller listed against), and
  // listing in a non-leaf returns errorId=25005. Order:
  //   1. Taxonomy `get_category_suggestions` keyed off title (always a leaf
  //      per spec).
  //   2. Browse-API leaf as fallback if Taxonomy returned nothing.
  //   3. Walk the result through `ensureLeafCategoryId` as belt-and-suspenders.
  let categoryId = (await suggestLeafCategoryId(userId, title)) ?? ''
  if (!categoryId) {
    categoryId = pickLeafFromCategories(bestMatch.categories) ?? ''
    if (categoryId) {
      logger.info('Taxonomy returned no suggestion — falling back to Browse leaf', {
        category_id: categoryId,
      })
    }
  }
  if (categoryId) {
    const verified = await ensureLeafCategoryId(userId, categoryId)
    if (verified && verified !== categoryId) {
      logger.info('Walked Browse/Taxonomy category to descendant leaf', {
        from: categoryId,
        to: verified,
      })
      categoryId = verified
    } else if (!verified) {
      logger.warn('Could not verify category as a leaf; using as-is and trusting publish-time retry', {
        category_id: categoryId,
      })
    }
  }

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

  if (!Number.isFinite(price) || price <= 0) {
    const msg = `Invalid listing price: "${price}" (check EBAY_MIN_PRICE)`
    recordStep(steps, logger, 'Parse Match', 'fail', msg, { price })
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
    condition_description: conditionDescription,
    aspects,
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
  if (!listing.title || !listing.category_id) {
    const msg = 'Listing missing required fields (title, category)'
    recordStep(steps, logger, 'Load Listing', 'fail', msg, {
      has_title: !!listing.title,
      has_category: !!listing.category_id,
    })
    return { success: false, error: msg, steps }
  }

  // Resolve the price we'll actually send to eBay. Two things happen here:
  //   1. Coerce the stored value to a Number. The NUMERIC `price` column comes
  //      back from PostgREST as a *string*, which broke createAndPublishListing's
  //      Number.isFinite check → "empty/invalid: price".
  //   2. Floor at the minimum ($29 by default). Guarantees no live listing is
  //      below the minimum (client spec), including older drafts stored cheaper.
  const validatedPrice = applyPriceFloor(Number(listing.price))

  const sku = listing.sku ?? `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  recordStep(steps, logger, 'Load Listing', 'ok',
    `title="${listing.title}", price=${validatedPrice} ${listing.currency}, sku=${sku}, status was '${listing.status}'`,
    { sku, price: validatedPrice, prior_status: listing.status, search_id: listing.search_id },
  )

  // Persist the resolved price so the DB/queue/display stay consistent with
  // what we actually list at (older sub-minimum drafts get bumped to the floor).
  await db.from('listings').update({
    status: 'submitting',
    price: validatedPrice,
    attempt_count: (listing.attempt_count ?? 0) + 1,
    last_attempted_at: new Date().toISOString(),
    error_message: null,
  }).eq('id', listingId)

  // Resolve business policies (with the auto-opt-in inside getBusinessPolicies).
  let policies: BusinessPolicies
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

  async function attemptPublish(categoryId: string) {
    return createAndPublishListing({
      userId,
      sku,
      title: listing!.title,
      description: listing!.description ?? '',
      price: validatedPrice,
      currency: listing!.currency,
      quantity: listing!.quantity,
      condition: listing!.condition ?? 'USED_EXCELLENT',
      conditionDescription: listing!.condition_description ?? undefined,
      aspects: (listing!.aspects as Record<string, string[]> | null) ?? undefined,
      categoryId,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId: policies.paymentPolicyId,
      returnPolicyId: policies.returnPolicyId,
      storeCategory: process.env.EBAY_STORE_CATEGORY?.trim() || 'Inventory',
      imageUrls,
    })
  }

  try {
    let ebayListingId: string
    let listingUrl: string

    // Build the ordered list of category IDs we'll try, deduped. Start with the
    // saved draft, then every Taxonomy suggestion (5 most relevant). Each one
    // is walked through `ensureLeafCategoryId` lazily inside the loop.
    const tried = new Set<string>()
    const candidates: string[] = []
    const pushCandidate = (id: string | null | undefined) => {
      if (!id || tried.has(id)) return
      tried.add(id)
      candidates.push(id)
    }
    pushCandidate(listing.category_id)
    const suggestions = await suggestLeafCategoryIds(userId, listing.title, 5)
    for (const s of suggestions) pushCandidate(s.categoryId)
    // Last-resort env fallback — useful when every Taxonomy suggestion is in
    // eBay Motors and the seller isn't enrolled. Set to a non-Motors leaf
    // your account is permitted to list in (e.g. 99 = "Everything Else > Other").
    pushCandidate(process.env.EBAY_FALLBACK_CATEGORY_ID?.trim() || null)

    let lastErr: unknown
    let success = false
    let publishedFrom = listing.category_id
    for (const candidate of candidates) {
      const verified = (await ensureLeafCategoryId(userId, candidate)) ?? candidate
      try {
        ;({ listingId: ebayListingId, listingUrl } = await attemptPublish(verified))
        if (verified !== listing.category_id) {
          recordStep(steps, logger, 'Resolve Category', 'warn',
            `Replaced rejected category ${listing.category_id} → ${verified}`,
            { from: listing.category_id, to: verified, attempted: candidates.length },
          )
          await db.from('listings').update({ category_id: verified }).eq('id', listingId)
        }
        publishedFrom = verified
        success = true
        break
      } catch (err) {
        const { ctx } = describeEbayError(err)
        const isBadCategory = ctx.errors?.some((e) => e.errorId === 25005)
        if (!isBadCategory) throw err // unrelated failure — don't keep trying
        lastErr = err
        logger.warn('Category rejected with 25005 — trying next candidate', {
          rejected: verified,
          remaining: candidates.length - candidates.indexOf(candidate) - 1,
        })
      }
    }
    if (!success) {
      // Surface an actionable message instead of a raw eBay code. Mercedes,
      // BMW, etc. titles map to eBay Motors categories; if the seller isn't
      // enrolled, every Taxonomy suggestion gets rejected.
      const titleLooksAutomotive = /\b(mercedes|bmw|audi|ford|honda|toyota|chevrolet|vw|volkswagen|nissan|porsche|lexus|jeep|ram|gmc|hyundai|kia|tesla|dashboard|bumper|fender|headlight|taillight|engine)\b/i.test(
        listing.title,
      )
      const hint = titleLooksAutomotive
        ? ` This usually means your eBay account isn't enrolled in eBay Motors Parts & Accessories. ` +
          `Either enroll on eBay Seller Hub, set EBAY_FALLBACK_CATEGORY_ID to a non-Motors leaf, ` +
          `or override this listing's category manually below.`
        : ` Set EBAY_FALLBACK_CATEGORY_ID, or override this listing's category manually below.`
      const friendly = new Error(
        `eBay rejected every category we tried (${candidates.join(', ')}).` + hint,
      )
      recordStep(steps, logger, 'Resolve Category', 'fail',
        friendly.message,
        { attempted: candidates.length, candidates },
      )
      throw friendly
    }
    // Type narrowing: success === true guarantees these were assigned above.
    ebayListingId = ebayListingId!
    listingUrl = listingUrl!
    void publishedFrom

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
