import { NextRequest, NextResponse } from 'next/server'
import { PaymentConnectionStatus, PaymentProvider } from '@/generated/prisma'
import { Prisma } from '@/generated/prisma'
import prisma from '@/lib/prisma'
import { rateLimit } from '@/lib/rate-limit'
import { z } from 'zod'

const AvailabilityQuerySchema = z.object({
  deviceId: z.string().regex(/^SSCM-[A-F0-9]{6}$/, 'Invalid device ID format'),
})

export async function GET(request: NextRequest) {
  const rateLimitResult = rateLimit(request, { maxRequests: 60, windowMs: 60000 })
  if (rateLimitResult) return rateLimitResult

  const groupToken = request.headers.get('X-Group-Token')
  if (!groupToken) {
    return NextResponse.json({ success: false, error: 'Missing X-Group-Token' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const validation = AvailabilityQuerySchema.safeParse({
      deviceId: searchParams.get('deviceId') || '',
    })
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameters', details: validation.error.issues },
        { status: 400 }
      )
    }

    const { deviceId } = validation.data
    const device = await prisma.device.findUnique({
      where: { deviceId },
      select: { groupToken: true, pairedBy: true },
    })

    if (!device || device.groupToken !== groupToken || !device.pairedBy) {
      return NextResponse.json({ success: false, error: 'Invalid group token' }, { status: 403 })
    }

    const paymentConfig = await prisma.clientPaymentConfig.findUnique({
      where: {
        clientId_provider: {
          clientId: device.pairedBy,
          provider: PaymentProvider.paymongo,
        },
      },
      select: {
        status: true,
        manualSecretKeyEnc: true,
      },
    })

    const hasManualCreds = Boolean(paymentConfig?.manualSecretKeyEnc)
    const isConnected = paymentConfig?.status === PaymentConnectionStatus.connected
    const isExplicitlyDisabled = paymentConfig?.status === PaymentConnectionStatus.disabled
    const onlinePaymentEnabled = Boolean(isConnected && hasManualCreds)

    return NextResponse.json({
      success: true,
      onlinePaymentEnabled,
      reason: onlinePaymentEnabled
        ? null
        : isExplicitlyDisabled
          ? 'Online payment is disabled'
          : 'Online payment is not configured yet',
    })
  } catch (error) {
    // During rollout, some environments may not have the new table yet.
    // Fail-safe to disabled online payment instead of returning 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
      return NextResponse.json({
        success: true,
        onlinePaymentEnabled: false,
        reason: 'Online payment is not configured yet',
      })
    }

    console.error('[PaymentAvailability] Failed to check availability:', error)
    return NextResponse.json({ success: false, error: 'Failed to check payment availability' }, { status: 500 })
  }
}
