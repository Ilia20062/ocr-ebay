import { query } from './pg'
import { getRelationship, type Relationship } from './relationships'
import { isJsonbColumn } from './schema'

/**
 * A small, faithful re-implementation of the subset of the supabase-js / PostgREST
 * query builder that this app actually uses, executed against raw Postgres.
 *
 * Supported:
 *   .select(cols, { count, head }) | .insert | .update | .delete | .upsert(v,{onConflict})
 *   .eq .neq .gt .gte .lt .lte .in .is .like .ilike
 *   .order(col,{ascending}) .limit(n) .range(from,to)
 *   .single() .maybeSingle()
 *   PostgREST resource embedding: `*, images(...)`, `ocr_results(*)`,
 *     `upload_batches!inner(user_id)`, plus dotted filters on inner relations
 *     (e.g. .eq('upload_batches.user_id', id)).
 *
 * Awaiting a builder resolves to `{ data, error, count }` — pg errors are
 * returned in `error`, never thrown, matching supabase-js semantics.
 */

export interface PgError {
  message: string
  code?: string
  details?: string
  hint?: string
}

export interface Result<T> {
  data: T
  error: PgError | null
  count: number | null
}

type Op = 'select' | 'insert' | 'update' | 'delete' | 'upsert'

interface Filter {
  column: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is' | 'like' | 'ilike'
  value: unknown
}

interface OrderSpec {
  column: string
  ascending: boolean
  nullsFirst?: boolean
}

interface SelectField {
  kind: 'column' | 'embed'
  // column
  name?: string
  // embed
  rel?: Relationship
  embedName?: string
  inner?: boolean
  fields?: SelectField[]
}

const COMPARATORS: Record<Filter['op'], string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  in: '= ANY',
  is: 'IS',
  like: 'LIKE',
  ilike: 'ILIKE',
}

function ident(name: string): string {
  // Quote an identifier; reject anything that isn't a plain column/table name.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`)
  }
  return `"${name}"`
}

/** Split a select string on top-level commas (ignoring commas inside parens). */
function splitTopLevel(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of input) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Parse a PostgREST select string for a given base table into structured fields. */
function parseSelect(base: string, select: string): SelectField[] {
  const tokens = splitTopLevel(select)
  const fields: SelectField[] = []
  for (const token of tokens) {
    const paren = token.indexOf('(')
    if (paren === -1) {
      // plain column (or '*')
      fields.push({ kind: 'column', name: token.trim() })
      continue
    }
    // embed: name[!inner](innerSelect)
    const head = token.slice(0, paren).trim()
    const innerSelect = token.slice(paren + 1, token.lastIndexOf(')'))
    const inner = head.includes('!inner')
    const embedName = head.split('!')[0].trim()
    const rel = getRelationship(base, embedName)
    if (!rel) {
      throw new Error(`No relationship registered for ${base} -> ${embedName}`)
    }
    fields.push({
      kind: 'embed',
      embedName,
      rel,
      inner,
      fields: parseSelect(rel.table, innerSelect),
    })
  }
  return fields
}

let aliasCounter = 0
function nextAlias(prefix: string): string {
  aliasCounter = (aliasCounter + 1) % 1_000_000
  return `${prefix}_${aliasCounter}`
}

