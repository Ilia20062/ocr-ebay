/**
 * Per-table JSONB column registry.
 *
 * node-postgres serializes a JS array parameter into a Postgres array literal
 * (`{...}`), which is wrong for a JSONB column. For these columns we
 * JSON.stringify the value so Postgres casts the (unknown-typed) text param to
 * jsonb. Plain objects are also stringified for consistency.
 */
export const JSONB_COLUMNS: Record<string, Set<string>> = {
  ocr_results: new Set(['raw_response', 'all_candidates']),
  product_searches: new Set(['results_raw']),
  audit_logs: new Set(['old_value', 'new_value']),
}

export function isJsonbColumn(table: string, column: string): boolean {
  return JSONB_COLUMNS[table]?.has(column) ?? false
}
