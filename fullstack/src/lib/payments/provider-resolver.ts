import { PaymentConnectionStatus, PaymentProvider } from '@/generated/prisma'
import prisma from '@/lib/prisma'
import { decryptPaymentCredential } from '@/lib/payments/crypto'

export type PayMongoAuthType = 'basic' | 'bearer'

export type ResolvedPayMongoCredentials = {
  authType: PayMongoAuthType
  token: string
  webhookSecret?: string
  source: 'manual'
  configId?: string
}

export type ResolvedPaymentContext = {
  clientId: string
  deviceId: string
  paymongo: ResolvedPayMongoCredentials
}

export async function resolvePaymentContextByDevice(deviceId: string): Promise<ResolvedPaymentContext> {
  const device = await prisma.device.findUnique({
    where: { deviceId },
    select: { pairedBy: true },
  })

  if (!device?.pairedBy) {
    throw new Error(`Device ${deviceId} is not paired to a client`)
  }

  const clientId = device.pairedBy
  const config = await prisma.clientPaymentConfig.findUnique({
    where: {
      clientId_provider: {
        clientId,
        provider: PaymentProvider.paymongo,
      },
    },
  })

  if (!config || config.status !== PaymentConnectionStatus.connected) {
    throw new Error(`No connected payment configuration found for device ${deviceId}`)
  }

  if (config.manualSecretKeyEnc) {
    return {
      clientId,
      deviceId,
      paymongo: {
        authType: 'basic',
        token: decryptPaymentCredential(config.manualSecretKeyEnc),
        webhookSecret: config.manualWebhookSecretEnc
          ? decryptPaymentCredential(config.manualWebhookSecretEnc)
          : undefined,
        source: 'manual',
        configId: config.id,
      },
    }
  }

  throw new Error(`Missing manual payment secret for device ${deviceId}`)
}

export async function resolveWebhookSecretForPaymentIntent(paymentIntentId: string): Promise<string | null> {
  const intentMap = await prisma.paymentIntentMap.findUnique({
    where: { paymentIntentId },
    select: { clientId: true },
  })

  if (!intentMap?.clientId) return null

  const config = await prisma.clientPaymentConfig.findUnique({
    where: {
      clientId_provider: {
        clientId: intentMap.clientId,
        provider: PaymentProvider.paymongo,
      },
    },
    select: { manualWebhookSecretEnc: true },
  })

  if (config?.manualWebhookSecretEnc) {
    return decryptPaymentCredential(config.manualWebhookSecretEnc)
  }

  return null
}
