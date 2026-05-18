/**
 * Validate OCR candidate codes against eBay's Browse API.
 *
 * The OCR / group-resolver pipeline produces a ranked list of candidate part
 * numbers per cluster. Real OEM PNs are distinctive enough that eBay's keyword
 * search will return matching listings, whereas OCR scrap ("V9UE", "A.53",
 * "L251") returns nothing. This module re-ranks candidates by eBay match
 * count, giving us a much stronger signal than OCR confidence alone.
 *
 * Design:
 *   - Skips silently when the user has not connected eBay (no crashes, no
 *     blocking of the upload-session pipeline).
 *   - Deduplicates queries via a shared `Map<code, MatchInfo>` cache that the
 *     caller passes in (one per session so concurrent clusters benefit).
 *   - Caps the number of candidates per cluster (default 4) to bound API spend.
 *   - Treats any eBay error per-candidate as "not validated" — never throws,
 *     so an outage degrades to current OCR-only behavior, not failure.
 */

import { searchEbayProducts } from './search'
import { getDecryptedConnection } from './token-manager'
import type { GroupResolverAlternative, GroupResolverOutput } from '@/lib/ocr/group-resolver'
import { withContext } from '@/lib/log'

export interface MatchInfo {
  /** How many item summaries eBay returned for this query. 0 = no hits. */
  matchCount: number
  /** Title of the top match — useful for UI / logging. */
  bestMatchTitle: string | null
}

export type CandidateCache = Map<string, MatchInfo>

export interface ValidateOptions {
  /** Top-K candidates (winner + alternatives) to query. Default 4. */
  maxCandidates?: number
  /** eBay Browse limit per query — small is plenty to confirm existence. Default 5. */
  perQueryLimit?: number
  /** Shared cache across clusters in the same session. */
  cache?: CandidateCache
  /**
   * Skip the per-call userHasEbayConnection check. Set true when the caller
   * has already verified the user is connected (e.g. the session-process
   * pipeline checks once per session and reuses the result across clusters).
   * Saves one DB read + 2 AES decrypts per cluster.
   */
  skipConnectionCheck?: boolean
}

export interface ValidationOutcome {
  /** Whether eBay was queried at all. False when not connected / disabled. */
  validated: boolean
  /** Original resolver output, unmodified. */
  original: GroupResolverOutput
  /** Possibly-rewritten resolver output (alternatives promoted to winner). */
  reranked: GroupResolverOutput
  /** Match-count info keyed by code. */
  matches: Record<string, MatchInfo>
  /** True when the winning code changed because of validation. */
  swapped: boolean
}

/**
 * Cheap pre-check — true if the user has an eBay connection. Avoids the
 * decrypt/token-refresh path inside `searchEbayProducts` when we know we'll
 * fail anyway.
 */
export async function userHasEbayConnection(userId: string): Promise<boolean> {
  try {
    const conn = await getDecryptedConnection(userId)
    return !!conn
  } catch {
    return false
  }
}

/**
 * Heuristic for which codes are worth validating. We deliberately do not
 * validate every OCR scrap — eBay rate limits are precious.
 *
 *   - At least 4 characters and at least one digit (the OCR extractor already
 *     enforces this, but be defensive).
 *   - Not purely numeric AND not purely a few letters (those produce too many
 *     unrelated hits and don't discriminate).
 *   - Not a known short watermark scrap like "27/4".
 */
function isValidationWorthwhile(code: string): boolean {
  if (!code) return false
  if (code.length < 4) return false
  if (!/\d/.test(code)) return false
  // pure 1-4 digit numbers ("2500", "1202") match too many unrelated listings
  if (/^\d{1,4}$/.test(code)) return false
  return true
}

/**
 * Validate up to `maxCandidates` codes from the resolver output against eBay,
 * then return a possibly-rewritten resolver output where the highest match
 * count wins. Ties broken by the original OCR ranking (so we never make
 * things worse than they were).
 *
 * IMPORTANT: this function is purely additive — it only swaps a winning code
 * to an alternative when the alternative has STRICTLY more eBay matches than
 * the current winner. Never demotes a winner to "no code" because of a 0-hit
 * validation. The reviewer still confirms every result (no auto-approve).
 */
