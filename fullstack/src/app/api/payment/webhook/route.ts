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
      const webhookMeta = paymentData.metadata as Record<string, string> | null | undefined

      const mappedIntent = paymentIntentId
        ? await prisma.paymentIntentMap.findUnique({
            where: { paymentIntentId },
            select: { deviceId: true, clientId: true, serviceMetadata: true },
          })
        : null

      // PayMongo's payment.paid webhook delivers a Payment resource whose metadata
      // is separate from the PaymentIntent's metadata — for QRPH it is typically null.
      // Always prefer the authoritative copy we stored in PaymentIntentMap at creation.
      type StoredMeta = { shoeType?: string; careType?: string; serviceType?: string; baseAmount?: string; paymentFee?: string; totalAmount?: string; paymentMethod?: string }
      const storedMeta = mappedIntent?.serviceMetadata as StoredMeta | null | undefined

      const resolvedDeviceId = webhookMeta?.deviceId ?? mappedIntent?.deviceId
      if (!resolvedDeviceId) {
        console.error('[Webhook] payment.paid missing deviceId in metadata')
        return NextResponse.json({ received: true })
      }

      if (!paymentId) {
        console.error('[Webhook] payment.paid missing paymentId — skipping')
        return NextResponse.json({ received: true })
      }

      const shoeType = webhookMeta?.shoeType ?? storedMeta?.shoeType
      const careType = webhookMeta?.careType ?? storedMeta?.careType
      const serviceType = webhookMeta?.serviceType ?? storedMeta?.serviceType ?? 'Package'
      const paymentMethod = webhookMeta?.paymentMethod ?? storedMeta?.paymentMethod ?? 'Online'
      const baseAmountStr = webhookMeta?.baseAmount ?? webhookMeta?.amount ?? storedMeta?.baseAmount ?? '0'
      const paymentFeeStr = webhookMeta?.paymentFee ?? storedMeta?.paymentFee ?? '0'
      const totalAmountStr = webhookMeta?.totalAmount ?? webhookMeta?.amount ?? storedMeta?.totalAmount ?? '0'

      if (!shoeType || !careType) {
        console.error('[Webhook] payment.paid missing required service fields (shoeType/careType) — skipping')
        return NextResponse.json({ received: true })
      }

      const parsedBaseAmount = parseFloat(baseAmountStr)
      const parsedPaymentFee = parseFloat(paymentFeeStr)
      const parsedTotalAmount = parseFloat(totalAmountStr)
      const normalizedTotalAmount = Number.isFinite(parsedTotalAmount)
        ? parsedTotalAmount
        : parsedBaseAmount + (Number.isFinite(parsedPaymentFee) ? parsedPaymentFee : 0)

      let transaction
      try {
        transaction = await prisma.transaction.create({
          data: {
            dateTime: new Date(),
            paymentMethod,
            serviceType,
            shoeType,
            careType,
            amount: parsedBaseAmount,
            amountPaid: normalizedTotalAmount,
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

      const paidAmount = transaction.amountPaid ?? transaction.amount
      broadcastPaymentSuccess(resolvedDeviceId, transaction.id, paidAmount)
      console.log(`[Webhook] payment.paid processed — tx: ${transaction.id}, device: ${resolvedDeviceId}, amount: ₱${paidAmount}`)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('[Webhook] Error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
