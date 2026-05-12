/**
 * Extract a debuggable shape from an axios/fetch error returned by the eBay
 * Sell APIs.
 *
 * Why this exists: `String(err)` on an AxiosError produces
 * `"AxiosError: Request failed with status code 400"` — which tells you
 * literally nothing about *why* eBay rejected the request. The actual reason
 * lives in `err.response.data.errors[]` with `errorId`, `message`, and
 * `parameters[]`. This helper pulls that out so it can be logged AND stored
 * in `listings.error_message` for the UI.
 */

export interface EbayApiError {
  errorId?: number
  domain?: string
  category?: string
  message?: string
  longMessage?: string
  parameters?: Array<{ name?: string; value?: string }>
}

export interface EbayErrorBreakdown {
  status?: number | string
  errors?: EbayApiError[]
  warnings?: EbayApiError[]
  /** Whole response body for logs (capped before display). */
  raw?: unknown
}

export interface DescribedEbayError {
  /** Compact, human-readable line suitable for `listings.error_message`. */
  summary: string
  /** Structured context for the logger. */
  ctx: EbayErrorBreakdown
}

interface AxiosLikeError {
  response?: { status?: number; data?: unknown }
  message?: string
  name?: string
  code?: string
}

function asAxiosError(err: unknown): AxiosLikeError | null {
  if (!err || typeof err !== 'object') return null
  if (!('response' in err) && !('isAxiosError' in err)) return null
  return err as AxiosLikeError
}

function fmtParam(p: { name?: string; value?: string }): string {
  if (!p) return ''
  if (p.name && p.value) return `${p.name}=${p.value}`
  return p.name ?? p.value ?? ''
}

export function describeEbayError(err: unknown): DescribedEbayError {
  const axiosErr = asAxiosError(err)

  if (axiosErr) {
    const status = axiosErr.response?.status
    const data = axiosErr.response?.data as
      | { errors?: EbayApiError[]; warnings?: EbayApiError[] }
      | undefined

    const errors = data?.errors ?? []
    const first = errors[0]

    let summary: string
    if (first) {
      const params = (first.parameters ?? []).map(fmtParam).filter(Boolean).join(', ')
      const paramSuffix = params ? ` [${params}]` : ''
      summary = `eBay ${status ?? '?'} errorId=${first.errorId ?? '?'} ${first.message ?? '(no message)'}${paramSuffix}`
      // If there are additional errors, append a count so callers know to check logs.
      if (errors.length > 1) summary += ` (+${errors.length - 1} more)`
    } else if (data) {
      summary = `eBay HTTP ${status ?? '?'}: ${safeStringify(data).slice(0, 500)}`
    } else if (axiosErr.message) {
      summary = `eBay HTTP ${status ?? '?'}: ${axiosErr.message}`
    } else {
      summary = `eBay HTTP ${status ?? '?'} (no response body)`
    }

    return {
      summary,
      ctx: {
        status,
        errors,
        warnings: data?.warnings,
        raw: data,
      },
    }
  }

  const message = err instanceof Error ? err.message : String(err)
  return { summary: message, ctx: { raw: message } }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    return String(v)
  }
}
