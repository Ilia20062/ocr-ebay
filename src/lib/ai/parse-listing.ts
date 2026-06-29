import { log } from '@/lib/log'

/**
 * Parse a comparable eBay listing's title (plus the OEM part number) into the
 * structured fields the spec requires, and build a clean eBay title:
 *   <years> <make> <model> <part name> OEM <part number>
 *
 * Used to populate the draft's title + item aspects (Brand, Placement, Color, …).
 * A vision/text LLM handles the messy real-world titles far better than regex.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export interface ListingFields {
  /** Clean eBay title (≤80 chars): "<years> <make> <model> <part> OEM <pn>". */
  title: string
  /** Car make — used as the Brand aspect and in the condition statement. */
  brand: string | null
  make: string | null
  model: string | null
  years: string | null
  partName: string | null
  /** Position/side in U.S. terms, e.g. "Rear Left (Driver Side)". */
  placement: string | null
  color: string | null
}

const SYSTEM = `You extract structured fields from a used OEM auto-part listing and build a clean eBay title.
Return STRICT JSON only (no prose, no code fences) with these exact keys:
{"title": string, "brand": string|null, "make": string|null, "model": string|null, "years": string|null, "partName": string|null, "placement": string|null, "color": string|null}

Rules:
- "make"/"brand" = the car manufacturer (e.g. Mercedes-Benz, BMW). brand = make.
- Expand sides to U.S. terms in "placement": left → "Rear/Front Left (Driver Side)", right → "... Right (Passenger Side)". Keep front/rear.
- Convert British → American (bonnet→hood, boot→trunk, wing→fender).
- "title" format: "<years> <make> <model> <partName> OEM <partNumber>" — include the part number only if provided. Max 80 characters. Title Case. No quotes.
- Use null for any field you cannot determine confidently. Never invent a part number.`

export async function parseListingFields(
  matchedTitle: string,
  partNumber: string | null,
): Promise<ListingFields | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey || !matchedTitle) return null
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'

  const user = `REFERENCE TITLE: ${matchedTitle}\nOEM PART NUMBER: ${partNumber ?? '(unknown)'}`
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) {
      log.warn('parseListingFields HTTP error', { scope: 'ai.parse', status: res.status })
      return null
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown }
    if (j.error) {
      log.warn('parseListingFields API error', { scope: 'ai.parse', err: JSON.stringify(j.error).slice(0, 160) })
      return null
    }
    const raw = j.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(raw.replace(/^```[a-z]*\n?|```$/g, '').trim()) as Partial<ListingFields>
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
    const title = (str(parsed.title) ?? matchedTitle).slice(0, 80)
    return {
      title,
      brand: str(parsed.brand),
      make: str(parsed.make),
      model: str(parsed.model),
      years: str(parsed.years),
      partName: str(parsed.partName),
      placement: str(parsed.placement),
      color: str(parsed.color),
    }
  } catch (err) {
    log.warn('parseListingFields threw', { scope: 'ai.parse', err })
    return null
  }
}

/**
 * Build the eBay item aspects (draft fields) from parsed fields + the part
 * number + case number, per the spec. Only non-empty values are included;
 * eBay rejects empty aspect arrays.
 */
export function buildAspects(args: {
  fields: ListingFields | null
  partNumber: string | null
  caseNumber: string | null
}): Record<string, string[]> {
  const { fields, partNumber, caseNumber } = args
  const aspects: Record<string, string[]> = {}
  const add = (key: string, val: string | null | undefined) => {
    if (val && val.trim()) aspects[key] = [val.trim()]
  }
  add('Brand', fields?.brand ?? fields?.make)
  add('Manufacturer', fields?.make)
  add('Placement on Vehicle', fields?.placement)
  add('Color', fields?.color)
  if (partNumber) {
    aspects['Manufacturer Part Number'] = [partNumber]
    aspects['OE/OEM Part Number'] = [partNumber]
  }
  aspects['Warranty'] = ['90 Day']
  if (caseNumber) aspects['Case'] = [caseNumber]
  return aspects
}

/** Condition statement per spec: "Original {Brand} part. ..." */
export function conditionStatement(brandOrMake: string | null): string {
  const brand = brandOrMake?.trim() || 'OEM'
  return `Original ${brand} part. Item is in good working condition. Please make sure to match the part!`
}
