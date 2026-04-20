import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'
import { z } from 'zod'

const CARE_TYPES = ['gentle', 'normal', 'strong'] as const

const DEFAULT_TEMPS: Record<string, number> = {
  gentle: 35,
  normal: 40,
  strong: 45,
}

const TempUpdateSchema = z.object({
  careType: z.enum(CARE_TYPES),
  tempC: z.number().min(30).max(50),
  deviceId: z.string().optional(),
})

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const deviceId = searchParams.get('deviceId')

    const deviceTemps = deviceId
      ? await prisma.dryingTemp.findMany({ where: { deviceId } })
      : []

    let globalTemps = await prisma.dryingTemp.findMany({ where: { deviceId: null } })

    if (globalTemps.length === 0) {
      const defaults = CARE_TYPES.map(ct => ({ careType: ct, tempC: DEFAULT_TEMPS[ct], deviceId: null }))
      await prisma.dryingTemp.createMany({ data: defaults })
      globalTemps = await prisma.dryingTemp.findMany({ where: { deviceId: null } })
    }

    type TempRow = { careType: string; tempC: number }
    const temps = CARE_TYPES.map(ct => {
      const deviceEntry = deviceTemps.find((t: TempRow) => t.careType === ct)
      const globalEntry = globalTemps.find((t: TempRow) => t.careType === ct)
      return deviceEntry || globalEntry || { careType: ct, tempC: DEFAULT_TEMPS[ct] }
    })

    return NextResponse.json({ success: true, temps })
  } catch (error) {
    console.error('Error fetching drying temps:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch drying temps' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const authResult = await requireAuth(req)
    if (authResult instanceof NextResponse) return authResult

    const body = await req.json()
    const validation = TempUpdateSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json({ success: false, error: 'Invalid input', details: validation.error.issues }, { status: 400 })
    }

    const { careType, tempC, deviceId } = validation.data
    const targetDeviceId = deviceId || null

    if (targetDeviceId) {
      const device = await prisma.device.findUnique({
        where: { deviceId: targetDeviceId },
        select: { pairedBy: true },
      })
      if (!device) return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
      if (device.pairedBy !== authResult.user.id) {
        return NextResponse.json({ success: false, error: 'No permission to edit drying temps for this device' }, { status: 403 })
      }
    }

    const existing = await prisma.dryingTemp.findFirst({ where: { deviceId: targetDeviceId, careType } })
    const updated = existing
      ? await prisma.dryingTemp.update({ where: { id: existing.id }, data: { tempC } })
      : await prisma.dryingTemp.create({ data: { careType, tempC, deviceId: targetDeviceId } })

    return NextResponse.json({ success: true, temp: updated })
  } catch (error) {
    console.error('Error updating drying temp:', error)
    return NextResponse.json({ success: false, error: 'Failed to update drying temp' }, { status: 500 })
  }
}
