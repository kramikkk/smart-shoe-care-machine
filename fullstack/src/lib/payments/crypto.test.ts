import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptPaymentCredential, encryptPaymentCredential } from '@/lib/payments/crypto'

test('encrypt/decrypt round-trip', () => {
  process.env.PAYMENT_CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
  const original = 'sk_test_example_secret'
  const encrypted = encryptPaymentCredential(original)
  const decrypted = decryptPaymentCredential(encrypted)
  assert.equal(decrypted, original)
})

test('decrypt throws on malformed payload', () => {
  process.env.PAYMENT_CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 5).toString('base64')
  assert.throws(() => decryptPaymentCredential('malformed-payload'))
})
