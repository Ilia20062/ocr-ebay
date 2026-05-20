import axios, { AxiosInstance, InternalAxiosRequestConfig, AxiosError } from 'axios'
import { getFreshAccessToken } from './token-manager'

const BASE_URL = process.env.EBAY_ENVIRONMENT === 'sandbox'
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com'

// eBay Inventory API PUT/POST calls require a Content-Language header (errorId=25709 if missing/invalid).
// Map marketplace IDs to their BCP-47 locale equivalents.
const MARKETPLACE_LOCALE: Record<string, string> = {
  EBAY_US: 'en-US',
  EBAY_GB: 'en-GB',
  EBAY_AU: 'en-AU',
  EBAY_CA: 'en-CA',
  EBAY_DE: 'de-DE',
  EBAY_FR: 'fr-FR',
  EBAY_IT: 'it-IT',
  EBAY_ES: 'es-ES',
  EBAY_AT: 'de-AT',
  EBAY_BE_FR: 'fr-BE',
  EBAY_BE_NL: 'nl-BE',
  EBAY_NL: 'nl-NL',
  EBAY_PL: 'pl-PL',
  EBAY_SG: 'en-SG',
  EBAY_HK: 'zh-HK',
  EBAY_IN: 'en-IN',
  EBAY_MY: 'en-MY',
  EBAY_PH: 'en-PH',
}

function getContentLanguage(): string {
  const marketplaceId = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US'
  return MARKETPLACE_LOCALE[marketplaceId] ?? 'en-US'
}

export function createEbayClient(userId: string): AxiosInstance {
  const client = axios.create({ baseURL: BASE_URL })

  // Inject fresh access token before every request
  client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    const token = await getFreshAccessToken(userId)
    config.headers.Authorization = `Bearer ${token}`
    config.headers['Content-Type'] = config.headers['Content-Type'] ?? 'application/json'
    config.headers['X-EBAY-C-MARKETPLACE-ID'] = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US'
    // Required by eBay Inventory API for PUT/POST requests (errorId=25709 if omitted).
    if (config.method && ['put', 'post', 'patch'].includes(config.method.toLowerCase())) {
      config.headers['Content-Language'] = config.headers['Content-Language'] ?? getContentLanguage()
    }
    return config
  })

  // Handle 429 rate limits and eBay error codes
  client.interceptors.response.use(
    (res) => res,
    async (error: AxiosError) => {
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers['retry-after']
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 60000
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5000)))
        return client.request(error.config!)
      }
      throw error
    }
  )

  return client
}

export function isEbayErrorCode(error: unknown, code: number): boolean {
  if (!axios.isAxiosError(error)) return false
  const errors = (error.response?.data as { errors?: Array<{ errorId: number }> })?.errors ?? []
  return errors.some((e) => e.errorId === code)
}
