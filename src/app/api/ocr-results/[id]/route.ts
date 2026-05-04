import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { ocrReviewSchema } from '@/lib/validators/ocr'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { autoCreateListing } from '@/lib/ebay/auto-list'
import type { AutoListResult } from '@/lib/ebay/auto-list'
import { enqueueRetry } from '@/lib/retry'
import type { OcrResult } from '@/types/database'
import type { Json, Database } from '@/types/supabase'

type OcrWithImage = OcrResult & { images: { id: string; user_id: string; storage_path: string; original_filename: string | null } }

export const GET = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('ocr_results')
    .select('*, images!inner(id, user_id, storage_path, original_filename)')
    .eq('id', params!.id)
    .single()

  if (error || !data) return apiError('OCR result not found', 404)
  const result = data as unknown as OcrWithImage
  if (result.images.user_id !== userId) return apiError('Not found', 404)

  const { data: signedUrl } = await db.storage
    .from('images')
    .createSignedUrl(result.images.storage_path, 3600)

  const finalCode = result.manual_override ?? (result.auto_approved ? result.extracted_code : null)
  return NextResponse.json({ ...result, final_code: finalCode, signed_url: signedUrl?.signedUrl })
})

export const PATCH = withAuth(async (req, userId, params) => {
  const debugLog: string[] = []
  function debug(msg: string) {
    const ts = new Date().toISOString()
    debugLog.push(`[${ts}] ${msg}`)
    console.log(`[review-flow] ${msg}`)
  }

  debug(`PATCH /api/ocr-results/${params!.id} — userId=${userId}`)

  const body = await req.json()
  const parsed = ocrReviewSchema.safeParse(body)
  if (!parsed.success) {
    debug(`Validation failed: ${parsed.error.message}`)
    return apiError(parsed.error.message, 422)
  }

  const { action, manual_override } = parsed.data
  debug(`Action: ${action}${manual_override ? `, override: "${manual_override}"` : ''}`)

  const db = getSupabaseAdminClient()

  const { data: rawOcr } = await db
    .from('ocr_results')
    .select('id, image_id, extracted_code, images!inner(user_id)')
    .eq('id', params!.id)
    .single()

  const ocrResult = rawOcr as unknown as (OcrResult & { images: { user_id: string } }) | null
  if (!ocrResult || ocrResult.images.user_id !== userId) {
    debug('OCR result not found or not owned by user')
    return apiError('Not found', 404)
  }

  debug(`OCR result found: extracted_code="${ocrResult.extracted_code}", image_id=${ocrResult.image_id}`)

  if (action === 'discard') {
    await db.from('images').update({ status: 'discarded' }).eq('id', ocrResult.image_id)
    debug('Image discarded')
    return NextResponse.json({ success: true, discarded: true, debugLog })
  }

  type OcrUpdate = Database['public']['Tables']['ocr_results']['Update']
  const updates: OcrUpdate = {
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
    ...(action === 'approve' ? { auto_approved: true } : {}),
    ...(action === 'override' ? { manual_override } : {}),
  }

  await db.from('ocr_results').update(updates).eq('id', params!.id)
  await db.from('images').update({ status: 'approved' }).eq('id', ocrResult.image_id)
  debug('OCR result approved & image status updated')

  const finalCode = action === 'override' ? manual_override! : ocrResult.extracted_code
  debug(`Final code for search: "${finalCode}"`)

  let searchResult: 'found' | 'not_found' | 'no_code' | 'search_error' = 'no_code'
  let listingResult: AutoListResult | undefined
  let searchDebug: { itemCount?: number; bestMatchTitle?: string; bestMatchId?: string } = {}

  if (!finalCode) {
    debug('No final code — skipping product search and listing')
  } else {
    try {
      debug(`Creating product_search record for query="${finalCode}"`)
      const { data: search, error: searchInsertErr } = await db.from('product_searches').insert({
        ocr_result_id: params!.id,
        search_query: finalCode,
        status: 'pending',
      }).select().single()

      if (searchInsertErr || !search) {
        debug(`Failed to create product_search record: ${searchInsertErr?.message ?? 'unknown'}`)
        searchResult = 'search_error'
      } else {
        debug(`Product search record created: ${search.id}`)

        // Check eBay connection exists
        const { data: conn } = await db
          .from('ebay_connections')
          .select('id, ebay_user_id, token_expires_at')
          .eq('user_id', userId)
          .single()

        if (!conn) {
          debug('❌ No eBay connection found for this user! Cannot search or list.')
          searchResult = 'search_error'
          await db.from('product_searches').update({ status: 'failed', error_message: 'No eBay connection' }).eq('id', search.id)
        } else {
          debug(`eBay connection found: ebay_user_id=${conn.ebay_user_id}, token_expires_at=${conn.token_expires_at}`)

          const tokenExpiry = new Date(conn.token_expires_at)
          if (tokenExpiry < new Date()) {
            debug(`⚠️ eBay token expired at ${conn.token_expires_at}`)
          }

          debug(`Searching eBay for "${finalCode}"...`)
          const items = await searchEbayProducts(userId, finalCode)
          debug(`eBay search returned ${items.length} items`)
          searchDebug.itemCount = items.length

          const best = selectBestMatch(items, finalCode)
          
          await db.from('product_searches').update({
            status: items.length > 0 ? 'success' : 'no_results',
            result_count: items.length,
            results_raw: items as unknown as Json,
            selected_item_id: best?.itemId ?? null,
          }).eq('id', search.id)

          if (best) {
            debug(`Best match: "${best.title}" (${best.itemId}), price=${best.price.value} ${best.price.currency}, condition=${best.condition}`)
            searchDebug.bestMatchTitle = best.title
            searchDebug.bestMatchId = best.itemId
            searchResult = 'found'

            debug('Starting auto-listing...')
            listingResult = await autoCreateListing({ userId, searchId: search.id, bestMatch: best })
            debug(`Auto-listing result: success=${listingResult.success}${listingResult.error ? `, error=${listingResult.error}` : ''}${listingResult.listingUrl ? `, url=${listingResult.listingUrl}` : ''}`)
          } else {
            debug(`No matching product found for "${finalCode}" — ${items.length} items returned but none matched`)
            searchResult = 'not_found'
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      
      // Try to extract eBay API response for more detail
      let fullError = errMsg
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { status?: number; data?: unknown } }
        fullError = `HTTP ${axiosErr.response?.status}: ${JSON.stringify(axiosErr.response?.data)}`
      }
      
      debug(`❌ Error during search/listing: ${fullError}`)
      searchResult = 'search_error'
      await enqueueRetry('product_search', params!.id, fullError)
    }
  }

  debug(`=== DONE === searchResult=${searchResult}, listingSuccess=${listingResult?.success ?? 'N/A'}`)

  return NextResponse.json({
    success: true,
    searchResult,
    searchDebug,
    listingResult,
    debugLog,
  })
})
