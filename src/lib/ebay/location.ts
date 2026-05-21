import { createEbayClient } from './client'
import { describeEbayError } from './error'
import { withContext } from '@/lib/log'
import type { AxiosInstance } from 'axios'

/**
 * Resolves the `merchantLocationKey` to attach to every offer.
 *
 * Why this exists: publishing a Sell-API offer without a location returns
 * `errorId=25002 "No <Item.Country> exists"` — eBay is complaining that the
 * inventory location (and therefore item country) is unresolved. The Sell API
 * requires the seller account to have at least one inventory location AND for
 * each offer to reference one via `merchantLocationKey`.
 *
 * Resolution order:
 *   1. List the seller's existing locations. If any exist, use the configured
 *      `EBAY_LOCATION_KEY` (or the first one returned) — no writes.
 *   2. Otherwise auto-create a `WAREHOUSE` location from `EBAY_LOCATION_*` env
 *      vars. We require at minimum country + postal code; everything else is
 *      optional per the Sell API spec.
 *
 * eBay docs:
 *   - https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/getInventoryLocations
 *   - https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/createInventoryLocation
 */

interface InventoryLocation {
  merchantLocationKey: string
  merchantLocationStatus?: string
  name?: string
  location?: { address?: { country?: string; postalCode?: string } }
}

interface LocationListResponse {
  total?: number
  locations?: InventoryLocation[]
}

const DEFAULT_LOCATION_KEY = 'default-warehouse'

// In-memory cache so we don't hit the location-list endpoint on every publish.
// Key: userId. Invalidated only on process restart.
const locationCache = new Map<string, string>()

function readEnv(): {
  key: string
  country?: string
  postalCode?: string
  city?: string
  stateOrProvince?: string
  addressLine1?: string
  addressLine2?: string
  name?: string
} {
  return {
    key: process.env.EBAY_LOCATION_KEY?.trim() || DEFAULT_LOCATION_KEY,
    country: process.env.EBAY_LOCATION_COUNTRY?.trim(),
    postalCode: process.env.EBAY_LOCATION_POSTAL_CODE?.trim(),
    city: process.env.EBAY_LOCATION_CITY?.trim(),
    stateOrProvince: process.env.EBAY_LOCATION_STATE?.trim(),
    addressLine1: process.env.EBAY_LOCATION_ADDRESS_LINE1?.trim(),
    addressLine2: process.env.EBAY_LOCATION_ADDRESS_LINE2?.trim(),
    name: process.env.EBAY_LOCATION_NAME?.trim(),
  }
}

async function listLocations(client: AxiosInstance): Promise<InventoryLocation[]> {
  const res = await client.get<LocationListResponse>('/sell/inventory/v1/location', {
    params: { limit: 100 },
  })
  return res.data.locations ?? []
}

async function createLocation(
  client: AxiosInstance,
  cfg: ReturnType<typeof readEnv>,
): Promise<string> {
  if (!cfg.country || !cfg.postalCode) {
    throw new Error(
      'Cannot create eBay inventory location: set EBAY_LOCATION_COUNTRY (2-letter, e.g. "US") ' +
        'and EBAY_LOCATION_POSTAL_CODE in your environment. Optional: EBAY_LOCATION_CITY, ' +
        'EBAY_LOCATION_STATE, EBAY_LOCATION_ADDRESS_LINE1, EBAY_LOCATION_NAME, EBAY_LOCATION_KEY.',
    )
  }

  const body = {
    location: {
      address: {
        country: cfg.country,
        postalCode: cfg.postalCode,
        ...(cfg.city ? { city: cfg.city } : {}),
        ...(cfg.stateOrProvince ? { stateOrProvince: cfg.stateOrProvince } : {}),
        ...(cfg.addressLine1 ? { addressLine1: cfg.addressLine1 } : {}),
        ...(cfg.addressLine2 ? { addressLine2: cfg.addressLine2 } : {}),
      },
    },
    locationInstructions: 'Items ship from this warehouse.',
    name: cfg.name ?? 'Default Warehouse',
    merchantLocationStatus: 'ENABLED',
    locationTypes: ['WAREHOUSE'],
  }

  await client.post(`/sell/inventory/v1/location/${encodeURIComponent(cfg.key)}`, body)
  return cfg.key
}

export async function getOrCreateMerchantLocationKey(userId: string): Promise<string> {
  const cached = locationCache.get(userId)
  if (cached) return cached

  const log = withContext({ scope: 'ebay.location', user_id: userId })
  const client = createEbayClient(userId)
  const cfg = readEnv()

  try {
    const existing = await listLocations(client)
    if (existing.length > 0) {
      // Prefer the env-configured key if the seller has it; otherwise use the
      // first enabled location (fall back to the first one regardless).
      const preferred =
        existing.find((l) => l.merchantLocationKey === cfg.key) ??
        existing.find((l) => l.merchantLocationStatus === 'ENABLED') ??
        existing[0]
      const key = preferred.merchantLocationKey
      log.info('Resolved existing inventory location', {
        merchant_location_key: key,
        total: existing.length,
      })
      locationCache.set(userId, key)
      return key
    }
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    // 404 here means "no locations exist yet" on some Sell-API versions; fall
    // through to create. Any other failure is a real problem.
    if (ctx.status !== 404) {
      log.error('Failed to list inventory locations', { ...ctx, err: summary })
      throw new Error(`Failed to list eBay inventory locations: ${summary}`)
    }
    log.info('No inventory locations yet — will create one')
  }

  log.info('Creating default inventory location', {
    key: cfg.key,
    country: cfg.country,
    postal_code: cfg.postalCode,
  })

  try {
    const key = await createLocation(client, cfg)
    log.info('Inventory location created', { merchant_location_key: key })
    locationCache.set(userId, key)
    return key
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    // errorId=25801 = "A location with the merchantLocationKey already exists".
    // Treat as success and cache it.
    const alreadyExists = ctx.errors?.some((e) => e.errorId === 25801)
    if (alreadyExists) {
      log.info('Location already existed (raced) — using configured key', { key: cfg.key })
      locationCache.set(userId, cfg.key)
      return cfg.key
    }
    log.error('Failed to create inventory location', { ...ctx, err: summary })
    throw new Error(`Failed to create eBay inventory location: ${summary}`)
  }
}

export function invalidateLocationCache(userId?: string) {
  if (userId) locationCache.delete(userId)
  else locationCache.clear()
}
