import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'
import { z } from 'zod'

const SERVICE_TYPES = ['cleaning', 'drying', 'sterilizing'] as const
const CARE_TYPES = ['gentle', 'normal', 'strong'] as const

const DEFAULT_DURATIONS: Record<string, Record<string, number>> = {
  cleaning: { gentle: 60, normal: 180, strong: 300 },
  drying: { gentle: 60, normal: 180, strong: 300 },
  sterilizing: { gentle: 60, normal: 180, strong: 300 },
}

const DurationUpdateSchema = z.object({
  serviceType: z.enum(SERVICE_TYPES),
  careType: z.enum(CARE_TYPES),
  duration: z.number().int().min(1).max(7200),
  deviceId: z.string().optional(),
})

// GET - Fetch service durations for a device
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const deviceId = searchParams.get('deviceId')

    const deviceDurations = deviceId
      ? await prisma.serviceDuration.findMany({ where: { deviceId } })
      : []

    let globalDurations = await prisma.serviceDuration.findMany({ where: { deviceId: null } })

    // Seed global defaults if missing
    if (globalDurations.length === 0) {
      const defaults = SERVICE_TYPES.flatMap(st =>
        CARE_TYPES.map(ct => ({ serviceType: st, careType: ct, duration: DEFAULT_DURATIONS[st][ct], deviceId: null }))
      )
      await prisma.serviceDuration.createMany({ data: defaults })
      globalDurations = await prisma.serviceDuration.findMany({ where: { deviceId: null } })
    }

    // Merge: device-specific overrides global
    const durations = SERVICE_TYPES.flatMap(st =>
      CARE_TYPES.map(ct => {
        const deviceEntry = deviceDurations.find(d => d.serviceType === st && d.careType === ct)
        const globalEntry = globalDurations.find(d => d.serviceType === st && d.careType === ct)
        return deviceEntry || globalEntry || { serviceType: st, careType: ct, duration: DEFAULT_DURATIONS[st][ct] }
      })
    )

    return NextResponse.json({ success: true, durations })
  } catch (error) {
    console.error('Error fetching durations:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch durations' }, { status: 500 })
  }
}

// PUT - Update a service duration for a device
export async function PUT(req: NextRequest) {
  try {
    const authResult = await requireAuth(req)
    if (authResult instanceof NextResponse) return authResult

    const body = await req.json()
    const validation = DurationUpdateSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json({ success: false, error: 'Invalid input', details: validation.error.issues }, { status: 400 })
    }

    const { serviceType, careType, duration, deviceId } = validation.data
    const targetDeviceId = deviceId || null

    if (targetDeviceId) {
      const device = await prisma.device.findUnique({
        where: { deviceId: targetDeviceId },
        select: { pairedBy: true },
      })
      if (!device) return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
      if (device.pairedBy !== authResult.user.id) {
        return NextResponse.json({ success: false, error: 'No permission to edit durations for this device' }, { status: 403 })
      }
    }

    const existing = await prisma.serviceDuration.findFirst({
      where: { deviceId: targetDeviceId, serviceType, careType },
    })

    const updated = existing
      ? await prisma.serviceDuration.update({ where: { id: existing.id }, data: { duration } })
      : await prisma.serviceDuration.create({ data: { serviceType, careType, duration, deviceId: targetDeviceId } })

    return NextResponse.json({ success: true, duration: updated })
  } catch (error) {
    console.error('Error updating duration:', error)
    return NextResponse.json({ success: false, error: 'Failed to update duration' }, { status: 500 })
  }
}
