import { createEbayClient } from './client'
import { describeEbayError } from './error'
import {
  getCachedLocationKey,
  setCachedLocationKey,
  invalidateLocationCache,
} from './account-cache'
import { withContext } from '@/lib/log'
import type { AxiosInstance } from 'axios'

/**
 * Resolves the `merchantLocationKey` to attach to every offer.
 *
 * Why this exists: publishing a Sell-API offer without a usable location
 * returns `errorId=25002 "No <Item.Country> exists"` — eBay is complaining
 * that the inventory location (and therefore item country) is unresolved.
 * The Sell API requires the seller account to have at least one inventory
 * location AND for each offer to reference one via `merchantLocationKey` AND
 * for that location to have a non-empty `address.country`.
 *
 * Resolution order:
 *   1. List the seller's existing locations. Filter to those with a
 *      non-empty country and not DISABLED. If any qualify, pick the
 *      env-configured key (or the first ENABLED one).
 *   2. If the seller has locations but none qualify, AND one of them matches
 *      our env-configured key, repair it via `update_location_details`.
 *   3. Otherwise create a fresh `WAREHOUSE` location from `EBAY_LOCATION_*`
 *      env vars. If our preferred key is already taken by a broken entry,
 *      suffix with a timestamp so we don't collide.
 *
 * eBay docs:
 *   - https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/getInventoryLocations
 *   - https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/createInventoryLocation
 *   - https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/updateInventoryLocation
 */

interface InventoryLocation {
  merchantLocationKey: string
  merchantLocationStatus?: string
  name?: string
  location?: {
    address?: {
      country?: string
      postalCode?: string
      city?: string
      stateOrProvince?: string
      addressLine1?: string
      addressLine2?: string
    }
  }
}

interface LocationListResponse {
  total?: number
  locations?: InventoryLocation[]
}

const DEFAULT_LOCATION_KEY = 'default-warehouse'

// The memoized merchantLocationKey lives in ./account-cache so that connecting
// or disconnecting an eBay account can drop it without an import cycle. See the
// header of that file — the key is account-scoped, not just user-scoped.

interface LocationEnvConfig {
  key: string
  country?: string
  postalCode?: string
  city?: string
  stateOrProvince?: string
  addressLine1?: string
  addressLine2?: string
  name?: string
}

function readEnv(): LocationEnvConfig {
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

function isUsableLocation(loc: InventoryLocation): boolean {
  if (!loc.merchantLocationKey) return false
  if (loc.merchantLocationStatus === 'DISABLED') return false
  const country = loc.location?.address?.country?.trim()
  if (!country) return false
  return true
}

async function listLocations(client: AxiosInstance): Promise<InventoryLocation[]> {
  const res = await client.get<LocationListResponse>('/sell/inventory/v1/location', {
    params: { limit: 100 },
  })
  return res.data.locations ?? []
}

function buildAddressBody(cfg: LocationEnvConfig) {
  return {
    country: cfg.country!,
    postalCode: cfg.postalCode!,
    ...(cfg.city ? { city: cfg.city } : {}),
    ...(cfg.stateOrProvince ? { stateOrProvince: cfg.stateOrProvince } : {}),
    ...(cfg.addressLine1 ? { addressLine1: cfg.addressLine1 } : {}),
    ...(cfg.addressLine2 ? { addressLine2: cfg.addressLine2 } : {}),
  }
}

async function createLocation(
  client: AxiosInstance,
  cfg: LocationEnvConfig,
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
      address: buildAddressBody(cfg),
    },
    locationInstructions: 'Items ship from this warehouse.',
    name: cfg.name ?? 'Default Warehouse',
    merchantLocationStatus: 'ENABLED',
    locationTypes: ['WAREHOUSE'],
  }

  await client.post(`/sell/inventory/v1/location/${encodeURIComponent(cfg.key)}`, body)
  return cfg.key
}

/**
 * Repairs an existing inventory location whose address is missing required
 * fields (e.g., country) by replacing the address via
 * POST /location/{key}/update_location_details.
 *
 * Only the fields included in the body are updated; eBay leaves everything
 * else intact. Caller must guarantee country + postalCode are present in cfg.
 */
async function updateLocationAddress(
  client: AxiosInstance,
  key: string,
  cfg: LocationEnvConfig,
): Promise<void> {
  if (!cfg.country || !cfg.postalCode) {
    throw new Error(
      'Cannot repair eBay inventory location: set EBAY_LOCATION_COUNTRY and EBAY_LOCATION_POSTAL_CODE.',
    )
  }
  await client.post(
    `/sell/inventory/v1/location/${encodeURIComponent(key)}/update_location_details`,
    {
      location: {
        address: buildAddressBody(cfg),
      },
      ...(cfg.name ? { name: cfg.name } : {}),
    },
  )
}

