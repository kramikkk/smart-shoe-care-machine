import assert from 'node:assert/strict'
import crypto from 'crypto'
import test from 'node:test'
import { verifyPaymongoWebhookSignature } from '@/lib/payments/webhook-signature'

test('validates PayMongo webhook signature', () => {
  const secret = 'whsec_test_secret'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const body = JSON.stringify({ data: { id: 'evt_1' } })
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex')
  const header = `t=${timestamp},te=${signature}`

  assert.equal(verifyPaymongoWebhookSignature(body, header, secret), true)
})

test('rejects invalid webhook signature', () => {
  const header = `t=${Math.floor(Date.now() / 1000)},te=deadbeef`
  assert.equal(verifyPaymongoWebhookSignature('{}', header, 'secret'), false)
})
