import axios, { AxiosInstance, InternalAxiosRequestConfig, AxiosError } from 'axios'
import { getFreshAccessToken } from './token-manager'

const BASE_URL = process.env.EBAY_ENVIRONMENT === 'sandbox'
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com'

export function createEbayClient(userId: string): AxiosInstance {
  const client = axios.create({ baseURL: BASE_URL })

  // Inject fresh access token before every request
  client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    const token = await getFreshAccessToken(userId)
    config.headers.Authorization = `Bearer ${token}`
    config.headers['Content-Type'] = config.headers['Content-Type'] ?? 'application/json'
    config.headers['X-EBAY-C-MARKETPLACE-ID'] = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US'
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