// Default generic is `any` so existing call sites that read `.data.foo` without
// casting keep compiling (mirrors how the strongly-typed supabase client erased
// at those sites). Specific call sites still cast where they need a real type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class QueryBuilder<T = any> implements PromiseLike<Result<T[]>> {
  private op: Op = 'select'
  private selectStr = '*'
  private countMode: 'exact' | null = null
  private headOnly = false
  private filters: Filter[] = []
  private embeddedFilters: { relation: string; column: string; value: unknown }[] = []
  private orders: OrderSpec[] = []
  private limitN: number | null = null
  private offsetN = 0
  private writeValues: Record<string, unknown> | Record<string, unknown>[] | null = null
  private onConflict: string | null = null
  private wantReturning = false
  private returningStr = '*'
  private shaper: 'none' | 'single' | 'maybeSingle' = 'none'

  constructor(private table: string) {}

  // ---- operations ----
  select(columns = '*', opts?: { count?: 'exact'; head?: boolean }): this {
    if (this.op === 'select' && this.writeValues === null) {
      this.selectStr = columns
      if (opts?.count) this.countMode = opts.count
      if (opts?.head) this.headOnly = true
    } else {
      // .select() after a write => RETURNING
      this.wantReturning = true
      this.returningStr = columns
    }
    return this
  }

  // Write-value params accept any object shape (concrete interfaces without an
  // index signature included) — this is a thin shim, not a typed ORM.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  insert(values: Record<string, any> | Record<string, any>[]): this {
    this.op = 'insert'
    this.writeValues = values
    return this
  }

  update(values: Record<string, any>): this {
    this.op = 'update'
    this.writeValues = values
    return this
  }

  delete(): this {
    this.op = 'delete'
    return this
  }

  upsert(
    values: Record<string, any> | Record<string, any>[],
    opts?: { onConflict?: string }
  ): this {
    this.op = 'upsert'
    this.writeValues = values
    this.onConflict = opts?.onConflict ?? null
    return this
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ---- filters ----
  private addFilter(op: Filter['op'], column: string, value: unknown): this {
    if (column.includes('.')) {
      const [relation, col] = column.split('.')
      this.embeddedFilters.push({ relation, column: col, value })
    } else {
      this.filters.push({ op, column, value })
    }
    return this
  }
  eq(c: string, v: unknown) { return this.addFilter('eq', c, v) }
  neq(c: string, v: unknown) { return this.addFilter('neq', c, v) }
  gt(c: string, v: unknown) { return this.addFilter('gt', c, v) }
  gte(c: string, v: unknown) { return this.addFilter('gte', c, v) }
  lt(c: string, v: unknown) { return this.addFilter('lt', c, v) }
  lte(c: string, v: unknown) { return this.addFilter('lte', c, v) }
  in(c: string, v: unknown[]) { return this.addFilter('in', c, v) }
  is(c: string, v: unknown) { return this.addFilter('is', c, v) }
  like(c: string, v: unknown) { return this.addFilter('like', c, v) }
  ilike(c: string, v: unknown) { return this.addFilter('ilike', c, v) }

  // ---- modifiers ----
  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orders.push({ column, ascending: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst })
    return this
  }
  limit(n: number): this {
    this.limitN = n
    return this
  }
  range(from: number, to: number): this {
    this.offsetN = from
    this.limitN = to - from + 1
    return this
  }

  // ---- shapers ----
  // single()/maybeSingle() narrow the awaited result from a row array
  // (Result<T[]>) to a single row (Result<T>). The runtime behaviour is set via
  // the `shaper` flag; the cast just realigns the static type.
  single(): PromiseLike<Result<T>> {
    this.shaper = 'single'
    return this as unknown as PromiseLike<Result<T>>
  }
  maybeSingle(): PromiseLike<Result<T>> {
    this.shaper = 'maybeSingle'
    return this as unknown as PromiseLike<Result<T>>
  }

  // ---- execution ----
  // A bare await (no single()) resolves to a row array: Result<T[]>.
  then<R1 = Result<T[]>, R2 = never>(
    onfulfilled?: ((value: Result<T[]>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.execute().then(onfulfilled as any, onrejected)
  }

  private async execute(): Promise<Result<unknown>> {
    try {
      switch (this.op) {
        case 'select':
          return await this.runSelect()
        case 'insert':
        case 'upsert':
          return await this.runInsert()
        case 'update':
          return await this.runUpdate()
        case 'delete':
          return await this.runDelete()
      }
    } catch (err) {
      return this.shapeError(err)
    }
  }

  // ---- WHERE assembly (shared by select/update/delete/count) ----
  private buildWhere(params: unknown[], baseAlias: string): string {
    const clauses: string[] = []
    for (const f of this.filters) {
      const col = `${ident(baseAlias)}.${ident(f.column)}`
      if (f.op === 'in') {
        params.push(f.value)
        clauses.push(`${col} = ANY($${params.length})`)
      } else if (f.op === 'is') {
        const v = f.value
        const sqlVal = v === null ? 'NULL' : v === true ? 'TRUE' : v === false ? 'FALSE' : null
        if (sqlVal === null) {
          params.push(v)
          clauses.push(`${col} = $${params.length}`)
        } else {
          clauses.push(`${col} IS ${sqlVal}`)
        }
      } else {
        params.push(f.value)
        clauses.push(`${col} ${COMPARATORS[f.op]} $${params.length}`)
      }
    }
    // Inner-relation EXISTS filters (e.g. upload_batches!inner + .eq('upload_batches.user_id', id))
    for (const ef of this.embeddedFilters) {
      const rel = getRelationship(this.table, ef.relation)
      if (!rel || rel.type !== 'one') {
        throw new Error(`Cannot filter on relation ${this.table}.${ef.relation}`)
      }
      const pa = nextAlias('ef')
      params.push(ef.value)
      clauses.push(
        `EXISTS (SELECT 1 FROM ${ident(rel.table)} ${ident(pa)} ` +
          `WHERE ${ident(pa)}.${ident(rel.parentPk ?? 'id')} = ${ident(baseAlias)}.${ident(rel.localKey!)} ` +
          `AND ${ident(pa)}.${ident(ef.column)} = $${params.length})`
      )
    }
    // `!inner` embeds with no explicit filter still require the parent to exist.
    const fields = this.op === 'select' ? parseSelect(this.table, this.selectStr) : []
    for (const fld of fields) {
      if (fld.kind === 'embed' && fld.inner && fld.rel!.type === 'one') {
        const hasFilter = this.embeddedFilters.some((e) => e.relation === fld.embedName)
        if (!hasFilter) {
          const pa = nextAlias('ix')
          clauses.push(
            `EXISTS (SELECT 1 FROM ${ident(fld.rel!.table)} ${ident(pa)} ` +
              `WHERE ${ident(pa)}.${ident(fld.rel!.parentPk ?? 'id')} = ${ident(baseAlias)}.${ident(fld.rel!.localKey!)})`
          )
        }
      }
    }
    return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  }

  private buildEmbedColumn(field: SelectField, baseAlias: string): string {
    const rel = field.rel!
    const childAlias = nextAlias('e')
    const colList = this.buildSelectList(field.fields!, childAlias, rel.table)
    if (rel.type === 'many') {
      return (
        `(SELECT COALESCE(json_agg(row_to_json(sub)), '[]'::json) FROM ` +
        `(SELECT ${colList} FROM ${ident(rel.table)} ${ident(childAlias)} ` +
        `WHERE ${ident(childAlias)}.${ident(rel.fk!)} = ${ident(baseAlias)}.${ident(rel.pk ?? 'id')}) sub) ` +
        `AS ${ident(field.embedName!)}`
      )
    }
    // one
    return (
      `(SELECT row_to_json(sub) FROM ` +
      `(SELECT ${colList} FROM ${ident(rel.table)} ${ident(childAlias)} ` +
      `WHERE ${ident(childAlias)}.${ident(rel.parentPk ?? 'id')} = ${ident(baseAlias)}.${ident(rel.localKey!)}) sub) ` +
      `AS ${ident(field.embedName!)}`
    )
  }

  private buildSelectList(fields: SelectField[], alias: string, table: string): string {
    const parts: string[] = []
    for (const f of fields) {
      if (f.kind === 'column') {
        if (f.name === '*') parts.push(`${ident(alias)}.*`)
        else parts.push(`${ident(alias)}.${ident(f.name!)}`)
      } else {
        parts.push(this.buildEmbedColumn(f, alias))
      }
    }
    return parts.length ? parts.join(', ') : `${ident(alias)}.*`
  }

  private async runSelect(): Promise<Result<unknown>> {
    const baseAlias = this.table
    const params: unknown[] = []
    const fields = parseSelect(this.table, this.selectStr)
    const where = this.buildWhere(params, baseAlias)

    let count: number | null = null
    if (this.countMode === 'exact') {
      const countParams: unknown[] = []
      const countWhere = this.buildWhere(countParams, baseAlias)
      const countSql = `SELECT count(*)::int AS c FROM ${ident(this.table)} ${ident(baseAlias)}${countWhere}`
      const cr = await query<{ c: number }>(countSql, countParams)
      count = cr.rows[0]?.c ?? 0
    }

    if (this.headOnly) {
      return { data: [], error: null, count }
    }

    const selectList = this.buildSelectList(fields, baseAlias, this.table)
    let sql = `SELECT ${selectList} FROM ${ident(this.table)} ${ident(baseAlias)}${where}`
    if (this.orders.length) {
      sql +=
        ' ORDER BY ' +
        this.orders
          .map((o) => {
            const dir = o.ascending ? 'ASC' : 'DESC'
            const nulls =
              o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'
            return `${ident(baseAlias)}.${ident(o.column)} ${dir}${nulls}`
          })
          .join(', ')
    }
    if (this.limitN !== null) {
      params.push(this.limitN)
      sql += ` LIMIT $${params.length}`
    }
    if (this.offsetN) {
      params.push(this.offsetN)
      sql += ` OFFSET $${params.length}`
    }

    const r = await query(sql, params)
    return this.shapeRows(r.rows, count)
  }

  private prepareValue(table: string, column: string, value: unknown): unknown {
    if (value !== null && value !== undefined && isJsonbColumn(table, column)) {
      return JSON.stringify(value)
    }
    return value
  }

  private async runInsert(): Promise<Result<unknown>> {
    const rows = Array.isArray(this.writeValues) ? this.writeValues : [this.writeValues!]
    if (rows.length === 0) {
      return { data: [], error: null, count: null }
    }
    // Union of columns across all rows (keeps multi-row inserts consistent).
    const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
    const params: unknown[] = []
    const valuesSql = rows
      .map((row) => {
        const placeholders = columns.map((col) => {
          params.push(this.prepareValue(this.table, col, row[col] ?? null))
          return `$${params.length}`
        })
        return `(${placeholders.join(', ')})`
      })
      .join(', ')

    let sql = `INSERT INTO ${ident(this.table)} (${columns.map(ident).join(', ')}) VALUES ${valuesSql}`

    if (this.op === 'upsert' && this.onConflict) {
      const conflictCols = this.onConflict.split(',').map((c) => c.trim())
      const updateCols = columns.filter((c) => !conflictCols.includes(c))
      const setClause = updateCols.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')
      sql += ` ON CONFLICT (${conflictCols.map(ident).join(', ')}) DO ${
        updateCols.length ? `UPDATE SET ${setClause}` : 'NOTHING'
      }`
    }

    if (this.wantReturning) sql += ` RETURNING ${this.returningStr === '*' ? '*' : this.returningStr}`

    const r = await query(sql, params)
    if (!this.wantReturning) return { data: null, error: null, count: null }
    return this.shapeRows(r.rows, null)
  }

  private async runUpdate(): Promise<Result<unknown>> {
    const values = this.writeValues as Record<string, unknown>
    const columns = Object.keys(values)
    const params: unknown[] = []
    const setClause = columns
      .map((col) => {
        params.push(this.prepareValue(this.table, col, values[col]))
        return `${ident(col)} = $${params.length}`
      })
      .join(', ')
    const where = this.buildWhere(params, this.table)
    let sql = `UPDATE ${ident(this.table)} AS ${ident(this.table)} SET ${setClause}${where}`
    if (this.wantReturning) sql += ` RETURNING *`
    const r = await query(sql, params)
    if (!this.wantReturning) return { data: null, error: null, count: null }
    return this.shapeRows(r.rows, null)
  }

  private async runDelete(): Promise<Result<unknown>> {
    const params: unknown[] = []
    const where = this.buildWhere(params, this.table)
    let sql = `DELETE FROM ${ident(this.table)} AS ${ident(this.table)}${where}`
    if (this.wantReturning) sql += ` RETURNING *`
    const r = await query(sql, params)
    if (!this.wantReturning) return { data: null, error: null, count: null }
    return this.shapeRows(r.rows, null)
  }

  private shapeRows(rows: Record<string, unknown>[], count: number | null): Result<unknown> {
    if (this.shaper === 'single') {
      if (rows.length === 1) return { data: rows[0], error: null, count }
      if (rows.length === 0) {
        return {
          data: null,
          error: { message: 'No rows found', code: 'PGRST116' },
          count,
        }
      }
      return {
        data: null,
        error: { message: 'Multiple rows returned for single()', code: 'PGRST116' },
        count,
      }
    }
    if (this.shaper === 'maybeSingle') {
      if (rows.length <= 1) return { data: (rows[0] ?? null), error: null, count }
      return {
        data: null,
        error: { message: 'Multiple rows returned for maybeSingle()', code: 'PGRST116' },
        count,
      }
    }
    return { data: rows, error: null, count }
  }

  private shapeError(err: unknown): Result<unknown> {
    const e = err as { message?: string; code?: string; detail?: string; hint?: string }
    return {
      data: null,
      error: { message: e.message ?? String(err), code: e.code, details: e.detail, hint: e.hint },
      count: null,
    }
  }
}
