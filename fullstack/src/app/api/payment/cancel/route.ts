import { NextRequest, NextResponse } from 'next/server'
import { PayMongoClient } from '@/lib/paymongo/client'
import prisma from '@/lib/prisma'
import { resolvePaymentContextByDevice } from '@/lib/payments/provider-resolver'
import { z } from 'zod'
import { rateLimit } from '@/lib/rate-limit'

const PaymentCancelSchema = z.object({
  paymentIntentId: z.string().min(1, 'Payment intent ID is required'),
  deviceId: z.string().regex(/^SSCM-[A-F0-9]{6}$/, 'Invalid device ID format'),
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
    const validation = PaymentCancelSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid input', details: validation.error.issues },
        { status: 400 }
      )
    }

    const { paymentIntentId, deviceId } = validation.data

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
    const result = await client.cancelPaymentIntent(paymentIntentId)

    await prisma.paymentIntentMap.updateMany({
      where: { paymentIntentId, clientId: resolvedContext.clientId },
      data: { status: result.data.attributes.status },
    })

    return NextResponse.json({
      success: true,
      status: result.data.attributes.status,
      message: 'Payment intent cancelled successfully',
    })
  } catch (error) {
    console.error('Payment cancellation failed:', error)
    return NextResponse.json({ success: false, error: 'Failed to cancel payment' }, { status: 500 })
  }
}
