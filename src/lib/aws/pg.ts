import { Pool, type PoolClient, type QueryResultRow } from 'pg'

/**
 * Singleton Postgres connection pool for the whole app.
 *
 * Replaces the Supabase Postgres backend. Every Supabase `.from(...)` call now
 * funnels through this pool (see `query-builder.ts`).
 *
 * Connection config comes from the standard libpq env vars / DATABASE_URL.
 * In AWS these are injected from Secrets Manager into the ECS task.
 */

let pool: Pool | null = null

function buildPool(): Pool {
  const connectionString = process.env.DATABASE_URL

  // RDS requires TLS. The AWS RDS CA is trusted by Node when we don't pin a
  // CA bundle; we relax `rejectUnauthorized` because the default Node trust
  // store does not include the RDS regional CA and we terminate inside the VPC.
  const ssl =
    process.env.PGSSL === 'disable'
      ? false
      : { rejectUnauthorized: false }

  if (connectionString) {
    return new Pool({ connectionString, ssl, max: poolMax() })
  }

  return new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl,
    max: poolMax(),
  })
}

function poolMax(): number {
  const v = process.env.PG_POOL_MAX
  return v ? parseInt(v, 10) : 10
}

export function getPool(): Pool {
  if (!pool) {
    pool = buildPool()
    pool.on('error', (err) => {
      // Idle client errors must not crash the process.
      console.error('[pg] idle client error', err.message)
    })
  }
  return pool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<{ rows: T[]; rowCount: number }> {
  const res = await getPool().query<T>(text, params as never[])
  return { rows: res.rows, rowCount: res.rowCount ?? 0 }
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