export async function validateCandidatesWithEbay(
  userId: string,
  resolved: GroupResolverOutput,
  opts: ValidateOptions = {},
): Promise<ValidationOutcome> {
  const log = withContext({ scope: 'ebay.validate', user_id: userId })
  const matches: Record<string, MatchInfo> = {}
  const baseline: ValidationOutcome = {
    validated: false,
    original: resolved,
    reranked: resolved,
    matches,
    swapped: false,
  }

  if (!resolved.winningCode) return baseline

  // Bail cheaply if eBay isn't connected. Skip when the caller has already
  // verified (avoids 36× redundant DB reads + AES decrypts per session).
  if (!opts.skipConnectionCheck) {
    const connected = await userHasEbayConnection(userId)
    if (!connected) return baseline
  }

  const cache = opts.cache ?? new Map<string, MatchInfo>()
  const maxCandidates = opts.maxCandidates ?? 4
  const perQueryLimit = opts.perQueryLimit ?? 5

  // Build the candidate list: winner + alternatives, capped, deduped.
  const ordered = [
    { code: resolved.winningCode!, source: 'winner' as const },
    ...resolved.alternatives.map((a) => ({ code: a.code, source: 'alt' as const })),
  ]
  const unique: string[] = []
  const seen = new Set<string>()
  for (const { code } of ordered) {
    const key = code.trim().toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (!isValidationWorthwhile(code)) continue
    unique.push(code)
    if (unique.length >= maxCandidates) break
  }

  if (unique.length === 0) return baseline

  // Query eBay for each uncached candidate in parallel. Browse is rate-limited
  // per second, but a Promise.all of ≤ maxCandidates (default 4) per cluster
  // stays well inside the budget. Cache hits short-circuit before the call.
  let queriedAny = false
  const cached: string[] = []
  const uncached: string[] = []
  for (const code of unique) {
    const hit = cache.get(code)
    if (hit) {
      matches[code] = hit
      cached.push(code)
    } else {
      uncached.push(code)
    }
  }

  if (uncached.length > 0) {
    const results = await Promise.allSettled(
      uncached.map((code) => searchEbayProducts(userId, code, perQueryLimit)),
    )
    for (let i = 0; i < uncached.length; i++) {
      const code = uncached[i]
      const r = results[i]
      if (r.status === 'fulfilled') {
        const info: MatchInfo = {
          matchCount: r.value.length,
          bestMatchTitle: r.value[0]?.title ?? null,
        }
        cache.set(code, info)
        matches[code] = info
        queriedAny = true
      } else {
        // Per-candidate failure is logged but does not poison the whole batch.
        log.warn('candidate validation failed', { code, err: r.reason })
      }
    }
  }

  if (!queriedAny && Object.keys(matches).length === 0) return baseline

  // Re-rank: highest match count wins; ties broken by original order.
  const ranked = unique
    .map((code) => ({ code, m: matches[code]?.matchCount ?? -1 }))
    .filter((r) => r.m >= 0)
  ranked.sort((a, b) => b.m - a.m)
  const topMatch = ranked[0]

  if (!topMatch || topMatch.m === 0) {
    // No candidate had any hits — keep the OCR winner, but report the result.
    log.info('no eBay match for any candidate', {
      original_winner: resolved.winningCode,
      candidates: unique.length,
    })
    return { ...baseline, validated: true, matches }
  }

  // Only swap when the alternative has STRICTLY more hits than the winner.
  // Equal hits → keep the OCR consensus winner (consensus is a stronger signal
  // than a marginally-tied eBay count).
  const winnerHits = matches[resolved.winningCode!]?.matchCount ?? 0
  if (topMatch.code === resolved.winningCode || topMatch.m <= winnerHits) {
    log.info('eBay validation confirms OCR winner', {
      winner: resolved.winningCode,
      winner_hits: winnerHits,
    })
    return { ...baseline, validated: true, matches }
  }

  // Promote the alternative.
  const promoted = resolved.alternatives.find((a) => a.code === topMatch.code)
  if (!promoted) {
    // Shouldn't happen, but guard the type narrowing.
    return { ...baseline, validated: true, matches }
  }

  // Build the rewritten resolver output. The old winner becomes the top
  // alternative so the UI still surfaces it for human override.
  const newAlternatives: GroupResolverAlternative[] = [
    {
      code: resolved.winningCode!,
      ocrResultId: resolved.winningOcrResultId!,
      imageId: resolved.winningImageId!,
      confidence: resolved.winningConfidence ?? 0,
    },
    ...resolved.alternatives.filter((a) => a.code !== topMatch.code),
  ]

  const reranked: GroupResolverOutput = {
    winningOcrResultId: promoted.ocrResultId,
    winningImageId: promoted.imageId,
    winningCode: promoted.code,
    winningConfidence: promoted.confidence,
    hadConsensus: resolved.hadConsensus,
    alternatives: newAlternatives,
  }

  log.info('eBay validation promoted alternative', {
    old_winner: resolved.winningCode,
    old_winner_hits: winnerHits,
    new_winner: promoted.code,
    new_winner_hits: topMatch.m,
  })

  return {
    validated: true,
    original: resolved,
    reranked,
    matches,
    swapped: true,
  }
}
