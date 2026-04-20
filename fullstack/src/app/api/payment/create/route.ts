import { NextRequest, NextResponse } from 'next/server'
import { PaymentProvider } from '@/generated/prisma'
import { PayMongoClient } from '@/lib/paymongo/client'
import prisma from '@/lib/prisma'
import { resolvePaymentContextByDevice } from '@/lib/payments/provider-resolver'
import { z } from 'zod'
import { rateLimit } from '@/lib/rate-limit'

const DEFAULT_QRPH_FEE_RATE = 0.0134 // 1.34%

const getQrphFeeRate = () => {
  const raw = process.env.PAYMENT_QRPH_FEE_RATE
  const parsed = Number(raw)
  if (!raw || Number.isNaN(parsed) || parsed < 0 || parsed > 1) return DEFAULT_QRPH_FEE_RATE
  return parsed
}

const roundCurrency = (value: number) => Math.round(value * 100) / 100

const PaymentCreateSchema = z.object({
  amount: z.number().min(1).max(50000),
  description: z.string().min(1),
  deviceId: z.string().regex(/^SSCM-[A-F0-9]{6}$/, 'Invalid device ID format'),
  shoeType: z.enum(['Canvas', 'Rubber', 'Mesh']),
  careType: z.enum(['Gentle', 'Normal', 'Strong', 'Auto']),
  serviceType: z.enum(['Cleaning', 'Drying', 'Sterilizing', 'Package']),
})

export async function POST(request: NextRequest) {
  const rateLimitResult = rateLimit(request, { maxRequests: 10, windowMs: 60000 })
  if (rateLimitResult) return rateLimitResult

  const groupToken = request.headers.get('X-Group-Token')
  if (!groupToken) {
    return NextResponse.json({ success: false, error: 'Missing X-Group-Token' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const validation = PaymentCreateSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid input', details: validation.error.issues },
        { status: 400 }
      )
    }

    const { amount, description, deviceId, shoeType, careType, serviceType } = validation.data

    const device = await prisma.device.findUnique({
      where: { deviceId },
      select: { groupToken: true, pairedBy: true },
    })
    if (!device || device.groupToken !== groupToken || !device.pairedBy) {
      return NextResponse.json({ success: false, error: 'Invalid group token' }, { status: 403 })
    }

    const resolvedContext = await resolvePaymentContextByDevice(deviceId)
    const client = new PayMongoClient({
      authType: resolvedContext.paymongo.authType,
      token: resolvedContext.paymongo.token,
    })

    const baseAmount = roundCurrency(amount)
    const feeRate = getQrphFeeRate()
    const paymentFee = roundCurrency(baseAmount * feeRate)
    const totalAmount = roundCurrency(baseAmount + paymentFee)

    // Pass all service metadata so webhook can create Transaction on success
    const paymentIntentResponse = await client.createPaymentIntent(
      totalAmount,
      description,
      {
        deviceId,
        shoeType,
        careType,
        serviceType,
        amount: String(baseAmount),
        baseAmount: String(baseAmount),
        paymentFee: String(paymentFee),
        totalAmount: String(totalAmount),
        feeRatePercent: String(roundCurrency(feeRate * 100)),
        paymentMethod: 'Online',
      }
    )
    const paymentIntentId = paymentIntentResponse.data.id
    const paymentIntentStatus = paymentIntentResponse.data.attributes?.status ?? 'awaiting_payment_method'

    const paymentMethodResponse = await client.createPaymentMethod()
    const paymentMethodId = paymentMethodResponse.data.id

    const attachResponse = await client.attachPaymentMethod(paymentIntentId, paymentMethodId)
    const qrImageUrl = attachResponse.data.attributes.next_action?.code?.image_url

    if (!qrImageUrl) {
      throw new Error('No QR code image received from PayMongo')
    }

    await prisma.paymentIntentMap.upsert({
      where: { paymentIntentId },
      create: {
        paymentIntentId,
        provider: PaymentProvider.paymongo,
        status: paymentIntentStatus,
        deviceId,
        clientId: resolvedContext.clientId,
        clientPaymentConfigId: resolvedContext.paymongo.configId,
      },
      update: {
        status: attachResponse.data.attributes.status,
        clientPaymentConfigId: resolvedContext.paymongo.configId,
      },
    })

    return NextResponse.json({
      success: true,
      paymentIntentId,
      qrImageUrl,
      status: attachResponse.data.attributes.status,
      baseAmount,
      paymentFee,
      totalAmount,
      feeRatePercent: roundCurrency(feeRate * 100),
    })
  } catch (error) {
    console.error('Payment creation failed:', error)
    return NextResponse.json({ success: false, error: 'Failed to create payment' }, { status: 500 })
  }
}
