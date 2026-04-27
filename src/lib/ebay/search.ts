import { createEbayClient } from './client'
import type { EbayItemSummary, EbaySearchResponse } from '@/types/ebay'

export async function searchEbayProducts(
  userId: string,
  query: string,
  limit = 10
): Promise<EbayItemSummary[]> {
  const client = createEbayClient(userId)

  const res = await client.get<EbaySearchResponse>('/buy/browse/v1/item_summary/search', {
    params: { q: query, limit },
  })

  return res.data.itemSummaries ?? []
}

export function selectBestMatch(items: EbayItemSummary[], query: string): EbayItemSummary | null {
  if (items.length === 0) return null
  if (items.length === 1) return items[0]

  const q = query.toUpperCase()
  // Prefer items whose title contains the exact query string
  const exact = items.find((item) => item.title.toUpperCase().includes(q))
  return exact ?? items[0]
}
