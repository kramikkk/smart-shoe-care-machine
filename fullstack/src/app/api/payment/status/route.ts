import { NextRequest, NextResponse } from 'next/server'
import { PayMongoClient } from '@/lib/paymongo/client'
import prisma from '@/lib/prisma'
import { resolvePaymentContextByDevice } from '@/lib/payments/provider-resolver'
import { z } from 'zod'
import { rateLimit } from '@/lib/rate-limit'

const PaymentStatusQuerySchema = z.object({
  paymentIntentId: z.string().min(1, 'Payment intent ID is required'),
  deviceId: z.string().min(1, 'Device ID is required'),
})

export async function GET(request: NextRequest) {
  const rateLimitResult = rateLimit(request, { maxRequests: 30, windowMs: 60000 })
  if (rateLimitResult) return rateLimitResult

  const groupToken = request.headers.get('X-Group-Token')
  if (!groupToken) {
    return NextResponse.json({ success: false, error: 'Missing X-Group-Token' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const queryParams = Object.fromEntries(searchParams)

    const validation = PaymentStatusQuerySchema.safeParse(queryParams)
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameters', details: validation.error.issues },
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
    const paymentIntent = await client.getPaymentIntentStatus(paymentIntentId)
    const status = paymentIntent.data.attributes.status

    await prisma.paymentIntentMap.updateMany({
      where: { paymentIntentId, clientId: resolvedContext.clientId },
      data: { status },
    })

    return NextResponse.json({
      success: true,
      status,
      paymentIntent: paymentIntent.data,
    })
  } catch (error) {
    console.error('Payment status check error:', error)
    return NextResponse.json({ success: false, error: 'Failed to check payment status' }, { status: 500 })
  }
}
