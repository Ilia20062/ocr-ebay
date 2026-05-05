import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_HEX = process.env.ENCRYPTION_KEY!

function getKey(): Buffer {
  if (!KEY_HEX) throw new Error('ENCRYPTION_KEY env var is missing')
  return Buffer.from(KEY_HEX, 'hex')
}

export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error(`encrypt: plaintext must be a non-empty string (got ${typeof plaintext})`)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Format: iv(12):authTag(16):ciphertext — all hex
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':')
}

export function decrypt(ciphertext: string): string {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new Error(`decrypt: ciphertext must be a non-empty string (got ${typeof ciphertext})`)
  }
  const parts = ciphertext.split(':')
  if (parts.length !== 3) {
    throw new Error(`decrypt: malformed ciphertext — expected iv:authTag:data (got ${parts.length} part(s), len=${ciphertext.length})`)
  }
  const [ivHex, authTagHex, encryptedHex] = parts
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error('decrypt: empty segment in ciphertext')
  }
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
