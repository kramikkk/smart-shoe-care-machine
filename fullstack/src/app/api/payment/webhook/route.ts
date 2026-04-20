import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { Prisma } from '@/generated/prisma'
import { resolveWebhookSecretForPaymentIntent } from '@/lib/payments/provider-resolver'
import { verifyPaymongoWebhookSignature } from '@/lib/payments/webhook-signature'
import { broadcastPaymentSuccess } from '@/lib/websocket'

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()
    const body = JSON.parse(rawBody)
    const paymentResource = body?.data?.attributes?.data
    const paymentData = paymentResource?.attributes ?? {}
    const paymentId: string | undefined = paymentResource?.id
    const paymentIntentId: string | undefined = paymentData?.payment_intent_id

    const signatureHeader = request.headers.get('paymongo-signature')
    const webhookSecret = paymentIntentId
      ? await resolveWebhookSecretForPaymentIntent(paymentIntentId)
      : null
    if (!signatureHeader || !webhookSecret || !verifyPaymongoWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
      console.error('[Webhook] Invalid signature')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const eventType = body.data.attributes.type

    if (eventType === 'payment.paid') {
      const metadata = paymentData.metadata as Record<string, string> | undefined

      const mappedIntent = paymentIntentId
        ? await prisma.paymentIntentMap.findUnique({
            where: { paymentIntentId },
            select: { deviceId: true, clientId: true },
          })
        : null

      const resolvedDeviceId = metadata?.deviceId ?? mappedIntent?.deviceId
      if (!resolvedDeviceId) {
        console.error('[Webhook] payment.paid missing deviceId in metadata')
        return NextResponse.json({ received: true })
      }

      if (!paymentId) {
        console.error('[Webhook] payment.paid missing paymentId — skipping')
        return NextResponse.json({ received: true })
      }

      const metadataSafe = metadata ?? {}
      const { shoeType, careType, serviceType, amount, paymentMethod } = metadataSafe
      const parsedAmount = parseFloat(amount || '0')

      let transaction
      try {
        transaction = await prisma.transaction.create({
          data: {
            dateTime: new Date(),
            paymentMethod: paymentMethod || 'Online',
            serviceType: serviceType || 'Package',
            shoeType,
            careType,
            amount: parsedAmount,
            deviceId: resolvedDeviceId,
            paymongoPaymentId: paymentId,
          },
        })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          console.log(`[Webhook] Duplicate payment.paid ignored — paymentId: ${paymentId}`)
          return NextResponse.json({ received: true })
        }
        throw error
      }

      if (paymentIntentId) {
        await prisma.paymentIntentMap.updateMany({
          where: { paymentIntentId },
          data: {
            providerPaymentId: paymentId,
            status: paymentData.status ?? 'paid',
          },
        })
      }

      if (mappedIntent?.clientId) {
        await prisma.clientPaymentConfig.updateMany({
          where: { clientId: mappedIntent.clientId },
          data: { lastWebhookAt: new Date() },
        })
      }

      broadcastPaymentSuccess(resolvedDeviceId, transaction.id, transaction.amount)
      console.log(`[Webhook] payment.paid processed — tx: ${transaction.id}, device: ${resolvedDeviceId}, amount: ₱${transaction.amount}`)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('[Webhook] Error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
