import crypto from 'crypto'

export function verifyPaymongoWebhookSignature(rawBody: string, signatureHeader: string, webhookSecret: string): boolean {
  if (!webhookSecret) return false

  const parts: Record<string, string> = {}
  for (const part of signatureHeader.split(',')) {
    const idx = part.indexOf('=')
    if (idx !== -1) parts[part.slice(0, idx)] = part.slice(idx + 1)
  }

  const timestamp = parts['t']
  const receivedSig = parts['li'] || parts['te']
  if (!timestamp || !receivedSig) return false

  const signedPayload = `${timestamp}.${rawBody}`
  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedPayload, 'utf8')
    .digest('hex')

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedSig, 'hex'),
      Buffer.from(expectedSig, 'hex')
    )
  } catch {
    return false
  }
}
