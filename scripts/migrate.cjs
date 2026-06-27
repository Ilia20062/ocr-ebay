/**
 * Standalone migration runner. Executes infra/sql/schema.sql against the
 * configured Postgres database. Designed to run as a one-off Fargate task
 * (same image/task-def as the app, command overridden to `node scripts/migrate.cjs`)
 * so it can reach a private RDS instance from inside the VPC.
 *
 * Connection comes from the same env the app uses (PGHOST/PGUSER/... or
 * DATABASE_URL), injected from Secrets Manager.
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

async function main() {
  const sqlPath = path.join(__dirname, '..', 'infra', 'sql', 'schema.sql')
  const sql = fs.readFileSync(sqlPath, 'utf8')

  const ssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
  const client = process.env.DATABASE_URL
    ? new Client({ connectionString: process.env.DATABASE_URL, ssl })
    : new Client({
        host: process.env.PGHOST,
        port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        ssl,
      })

  console.log(`[migrate] connecting to ${process.env.PGHOST || 'DATABASE_URL'} ...`)
  await client.connect()
  try {
    console.log('[migrate] applying schema.sql ...')
    await client.query(sql)
    console.log('[migrate] schema applied successfully.')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err.message)
  process.exit(1)
})
