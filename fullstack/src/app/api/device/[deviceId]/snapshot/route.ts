import { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import prisma from '@/lib/prisma'

export const dynamic = 'force-dynamic'

/**
 * GET /api/device/[deviceId]/snapshot
 *
 * Returns a single JPEG snapshot from the paired CAM module.
 * Requires session auth and device ownership.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { deviceId } = await params

  const device = await prisma.device.findUnique({
    where: { deviceId },
    select: { camIp: true, pairedBy: true },
  })

  if (!device || device.pairedBy !== session.user.id) {
    return new Response('Device not found', { status: 404 })
  }

  if (!device.camIp) {
    return new Response('CAM IP unavailable', { status: 503 })
  }

  try {
    const upstream = await fetch(`http://${device.camIp}/snapshot`, {
      signal: AbortSignal.timeout(8000),
    })

    if (!upstream.ok || !upstream.body) {
      return new Response('Snapshot unavailable', { status: 502 })
    }

    const buf = await upstream.arrayBuffer()

    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, no-store',
        'Content-Disposition': `inline; filename="snapshot-${deviceId}-${Date.now()}.jpg"`,
      },
    })
  } catch (err) {
    console.error(`[Snapshot] CAM unreachable for ${deviceId}:`, err)
    return new Response('CAM unreachable', { status: 502 })
  }
}
