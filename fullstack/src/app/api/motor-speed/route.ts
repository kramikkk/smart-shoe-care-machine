import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'
import { z } from 'zod'

const CARE_TYPES = ['gentle', 'normal', 'strong'] as const

// PWM values sent to brush motors during cleaning (0–255)
const DEFAULT_SPEEDS: Record<string, number> = {
  gentle: 230, // 90% of 255
  normal: 242, // 95% of 255
  strong: 255, // 100%
}

const SpeedUpdateSchema = z.object({
  careType: z.enum(CARE_TYPES),
  speedPwm: z.number().int().min(0).max(255),
  deviceId: z.string().optional(),
})

// GET - Fetch motor speeds for a device
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const deviceId = searchParams.get('deviceId')

    const deviceSpeeds = deviceId
      ? await prisma.motorSpeed.findMany({ where: { deviceId } })
      : []

    let globalSpeeds = await prisma.motorSpeed.findMany({ where: { deviceId: null } })

    // Seed global defaults if missing
    if (globalSpeeds.length === 0) {
      const defaults = CARE_TYPES.map(ct => ({
        careType: ct,
        speedPwm: DEFAULT_SPEEDS[ct],
        deviceId: null,
      }))
      await prisma.motorSpeed.createMany({ data: defaults })
      globalSpeeds = await prisma.motorSpeed.findMany({ where: { deviceId: null } })
    }

    // Merge: device-specific overrides global
    const speeds = CARE_TYPES.map(ct => {
      const deviceEntry = deviceSpeeds.find(s => s.careType === ct)
      const globalEntry = globalSpeeds.find(s => s.careType === ct)
      return deviceEntry || globalEntry || { careType: ct, speedPwm: DEFAULT_SPEEDS[ct] }
    })

    return NextResponse.json({ success: true, speeds })
  } catch (error) {
    console.error('Error fetching motor speeds:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch motor speeds' }, { status: 500 })
  }
}

// PUT - Update a motor speed for a device
export async function PUT(req: NextRequest) {
  try {
    const authResult = await requireAuth(req)
    if (authResult instanceof NextResponse) return authResult

    const body = await req.json()
    const validation = SpeedUpdateSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json({ success: false, error: 'Invalid input', details: validation.error.issues }, { status: 400 })
    }

    const { careType, speedPwm, deviceId } = validation.data
    const targetDeviceId = deviceId || null

    if (targetDeviceId) {
      const device = await prisma.device.findUnique({
        where: { deviceId: targetDeviceId },
        select: { pairedBy: true },
      })
      if (!device) return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
      if (device.pairedBy !== authResult.user.id) {
        return NextResponse.json({ success: false, error: 'No permission to edit speeds for this device' }, { status: 403 })
      }
    }

    const existing = await prisma.motorSpeed.findFirst({
      where: { deviceId: targetDeviceId, careType },
    })

    const updated = existing
      ? await prisma.motorSpeed.update({ where: { id: existing.id }, data: { speedPwm } })
      : await prisma.motorSpeed.create({ data: { careType, speedPwm, deviceId: targetDeviceId } })

    return NextResponse.json({ success: true, speed: updated })
  } catch (error) {
    console.error('Error updating motor speed:', error)
    return NextResponse.json({ success: false, error: 'Failed to update motor speed' }, { status: 500 })
  }
}
