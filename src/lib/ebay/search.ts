import { createEbayClient } from './client'
import { withContext } from '@/lib/log'
import type { EbayItemSummary, EbaySearchResponse } from '@/types/ebay'

export interface EbaySearchOutcome {
  /** Items from the first query variant that returned any results (or []). */
  items: EbayItemSummary[]
  /** Which query variant actually produced `items` (null when none matched). */
  matchedQuery: string | null
  /** Every variant we tried, in order — surfaced for debug logs. */
  triedQueries: string[]
}

/**
 * Build the ordered list of query strings to try for a part-number search.
 *
 * eBay's Browse keyword search matches whole tokens, so a molded assembly code
 * like "ASM24310563" finds nothing when sellers list the part under its bare
 * numeric core ("24310563"). We therefore try progressively looser variants and
 * take the first that returns hits:
 *
 *   1. The code as approved (exact — best precision).
 *   2. Separators stripped ("A 207 680 04 89" → "A2076800489").
 *   3. A leading alpha prefix dropped ("ASM24310563" → "24310563"), but ONLY
 *      when the remainder is all digits and ≥5 long. This deliberately does not
 *      fire for interior-letter codes like "4F0035223" (stripping would mangle
 *      them); the exact query already covers those.
 *
 * Deduplicated, order-preserving.
 */
export function buildQueryVariants(raw: string): string[] {
  const variants: string[] = []
  const seen = new Set<string>()
  const add = (v: string | null | undefined) => {
    const t = v?.trim()
    if (!t) return
    const key = t.toUpperCase()
    if (seen.has(key)) return
    seen.add(key)
    variants.push(t)
  }

  const q = raw.trim()
  add(q)

  const compact = q.replace(/[\s._/\\-]/g, '')
  add(compact)

  const prefixed = compact.match(/^[A-Za-z]{1,4}(\d{5,})$/)
  if (prefixed) add(prefixed[1])

  return variants
}

/**
 * Search eBay for a part number, trying looser query variants until one returns
 * results. Returns the matched items plus which variant hit (for logging).
 */
export async function searchEbayProductsDetailed(
  userId: string,
  query: string,
  limit = 10,
): Promise<EbaySearchOutcome> {
  const client = createEbayClient(userId)
  const log = withContext({ scope: 'ebay.search', user_id: userId })
  const triedQueries = buildQueryVariants(query)

  for (const q of triedQueries) {
    const res = await client.get<EbaySearchResponse>('/buy/browse/v1/item_summary/search', {
      params: { q, limit },
    })
    const items = res.data.itemSummaries ?? []
    if (items.length > 0) {
      if (q !== query) {
        log.info('eBay match found on fallback query variant', {
          original: query,
          matched: q,
          count: items.length,
        })
      }
      return { items, matchedQuery: q, triedQueries }
    }
  }

  return { items: [], matchedQuery: null, triedQueries }
}

export async function searchEbayProducts(
  userId: string,
  query: string,
  limit = 10,
): Promise<EbayItemSummary[]> {
  const { items } = await searchEbayProductsDetailed(userId, query, limit)
  return items
}

export function selectBestMatch(items: EbayItemSummary[], query: string): EbayItemSummary | null {
  if (items.length === 0) return null
  if (items.length === 1) return items[0]

  const q = query.toUpperCase()
  // Prefer items whose title contains the exact query string
  const exact = items.find((item) => item.title.toUpperCase().includes(q))
  return exact ?? items[0]
}
