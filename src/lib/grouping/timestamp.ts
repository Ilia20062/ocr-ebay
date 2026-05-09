// Filename timestamp regex: matches "2026-04-07 15.23.34" or "2026-04-07_15.23.34",
// with optional "_1" / "_2" suffix from scanner-app retakes (treated as +500/+1000 ms
// nudges so files at the same wall-clock second sort deterministically).
const TS_RE = /(\d{4})-(\d{2})-(\d{2})[ _](\d{2})\.(\d{2})\.(\d{2})(?:_(\d+))?/

export function parseCapturedAt(filename: string): Date | null {
  const m = TS_RE.exec(filename)
  if (!m) return null
  const [, y, mo, d, hh, mm, ss, suffix] = m
  const ms = suffix ? parseInt(suffix, 10) * 500 : 0
  return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss, ms))
}
