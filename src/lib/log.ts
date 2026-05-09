/**
 * Tiny structured logger. Server side: writes `[HH:MM:SS.mmm] [LVL] msg key=val …`
 * to stdout/stderr so log aggregators stay scannable while every entry carries
 * enough context (session_id, batch_id, image_id, dur_ms, err) to debug a
 * specific run without repro.
 *
 * Browser side: same shape via console.{log,warn,error}, useful when checking
 * the upload progress widget without DevTools network panel.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  /** What part of the system this log is from. e.g. "session.process". */
  scope?: string
  user_id?: string | null
  session_id?: string | null
  batch_id?: string | null
  image_id?: string | null
  filename?: string | null
  cluster_idx?: number
  cluster_size?: number
  total?: number
  dur_ms?: number
  attempt?: number
  status_code?: number
  /** An Error or any thrown value. Stack is logged on level=error. */
  err?: unknown
  [key: string]: unknown
}

const SHORT: Record<LogLevel, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }

function fmtCtx(ctx: LogContext): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(ctx)) {
    if (k === 'err') continue
    if (v === undefined || v === null) continue
    if (typeof v === 'string') {
      parts.push(`${k}=${v.includes(' ') ? JSON.stringify(v) : v}`)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`)
    } else {
      parts.push(`${k}=${JSON.stringify(v)}`)
    }
  }
  return parts.join(' ')
}

function fmtErr(err: unknown): string {
  if (!err) return ''
  if (err instanceof Error) {
    return ` err=${JSON.stringify(err.message)}${err.name && err.name !== 'Error' ? ` errType=${err.name}` : ''}`
  }
  return ` err=${JSON.stringify(String(err))}`
}

function emit(level: LogLevel, msg: string, ctx: LogContext = {}): void {
  const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
  const tagPart = fmtCtx(ctx)
  const errPart = fmtErr(ctx.err)
  const line = `[${ts}] [${SHORT[level]}] ${msg}${tagPart ? ' ' + tagPart : ''}${errPart}`

  if (level === 'error') {
    console.error(line)
    if (ctx.err instanceof Error && ctx.err.stack) console.error(ctx.err.stack)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

export const log = {
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
}

/**
 * Bind a fixed context to every subsequent call. Useful inside a request
 * handler or background task so you don't repeat user_id / session_id etc.
 */
export function withContext(base: LogContext) {
  return {
    debug: (msg: string, ctx?: LogContext) => emit('debug', msg, { ...base, ...ctx }),
    info: (msg: string, ctx?: LogContext) => emit('info', msg, { ...base, ...ctx }),
    warn: (msg: string, ctx?: LogContext) => emit('warn', msg, { ...base, ...ctx }),
    error: (msg: string, ctx?: LogContext) => emit('error', msg, { ...base, ...ctx }),
  }
}
