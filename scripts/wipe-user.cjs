/**
 * Admin one-off: wipe a single user's work data so the account starts fresh,
 * WITHOUT deleting the account itself.
 *
 *   KEEPS   : profiles, ebay_connections  (login + eBay link stay intact)
 *   DELETES : upload_sessions, upload_batches, images, ocr_results,
 *             product_searches, listings, retry_queue (theirs), audit_logs
 *             + every S3 object under the user's `<userId>/` key prefix.
 *
 * Runs as a one-off Fargate task on the app image/task-def (command overridden
 * to `node scripts/wipe-user.cjs <userId>`) so it can reach the private RDS and
 * use the task role for S3. DB creds come from the same env the app uses
 * (PGHOST/PGUSER/... injected from Secrets Manager); S3 bucket from S3_BUCKET.
 *
 * Usage:  node scripts/wipe-user.cjs <userId-uuid>
 */
const { Client } = require('pg')
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function main() {
  const userId = process.argv[2]
  if (!userId || !UUID_RE.test(userId)) {
    console.error('[wipe] ERROR: pass a userId UUID.  Usage: node scripts/wipe-user.cjs <userId>')
    process.exit(2)
  }

  const bucket = process.env.S3_BUCKET
  if (!bucket) {
    console.error('[wipe] ERROR: S3_BUCKET env var is not set.')
    process.exit(2)
  }

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

  console.log(`[wipe] target user: ${userId}`)
  console.log(`[wipe] connecting to ${process.env.PGHOST || 'DATABASE_URL'} ...`)
  await client.connect()

  // Sanity: the account must exist (and we log its email so an operator can
  // eyeball that it's the intended account before the deletes commit).
  const prof = await client.query('SELECT email FROM profiles WHERE id = $1', [userId])
  if (prof.rowCount === 0) {
    console.error(`[wipe] ERROR: no profile with id ${userId} — refusing to run.`)
    await client.end()
    process.exit(1)
  }
  console.log(`[wipe] account email: ${prof.rows[0].email}`)

  // Collect the user's S3 object keys BEFORE deleting the rows (belt: the DB
  // paths; suspenders: a prefix sweep below catches any orphaned objects).
  const imgRows = await client.query('SELECT storage_path FROM images WHERE user_id = $1', [userId])
  const dbKeys = imgRows.rows.map((r) => r.storage_path).filter(Boolean)
  console.log(`[wipe] images rows: ${imgRows.rowCount} (db storage keys: ${dbKeys.length})`)

  // ---- DB wipe (single transaction) ----------------------------------------
  const counts = {}
  try {
    await client.query('BEGIN')

    // retry_queue has no user_id / FK — delete rows pointing at this user's
    // images / searches / listings while those rows still exist.
    counts.retry_images = (await client.query(
      'DELETE FROM retry_queue WHERE entity_id IN (SELECT id FROM images WHERE user_id = $1)', [userId],
    )).rowCount
    counts.retry_listings = (await client.query(
      'DELETE FROM retry_queue WHERE entity_id IN (SELECT id FROM listings WHERE user_id = $1)', [userId],
    )).rowCount
    counts.retry_searches = (await client.query(
      `DELETE FROM retry_queue WHERE entity_id IN (
         SELECT ps.id FROM product_searches ps
         JOIN upload_batches ub ON ub.id = ps.batch_id
         WHERE ub.user_id = $1)`, [userId],
    )).rowCount

    counts.audit_logs = (await client.query('DELETE FROM audit_logs WHERE user_id = $1', [userId])).rowCount
    // listings -> (kept explicit; also covered by product_searches cascade)
    counts.listings = (await client.query('DELETE FROM listings WHERE user_id = $1', [userId])).rowCount
    // upload_sessions cascades: batches -> images -> ocr_results / product_searches -> listings
    counts.upload_sessions = (await client.query('DELETE FROM upload_sessions WHERE user_id = $1', [userId])).rowCount
    // batches not tied to a session (auto_grouped=false); cascades the rest
    counts.upload_batches = (await client.query('DELETE FROM upload_batches WHERE user_id = $1', [userId])).rowCount
    // any images with neither a session nor a batch
    counts.images = (await client.query('DELETE FROM images WHERE user_id = $1', [userId])).rowCount

    await client.query('COMMIT')
    console.log('[wipe] DB deletes committed:', JSON.stringify(counts))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[wipe] DB wipe FAILED, rolled back:', err.message)
    await client.end()
    process.exit(1)
  } finally {
    await client.end()
  }

  // ---- S3 wipe (after DB commit) -------------------------------------------
  // Delete every object under `<userId>/`, unioned with the DB keys (in case
  // any object was stored outside that prefix).
  const s3 = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION })
  const keys = new Set(dbKeys)
  let token
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: `${userId}/`, ContinuationToken: token,
    }))
    for (const o of page.Contents || []) keys.add(o.Key)
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)

  const allKeys = [...keys]
  console.log(`[wipe] S3 objects to delete: ${allKeys.length}`)
  let deleted = 0
  for (let i = 0; i < allKeys.length; i += 1000) {
    const chunk = allKeys.slice(i, i + 1000)
    const res = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
    }))
    deleted += chunk.length - (res.Errors ? res.Errors.length : 0)
    if (res.Errors && res.Errors.length) {
      console.error(`[wipe] S3 delete errors: ${res.Errors.length} (first: ${res.Errors[0].Key} ${res.Errors[0].Message})`)
    }
  }
  console.log(`[wipe] S3 objects deleted: ${deleted}/${allKeys.length}`)
  console.log('[wipe] DONE — account kept, work data + images wiped.')
}

main().catch((err) => {
  console.error('[wipe] FATAL:', err.message)
  process.exit(1)
})
