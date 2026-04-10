import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { normalizeCamHost } from '@/lib/device-cam'

export const dynamic = 'force-dynamic'

/**
 * GET /api/device/[deviceId]/camera-meta
 *
 * Camera pairing / LAN info for the client dashboard (no image bytes).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { deviceId } = await params

  const device = await prisma.device.findUnique({
    where: { deviceId },
    select: {
      deviceId: true,
      camDeviceId: true,
      camIp: true,
      camSynced: true,
      pairedBy: true,
    },
  })

  if (!device || device.pairedBy !== session.user.id) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 })
  }

  const normalized = device.camIp ? normalizeCamHost(device.camIp) : ''
  const camHost = normalized.length > 0 ? normalized : null
  const hasCamEndpoint = camHost !== null

  return NextResponse.json({
    deviceId: device.deviceId,
    camDeviceId: device.camDeviceId,
    camIpStored: device.camIp,
    camHost,
    camSynced: device.camSynced,
    hasCamEndpoint,
    directStreamUrl: hasCamEndpoint ? `http://${camHost}/stream` : null,
    directSnapshotUrl: hasCamEndpoint ? `http://${camHost}/snapshot` : null,
  })
}
