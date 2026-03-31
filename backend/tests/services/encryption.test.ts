import { describe, it, expect, beforeAll } from 'vitest'

// Set env before importing module
process.env.ENCRYPTION_SECRET = 'test-secret-key-for-unit-tests'

import { encrypt, decrypt, maskKey } from '../../src/services/encryption'

describe('encryption service', () => {
  it('encrypt then decrypt returns original plaintext', () => {
    const plaintext = 'my-api-key-abc123'
    const encrypted = encrypt(plaintext)
    expect(decrypt(encrypted)).toBe(plaintext)
  })

  it('encrypt then decrypt works for various inputs', () => {
    const inputs = ['short', 'a'.repeat(200), 'special-chars!@#$%^&*()', '']
    for (const input of inputs) {
      const encrypted = encrypt(input)
      expect(decrypt(encrypted)).toBe(input)
    }
  })

  it('encrypt produces different ciphertext each call (random IV)', () => {
    const plaintext = 'same-plaintext'
    const enc1 = encrypt(plaintext)
    const enc2 = encrypt(plaintext)
    expect(enc1).not.toBe(enc2)
    // But both decrypt to same value
    expect(decrypt(enc1)).toBe(plaintext)
    expect(decrypt(enc2)).toBe(plaintext)
  })

  it('decrypt with tampered ciphertext throws error', () => {
    const encrypted = encrypt('some-data')
    const parts = encrypted.split(':')
    // Tamper with the encrypted data
    parts[2] = 'deadbeef' + parts[2].slice(8)
    expect(() => decrypt(parts.join(':'))).toThrow()
  })

  it('maskKey decrypts and masks long keys', () => {
    const plaintext = 'abcdefghijklmnop'
    const encrypted = encrypt(plaintext)
    const masked = maskKey(encrypted)
    expect(masked).toBe('abc***nop')
  })

  it('maskKey returns null for null input', () => {
    expect(maskKey(null)).toBeNull()
  })

  it('maskKey returns *** for short strings (<=6 chars)', () => {
    const plaintext = 'abc'
    const encrypted = encrypt(plaintext)
    expect(maskKey(encrypted)).toBe('***')
  })
})
