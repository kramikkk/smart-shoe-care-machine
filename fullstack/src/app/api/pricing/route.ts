import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'
import { z } from 'zod'

const SERVICE_TYPES = ['cleaning', 'drying', 'sterilizing', 'package'] as const

// Package has a single fixed 'auto' care type; other services have three tiers
const CARE_TYPES_BY_SERVICE: Record<string, readonly string[]> = {
  cleaning:    ['gentle', 'normal', 'strong'],
  drying:      ['gentle', 'normal', 'strong'],
  sterilizing: ['gentle', 'normal', 'strong'],
  package:     ['auto'],
}

const PricingUpdateSchema = z.object({
  serviceType: z.enum(SERVICE_TYPES),
  careType: z.enum(['gentle', 'normal', 'strong', 'auto']),
  price: z.number().nonnegative('Price must be a non-negative number').max(10000).nullable(),
  deviceId: z.string().optional(),
}).refine(
  ({ serviceType, careType }) => CARE_TYPES_BY_SERVICE[serviceType]?.includes(careType),
  { message: 'Invalid careType for the given serviceType' }
)

// Default prices
const PRICE_DEFAULTS: Record<string, Record<string, number>> = {
  cleaning:    { gentle: 40, normal: 45, strong: 50 },
  drying:      { gentle: 20, normal: 25, strong: 30 },
  sterilizing: { gentle: 20, normal: 25, strong: 30 },
  package:     { auto: 100 },
}

async function getOrSeedGlobalPricing() {
  // Always ensure all expected global rows exist — skipDuplicates handles re-runs safely.
  // This also self-heals if care types change (e.g., package moved from gentle/normal/strong → auto).
  const rows = SERVICE_TYPES.flatMap(serviceType =>
    CARE_TYPES_BY_SERVICE[serviceType].map(careType => ({
      serviceType,
      careType,
      price: PRICE_DEFAULTS[serviceType][careType],
      deviceId: null,
    }))
  )
  await prisma.servicePricing.createMany({ data: rows, skipDuplicates: true })
  return prisma.servicePricing.findMany({ where: { deviceId: null } })
}

// GET - Fetch service pricing for a specific device (public endpoint)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const deviceId = searchParams.get('deviceId')

    const [devicePricing, globalPricing] = await Promise.all([
      deviceId
        ? prisma.servicePricing.findMany({ where: { deviceId } })
        : Promise.resolve([]),
      getOrSeedGlobalPricing(),
    ])

    // Build full matrix: device-specific overrides global
    const pricing = SERVICE_TYPES.flatMap(serviceType =>
      CARE_TYPES_BY_SERVICE[serviceType].map(careType => {
        const deviceEntry = devicePricing.find(
          p => p.serviceType === serviceType && p.careType === careType
        )
        const globalEntry = globalPricing.find(
          p => p.serviceType === serviceType && p.careType === careType
        )
        return deviceEntry ?? globalEntry
      })
    ).filter(Boolean)

    return NextResponse.json({ success: true, pricing })
  } catch (error) {
    console.error('Error fetching pricing:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch pricing' }, { status: 500 })
  }
}

// PUT - Update service pricing for a specific device (requires authentication)
export async function PUT(req: NextRequest) {
  try {
    const authResult = await requireAuth(req)
    if (authResult instanceof NextResponse) return authResult

    const body = await req.json()
    const validation = PricingUpdateSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid input', details: validation.error.issues },
        { status: 400 }
      )
    }

    const { serviceType, careType, price, deviceId } = validation.data
    const targetDeviceId = deviceId || null

    // Verify device ownership
    if (targetDeviceId) {
      const device = await prisma.device.findUnique({
        where: { deviceId: targetDeviceId },
        select: { pairedBy: true },
      })
      if (!device) {
        return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
      }
      if (device.pairedBy !== authResult.user.id) {
        return NextResponse.json(
          { success: false, error: 'You do not have permission to edit pricing for this device' },
          { status: 403 }
        )
      }
    }

    let updatedPricing
    if (targetDeviceId !== null) {
      updatedPricing = await prisma.servicePricing.upsert({
        where: { deviceId_serviceType_careType: { deviceId: targetDeviceId, serviceType, careType } },
        update: { price },
        create: { serviceType, careType, price, deviceId: targetDeviceId },
      })
    } else {
      const existing = await prisma.servicePricing.findFirst({
        where: { deviceId: null, serviceType, careType },
      })
      updatedPricing = existing
        ? await prisma.servicePricing.update({ where: { id: existing.id }, data: { price } })
        : await prisma.servicePricing.create({ data: { serviceType, careType, price, deviceId: null } })
    }

    return NextResponse.json({ success: true, pricing: updatedPricing })
  } catch (error) {
    console.error('Error updating pricing:', error)
    return NextResponse.json({ success: false, error: 'Failed to update pricing' }, { status: 500 })
  }
}
