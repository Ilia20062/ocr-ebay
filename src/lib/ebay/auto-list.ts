import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { createAndPublishListing } from './inventory'
import { getBusinessPolicies } from './policies'
import { enqueueRetry } from '@/lib/retry'
import { generateListingDescription } from '@/lib/ai/generate-description'
import type { EbayItemSummary } from '@/types/ebay'

interface AutoListParams {
  userId: string
  searchId: string
  bestMatch: EbayItemSummary
  imageUrls: string[]
}

export interface AutoListStep {
  step: string
  status: 'ok' | 'fail'
  detail: string
  timestamp: string
}

export interface AutoListResult {
  success: boolean
  listingUrl?: string
  error?: string
  steps: AutoListStep[]
}

function log(steps: AutoListStep[], step: string, status: 'ok' | 'fail', detail: string) {
  const entry: AutoListStep = { step, status, detail, timestamp: new Date().toISOString() }
  steps.push(entry)
  if (status === 'ok') {
    console.log(`[auto-list] ✅ ${step}: ${detail}`)
  } else {
    console.error(`[auto-list] ❌ ${step}: ${detail}`)
  }
}

/**
 * Automatically creates and publishes an eBay listing from a product search result.
 * Returns detailed step-by-step results so the UI can show exactly what happened.
 */
export async function autoCreateListing({ userId, searchId, bestMatch, imageUrls }: AutoListParams): Promise<AutoListResult> {
  const steps: AutoListStep[] = []
  const db = getSupabaseAdminClient()
  const sku = `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`

  // Step 1: Parse best match data
  const title = bestMatch.title.slice(0, 80)
  const price = parseFloat(bestMatch.price.value)
  const currency = bestMatch.price.currency || 'USD'
  const condition = bestMatch.condition || 'USED_EXCELLENT'
  const categoryId = bestMatch.categories?.[0]?.categoryId || ''

  log(steps, 'Parse Match', 'ok', `title="${title}", price=${price} ${currency}, condition=${condition}, category=${categoryId || 'NONE'}, sku=${sku}`)
  log(steps, 'Image URLs', 'ok', `${imageUrls.length} image(s) attached to listing`)

  // Step 1b: Generate AI-powered eBay description via OpenRouter
  const descResult = await generateListingDescription(title)
  if (descResult.usedFallback) {
    log(steps, 'Generate Description', 'fail',
      `AI description unavailable — using fallback. Reason: ${descResult.error ?? 'unknown'}`)
  } else {
    log(steps, 'Generate Description', 'ok',
      `AI description generated (${descResult.description.length} chars)`)
  }
  const description = descResult.description


  if (!categoryId) {
    log(steps, 'Parse Match', 'fail', 'No categoryId found on the matched product. eBay requires a category to list.')
    return { success: false, error: 'No category found on matched product', steps }
  }

  if (isNaN(price) || price <= 0) {
    log(steps, 'Parse Match', 'fail', `Invalid price: "${bestMatch.price.value}"`)
    return { success: false, error: `Invalid price: ${bestMatch.price.value}`, steps }
  }

  // Step 2: Create draft listing in DB
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
    log(steps, 'Create Draft', 'fail', `DB insert failed: ${insertError?.message ?? 'unknown error'}`)
    return { success: false, error: `DB insert failed: ${insertError?.message ?? 'unknown'}`, steps }
  }

  log(steps, 'Create Draft', 'ok', `Draft listing created in DB: ${listing.id}`)

  // Step 3: Fetch business policies
  let policies
  try {
    policies = await getBusinessPolicies(userId)
    log(steps, 'Fetch Policies', 'ok', `fulfillment=${policies.fulfillmentPolicyId}, payment=${policies.paymentPolicyId}, return=${policies.returnPolicyId}`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log(steps, 'Fetch Policies', 'fail', errMsg)
    await db.from('listings').update({ status: 'failed', error_message: `Policies: ${errMsg}` }).eq('id', listing.id)
    await enqueueRetry('listing', listing.id, errMsg)
    return { success: false, error: errMsg, steps }
  }

  // Step 4: Create inventory item on eBay
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

    log(steps, 'Publish to eBay', 'ok', `Listed! listingId=${listingId}, url=${listingUrl}`)

    // Step 5: Update DB with eBay details
    await db.from('listings').update({
      ebay_item_id: listingId,
      ebay_listing_url: listingUrl,
      status: 'active',
      listed_at: new Date().toISOString(),
    }).eq('id', listing.id)

    log(steps, 'Update DB', 'ok', 'Listing marked as active')
    return { success: true, listingUrl, steps }
  } catch (err) {
    // Extract detailed eBay error info
    let errMsg: string
    if (err && typeof err === 'object' && 'response' in err) {
      const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string }
      const statusCode = axiosErr.response?.status ?? 'unknown'
      const responseData = JSON.stringify(axiosErr.response?.data ?? {})
      errMsg = `eBay API ${statusCode}: ${responseData}`
    } else {
      errMsg = err instanceof Error ? err.message : String(err)
    }

    log(steps, 'Publish to eBay', 'fail', errMsg)

    await db.from('listings').update({
      status: 'failed',
      error_message: errMsg.slice(0, 2000),
    }).eq('id', listing.id)

    await enqueueRetry('listing', listing.id, errMsg)
    return { success: false, error: errMsg, steps }
  }
}
