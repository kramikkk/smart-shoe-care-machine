import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { z } from 'zod'
import { rateLimit } from '@/lib/rate-limit'

const TransactionSchema = z.object({
  paymentMethod: z.enum(['Cash', 'Online']),
  serviceType: z.enum(['Cleaning', 'Drying', 'Sterilizing', 'Package']),
  shoeType: z.enum(['Canvas', 'Rubber', 'Mesh']),
  careType: z.enum(['Gentle', 'Normal', 'Strong', 'Auto']),
  deviceId: z.string().regex(/^SSCM-[A-F0-9]{6}$/, 'Device ID must be in format SSCM-XXXXXX'),
  amountPaid: z.number().positive().optional(),
})

/**
 * POST /api/transaction/create
 * Creates a transaction record for cash payments.
 * Online payments are created via the webhook handler.
 * Requires X-Group-Token header matching the device's groupToken.
 */
export async function POST(req: NextRequest) {
  const rateLimitResult = rateLimit(req, { maxRequests: 30, windowMs: 60000 })
  if (rateLimitResult) return rateLimitResult

  const groupToken = req.headers.get('X-Group-Token')
  if (!groupToken) {
    return NextResponse.json({ success: false, error: 'Missing X-Group-Token' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const validation = TransactionSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid input', details: validation.error.issues },
        { status: 400 }
      )
    }

    const { paymentMethod, serviceType, shoeType, careType, deviceId, amountPaid } = validation.data

    // Verify device exists, is paired, and group token matches
    const device = await prisma.device.findUnique({
      where: { deviceId },
      select: { paired: true, groupToken: true },
    })

    if (!device || !device.paired) {
      return NextResponse.json({ success: false, error: 'Device not found or not paired' }, { status: 404 })
    }

    if (device.groupToken !== groupToken) {
      return NextResponse.json({ success: false, error: 'Invalid group token' }, { status: 403 })
    }

    // Fetch device-specific pricing, fall back to global.
    // If device-specific row exists but price is null (use hardware default),
    // fall through to global pricing which should have a configured price.
    let pricing = await prisma.servicePricing.findFirst({
      where: { deviceId, serviceType: serviceType.toLowerCase() },
    })
    if (!pricing || pricing.price === null) {
      pricing = await prisma.servicePricing.findFirst({
        where: { deviceId: null, serviceType: serviceType.toLowerCase() },
      })
    }
    if (!pricing || pricing.price === null) {
      return NextResponse.json(
        { success: false, error: `No pricing configured for service type: ${serviceType}` },
        { status: 400 }
      )
    }

    const amount = pricing.price

    const transaction = await prisma.transaction.create({
      data: {
        dateTime: new Date(),
        paymentMethod,
        serviceType,
        shoeType,
        careType,
        amount,
        amountPaid: amountPaid ?? null,
        deviceId,
        status: 'ACTIVE',
      },
    })

    console.log(`[Transaction] Cash transaction created — id: ${transaction.id}, device: ${deviceId}, service: ${serviceType}, amount: ₱${amount}`)
    return NextResponse.json({
      success: true,
      transaction: { id: transaction.id, dateTime: transaction.dateTime },
    })
  } catch (error) {
    console.error('Transaction creation error:', error)
    return NextResponse.json({ success: false, error: 'Failed to create transaction' }, { status: 500 })
  }
}
