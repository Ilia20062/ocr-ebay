import type { EbayItemSummary } from '@/types/ebay'

/**
 * Minimum listing price. Per client spec, no item may list below $29 — cheaper
 * computed prices get floored up to this value. Overridable at runtime via the
 * `EBAY_MIN_PRICE` env var (invalid/empty values fall back to the default).
 */
export const DEFAULT_MIN_LISTING_PRICE = 29

export function getMinListingPrice(): number {
  const raw = process.env.EBAY_MIN_PRICE?.trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100
  }
  return DEFAULT_MIN_LISTING_PRICE
}

/**
 * Compute a listing price from comparable eBay results: the average of the
 * comparable prices, minus a margin (spec: 5–8%; default 7%). Outliers are
 * trimmed (drop the cheapest and dearest when there are enough samples) so a
 * single mis-priced listing doesn't skew the average.
 *
 * Returns null when there are no usable prices (caller should fall back to the
 * best-match price).
 */
export function computeListingPrice(
  items: Pick<EbayItemSummary, 'price'>[] | null | undefined,
  discountPct = 7,
): number | null {
  const prices = (items ?? [])
    .map((i) => parseFloat(i?.price?.value ?? ''))
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b)

  if (prices.length === 0) return null

  // Trim the single cheapest and dearest once we have ≥4 samples — cuts the
  // common "broken for parts $1" and "dealer new $900" extremes.
  const trimmed = prices.length >= 4 ? prices.slice(1, -1) : prices
  const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length

  const price = avg * (1 - discountPct / 100)
  // Round to a .99-friendly value isn't required; 2dp is what the Sell API wants.
  return Math.round(price * 100) / 100
}

/**
 * Final listing price: the computed comparable price floored at the minimum
 * ($29 by default). `computed` is whatever `computeListingPrice` (or a
 * best-match fallback) produced; anything missing/invalid or below the floor
 * resolves to the minimum. Rounded to 2dp for the Sell API.
 */
export function applyPriceFloor(computed: number | null | undefined): number {
  const min = getMinListingPrice()
  const base = Number(computed)
  if (!Number.isFinite(base) || base <= 0) return min
  return Math.round(Math.max(base, min) * 100) / 100
}
