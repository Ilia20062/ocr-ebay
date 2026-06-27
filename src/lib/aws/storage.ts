import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/**
 * S3-backed re-implementation of the Supabase Storage API surface the app uses.
 *
 * The app used a single logical Supabase bucket ("images"); we map that onto a
 * single S3 bucket (`S3_BUCKET`). The Supabase `storage_path` becomes the S3
 * object key verbatim, so existing path logic is unchanged.
 */

let s3: S3Client | null = null
function client(): S3Client {
  if (!s3) {
    s3 = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION })
  }
  return s3
}

function bucketName(): string {
  const b = process.env.S3_BUCKET
  if (!b) throw new Error('S3_BUCKET env var is not set')
  return b
}

const DEFAULT_UPLOAD_TTL = 900 // 15 minutes

interface StorageResult<T> {
  data: T | null
  error: { message: string } | null
}

class BucketApi {
  // The logical bucket name is ignored; all objects live in the one S3 bucket.
  constructor(private _logicalBucket: string) {}

  /** Presigned PUT URL. Content-Type is intentionally NOT signed so the browser
   *  may send any Content-Type header (it sends the file's MIME type). */
  async createSignedUploadUrl(
    path: string,
    opts?: { expiresIn?: number }
  ): Promise<StorageResult<{ signedUrl: string; token: string; path: string }>> {
    try {
      const url = await getSignedUrl(
        client(),
        new PutObjectCommand({ Bucket: bucketName(), Key: path }),
        { expiresIn: opts?.expiresIn ?? DEFAULT_UPLOAD_TTL }
      )
      return { data: { signedUrl: url, token: '', path }, error: null }
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } }
    }
  }

  /** Presigned GET URL for reading an object. */
  async createSignedUrl(
    path: string,
    expiresIn: number
  ): Promise<StorageResult<{ signedUrl: string }>> {
    try {
      const url = await getSignedUrl(
        client(),
        new GetObjectCommand({ Bucket: bucketName(), Key: path }),
        { expiresIn }
      )
      return { data: { signedUrl: url }, error: null }
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } }
    }
  }

  /** Download an object as a Blob (matches supabase-js `.download()`). */
  async download(path: string): Promise<StorageResult<Blob>> {
    try {
      const res = await client().send(
        new GetObjectCommand({ Bucket: bucketName(), Key: path })
      )
      const bytes = await res.Body!.transformToByteArray()
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: res.ContentType ?? 'application/octet-stream',
      })
      return { data: blob, error: null }
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } }
    }
  }

  /** Upload bytes directly (server-side). */
  async upload(
    path: string,
    body: Buffer | Uint8Array | Blob | ArrayBuffer,
    opts?: { contentType?: string; upsert?: boolean }
  ): Promise<StorageResult<{ path: string }>> {
    try {
      let payload: Buffer | Uint8Array
      if (body instanceof Blob) payload = Buffer.from(await body.arrayBuffer())
      else if (body instanceof ArrayBuffer) payload = Buffer.from(body)
      else payload = body
      await client().send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: path,
          Body: payload,
          ContentType: opts?.contentType,
        })
      )
      return { data: { path }, error: null }
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } }
    }
  }

  /** Delete one or more objects. */
  async remove(paths: string[]): Promise<StorageResult<{ paths: string[] }>> {
    try {
      if (paths.length === 0) return { data: { paths }, error: null }
      await client().send(
        new DeleteObjectsCommand({
          Bucket: bucketName(),
          Delete: { Objects: paths.map((Key) => ({ Key })) },
        })
      )
      return { data: { paths }, error: null }
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } }
    }
  }
}

export class StorageApi {
  from(bucket: string): BucketApi {
    return new BucketApi(bucket)
  }

  /** No-op: the S3 bucket is provisioned by IaC. Kept for call-site compatibility. */
  async createBucket(
    name: string,
    _opts?: { public?: boolean }
  ): Promise<StorageResult<{ name: string }>> {
    return { data: { name }, error: null }
  }
}

export const storage = new StorageApi()
