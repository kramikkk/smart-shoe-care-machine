import { NextRequest, NextResponse } from 'next/server'
import { PaymentConnectionStatus, PaymentMode, PaymentOnboardingType, PaymentProvider } from '@/generated/prisma'
import { requireAuth } from '@/lib/auth-middleware'
import { encryptPaymentCredential } from '@/lib/payments/crypto'
import prisma from '@/lib/prisma'
import { z } from 'zod'

const ManualConfigSchema = z.object({
  mode: z.enum(['test', 'live']).default('live'),
  secretKey: z.string().min(1, 'Secret key is required'),
  webhookSecret: z.string().min(1, 'Webhook secret is required'),
  providerAccountId: z.string().optional(),
})

const ToggleSchema = z.object({
  enabled: z.boolean(),
})

function forbidden() {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request)
  if (authResult instanceof NextResponse) return authResult
  if (authResult.user.role !== 'client') return forbidden()

  const config = await prisma.clientPaymentConfig.findUnique({
    where: {
      clientId_provider: {
        clientId: authResult.user.id,
        provider: PaymentProvider.paymongo,
      },
    },
    select: {
      provider: true,
      mode: true,
      onboardingType: true,
      status: true,
      providerAccountId: true,
      lastValidatedAt: true,
      lastWebhookAt: true,
      createdAt: true,
      updatedAt: true,
      manualSecretKeyEnc: true,
      manualWebhookSecretEnc: true,
    },
  })

  return NextResponse.json({
    success: true,
    config: config
      ? {
          provider: config.provider,
          mode: config.mode,
          onboardingType: config.onboardingType,
          status: config.status,
          providerAccountId: config.providerAccountId,
          hasManualSecretKey: Boolean(config.manualSecretKeyEnc),
          hasManualWebhookSecret: Boolean(config.manualWebhookSecretEnc),
          lastValidatedAt: config.lastValidatedAt,
          lastWebhookAt: config.lastWebhookAt,
          createdAt: config.createdAt,
          updatedAt: config.updatedAt,
        }
      : null,
  })
}

export async function PUT(request: NextRequest) {
  const authResult = await requireAuth(request)
  if (authResult instanceof NextResponse) return authResult
  if (authResult.user.role !== 'client') return forbidden()

  try {
    const body = await request.json()
    const parsed = ManualConfigSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid payload', details: parsed.error.issues },
        { status: 400 }
      )
    }

    const { mode, secretKey, webhookSecret, providerAccountId } = parsed.data

    const config = await prisma.clientPaymentConfig.upsert({
      where: {
        clientId_provider: {
          clientId: authResult.user.id,
          provider: PaymentProvider.paymongo,
        },
      },
      create: {
        clientId: authResult.user.id,
        provider: PaymentProvider.paymongo,
        onboardingType: PaymentOnboardingType.manual,
        status: PaymentConnectionStatus.connected,
        mode: mode === 'test' ? PaymentMode.test : PaymentMode.live,
        providerAccountId,
        manualSecretKeyEnc: encryptPaymentCredential(secretKey),
        manualWebhookSecretEnc: encryptPaymentCredential(webhookSecret),
        lastValidatedAt: new Date(),
      },
      update: {
        onboardingType: PaymentOnboardingType.manual,
        status: PaymentConnectionStatus.connected,
        mode: mode === 'test' ? PaymentMode.test : PaymentMode.live,
        providerAccountId,
        manualSecretKeyEnc: encryptPaymentCredential(secretKey),
        manualWebhookSecretEnc: encryptPaymentCredential(webhookSecret),
        lastValidatedAt: new Date(),
      },
    })

    return NextResponse.json({
      success: true,
      config: {
        provider: config.provider,
        onboardingType: config.onboardingType,
        status: config.status,
        mode: config.mode,
        providerAccountId: config.providerAccountId,
        lastValidatedAt: config.lastValidatedAt,
      },
    })
  } catch (error) {
    console.error('[PaymentConfig] Failed to save manual credentials:', error)
    return NextResponse.json({ success: false, error: 'Failed to save payment config' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const authResult = await requireAuth(request)
  if (authResult instanceof NextResponse) return authResult
  if (authResult.user.role !== 'client') return forbidden()

  try {
    const body = await request.json()
    const parsed = ToggleSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid payload', details: parsed.error.issues },
        { status: 400 }
      )
    }

    const { enabled } = parsed.data
    const existing = await prisma.clientPaymentConfig.findUnique({
      where: {
        clientId_provider: {
          clientId: authResult.user.id,
          provider: PaymentProvider.paymongo,
        },
      },
      select: {
        id: true,
        manualSecretKeyEnc: true,
        manualWebhookSecretEnc: true,
      },
    })

    if (!existing) {
      return NextResponse.json({ success: false, error: 'Payment credentials are not configured yet' }, { status: 400 })
    }

    if (enabled && (!existing.manualSecretKeyEnc || !existing.manualWebhookSecretEnc)) {
      return NextResponse.json(
        { success: false, error: 'Save both secret key and webhook secret before enabling payments' },
        { status: 400 }
      )
    }

    const updated = await prisma.clientPaymentConfig.update({
      where: { id: existing.id },
      data: {
        status: enabled ? PaymentConnectionStatus.connected : PaymentConnectionStatus.disabled,
      },
      select: { status: true },
    })

    return NextResponse.json({ success: true, status: updated.status })
  } catch (error) {
    console.error('[PaymentConfig] Failed to toggle payment status:', error)
    return NextResponse.json({ success: false, error: 'Failed to update payment status' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const authResult = await requireAuth(request)
  if (authResult instanceof NextResponse) return authResult
  if (authResult.user.role !== 'client') return forbidden()

  try {
    const existing = await prisma.clientPaymentConfig.findUnique({
      where: {
        clientId_provider: {
          clientId: authResult.user.id,
          provider: PaymentProvider.paymongo,
        },
      },
      select: { id: true },
    })

    if (!existing) {
      return NextResponse.json({ success: true })
    }

    await prisma.clientPaymentConfig.update({
      where: { id: existing.id },
      data: {
        status: PaymentConnectionStatus.pending,
        manualSecretKeyEnc: null,
        manualWebhookSecretEnc: null,
        lastValidatedAt: null,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[PaymentConfig] Failed to reset payment credentials:', error)
    return NextResponse.json({ success: false, error: 'Failed to reset payment credentials' }, { status: 500 })
  }
}
