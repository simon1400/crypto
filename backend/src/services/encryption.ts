import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

let _key: Buffer | null = null

function getKey(): Buffer {
  if (_key) return _key
  const secret = process.env.ENCRYPTION_SECRET
  if (!secret) {
    throw new Error('ENCRYPTION_SECRET environment variable is required')
  }
  _key = scryptSync(secret, 'crypto-dashboard-salt', 32)
  return _key
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  let encrypted = cipher.update(plaintext, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`
}

export function decrypt(ciphertext: string): string {
  const key = getKey()
  const [ivHex, tagHex, encrypted] = ciphertext.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

export function maskKey(encrypted: string | null): string | null {
  if (encrypted === null) return null
  const decrypted = decrypt(encrypted)
  if (decrypted.length <= 6) return '***'
  return decrypted.slice(0, 3) + '***' + decrypted.slice(-3)
}