export async function getOrCreateMerchantLocationKey(userId: string): Promise<string> {
  const cached = getCachedLocationKey(userId)
  if (cached) return cached

  const log = withContext({ scope: 'ebay.location', user_id: userId })
  const client = createEbayClient(userId)
  const cfg = readEnv()

  let existing: InventoryLocation[] = []
  try {
    existing = await listLocations(client)
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

  if (existing.length > 0) {
    const usable = existing.filter(isUsableLocation)
    if (usable.length > 0) {
      // Prefer the env-configured key, then any ENABLED location, else first.
      const preferred =
        usable.find((l) => l.merchantLocationKey === cfg.key) ??
        usable.find((l) => l.merchantLocationStatus === 'ENABLED') ??
        usable[0]
      const key = preferred.merchantLocationKey
      log.info('Resolved existing inventory location', {
        merchant_location_key: key,
        country: preferred.location?.address?.country ?? null,
        postal_code: preferred.location?.address?.postalCode ?? null,
        status: preferred.merchantLocationStatus ?? null,
        total: existing.length,
        usable_count: usable.length,
      })
      setCachedLocationKey(userId, key)
      return key
    }

    log.warn('Seller has inventory locations but none usable (missing country / disabled)', {
      total: existing.length,
      keys: existing.map((l) => l.merchantLocationKey),
      countries: existing.map((l) => l.location?.address?.country ?? null),
      statuses: existing.map((l) => l.merchantLocationStatus ?? null),
    })

    // If our env-configured key matches one of the broken entries, try to
    // repair it in place — that avoids cluttering the seller's account with
    // a parallel "default-warehouse-1234567890" location.
    const matchEnvKey = existing.find((l) => l.merchantLocationKey === cfg.key)
    if (matchEnvKey && cfg.country && cfg.postalCode) {
      log.info('Repairing broken env-configured location via update_location_details', {
        merchant_location_key: cfg.key,
      })
      try {
        await updateLocationAddress(client, cfg.key, cfg)
        log.info('Repaired location address', { merchant_location_key: cfg.key })
        setCachedLocationKey(userId, cfg.key)
        return cfg.key
      } catch (err) {
        const { summary, ctx } = describeEbayError(err)
        log.error('update_location_details failed — will create a fresh location instead', {
          ...ctx,
          err: summary,
        })
        // fall through to create-fresh path below
      }
    }
  }

  // Create a fresh location. If our env key is already occupied by a broken
  // entry we couldn't repair, suffix with a timestamp so we don't collide.
  const keyTaken = existing.some((l) => l.merchantLocationKey === cfg.key)
  const desiredKey = keyTaken ? `${cfg.key}-${Date.now()}` : cfg.key
  const cfgWithKey: LocationEnvConfig = { ...cfg, key: desiredKey }

  log.info('Creating inventory location', {
    key: desiredKey,
    country: cfg.country,
    postal_code: cfg.postalCode,
    collided_with_broken: keyTaken,
  })

  try {
    const key = await createLocation(client, cfgWithKey)
    log.info('Inventory location created', { merchant_location_key: key })
    setCachedLocationKey(userId, key)
    return key
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    // errorId=25801 = "A location with the merchantLocationKey already exists".
    // This can happen under a race or when listLocations didn't show the entry.
    // Try to repair-in-place; otherwise accept the key as-is and hope it's good.
    const alreadyExists = ctx.errors?.some((e) => e.errorId === 25801)
    if (alreadyExists) {
      if (cfg.country && cfg.postalCode) {
        try {
          await updateLocationAddress(client, desiredKey, cfgWithKey)
          log.info('Race-created location repaired via update_location_details', {
            key: desiredKey,
          })
          setCachedLocationKey(userId, desiredKey)
          return desiredKey
        } catch (repairErr) {
          const repair = describeEbayError(repairErr)
          log.warn('Race-repair via update_location_details failed', {
            ...repair.ctx,
            err: repair.summary,
          })
        }
      }
      log.info('Location already existed (raced) — using configured key', { key: desiredKey })
      setCachedLocationKey(userId, desiredKey)
      return desiredKey
    }
    log.error('Failed to create inventory location', { ...ctx, err: summary })
    throw new Error(`Failed to create eBay inventory location: ${summary}`)
  }
}

export { invalidateLocationCache }
