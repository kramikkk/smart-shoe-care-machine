import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32

function getMasterKey(): Buffer {
  const rawKey = process.env.PAYMENT_CREDENTIALS_MASTER_KEY
  if (!rawKey) {
    throw new Error('PAYMENT_CREDENTIALS_MASTER_KEY is not defined')
  }

  // Accept base64 (preferred) or raw 32-char key for local development.
  const decoded = Buffer.from(rawKey, 'base64')
  if (decoded.length === KEY_LENGTH) {
    return decoded
  }

  const utf8Buffer = Buffer.from(rawKey, 'utf8')
  if (utf8Buffer.length === KEY_LENGTH) {
    return utf8Buffer
  }

  throw new Error('PAYMENT_CREDENTIALS_MASTER_KEY must decode to 32 bytes')
}

export function encryptPaymentCredential(plainText: string): string {
  const key = getMasterKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`
}

export function decryptPaymentCredential(encoded: string): string {
  const [ivB64, tagB64, encryptedB64] = encoded.split('.')
  if (!ivB64 || !tagB64 || !encryptedB64) {
    throw new Error('Invalid encrypted credential format')
  }

  const key = getMasterKey()
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(tagB64, 'base64')
  const encrypted = Buffer.from(encryptedB64, 'base64')

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted credential components')
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString('utf8')
}
