import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'
import { z } from 'zod'

const CARE_TYPES = ['gentle', 'normal', 'strong'] as const

// Firmware-side steps ÷ STEPPER2_STEPS_PER_MM (200) — gentle 90, normal 95, strong 100 mm
const DEFAULT_DISTANCES: Record<string, number> = {
  gentle: 90,
  normal: 95,
  strong: 100,
}

const DistanceUpdateSchema = z.object({
  careType:   z.enum(CARE_TYPES),
  distanceMm: z.number().int().min(1).max(100),
  deviceId:   z.string().optional(),
})

// GET - Fetch cleaning distances for a device
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const deviceId = searchParams.get('deviceId')

    const deviceDistances = deviceId
      ? await prisma.cleaningDistance.findMany({ where: { deviceId } })
      : []

    let globalDistances = await prisma.cleaningDistance.findMany({ where: { deviceId: null } })

    // Seed global defaults if missing
    if (globalDistances.length === 0) {
      const defaults = CARE_TYPES.map(ct => ({
        careType: ct,
        distanceMm: DEFAULT_DISTANCES[ct],
        deviceId: null,
      }))
      await prisma.cleaningDistance.createMany({ data: defaults })
      globalDistances = await prisma.cleaningDistance.findMany({ where: { deviceId: null } })
    }

    // Merge: device-specific overrides global
    const distances = CARE_TYPES.map(ct => {
      const deviceEntry  = deviceDistances.find(d => d.careType === ct)
      const globalEntry  = globalDistances.find(d => d.careType === ct)
      return deviceEntry || globalEntry || { careType: ct, distanceMm: DEFAULT_DISTANCES[ct] }
    })

    return NextResponse.json({ success: true, distances })
  } catch (error) {
    console.error('Error fetching cleaning distances:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch cleaning distances' }, { status: 500 })
  }
}

// PUT - Update a cleaning distance for a device
export async function PUT(req: NextRequest) {
  try {
    const authResult = await requireAuth(req)
    if (authResult instanceof NextResponse) return authResult

    const body = await req.json()
    const validation = DistanceUpdateSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json({ success: false, error: 'Invalid input', details: validation.error.issues }, { status: 400 })
    }

    const { careType, distanceMm, deviceId } = validation.data
    const targetDeviceId = deviceId || null

    if (targetDeviceId) {
      const device = await prisma.device.findUnique({
        where: { deviceId: targetDeviceId },
        select: { pairedBy: true },
      })
      if (!device) return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
      if (device.pairedBy !== authResult.user.id) {
        return NextResponse.json({ success: false, error: 'No permission to edit distances for this device' }, { status: 403 })
      }
    }

    const existing = await prisma.cleaningDistance.findFirst({
      where: { deviceId: targetDeviceId, careType },
    })

    const updated = existing
      ? await prisma.cleaningDistance.update({ where: { id: existing.id }, data: { distanceMm } })
      : await prisma.cleaningDistance.create({ data: { careType, distanceMm, deviceId: targetDeviceId } })

    return NextResponse.json({ success: true, distance: updated })
  } catch (error) {
    console.error('Error updating cleaning distance:', error)
    return NextResponse.json({ success: false, error: 'Failed to update cleaning distance' }, { status: 500 })
  }
}
