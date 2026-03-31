import { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import prisma from '@/lib/prisma'

export const dynamic = 'force-dynamic'

/**
 * GET /api/device/[deviceId]/stream
 *
 * Proxies the MJPEG live stream from the paired CAM module.
 * Requires session auth and device ownership.
 * The browser can use this URL directly in an <img> tag.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { deviceId } = await params

  const device = await prisma.device.findUnique({
    where: { deviceId },
    select: { camIp: true, camSynced: true, pairedBy: true },
  })

  if (!device || device.pairedBy !== session.user.id) {
    return new Response('Device not found', { status: 404 })
  }

  if (!device.camIp) {
    return new Response('CAM IP unavailable — pair the camera first', { status: 503 })
  }

  // Single AbortController shared by connect timeout AND client disconnect.
  // This ensures the upstream CAM connection is closed if the browser tab closes,
  // preventing a resource leak where the CAM keeps streaming to nobody.
  const controller = new AbortController()
  const connectTimeout = setTimeout(() => controller.abort(), 6000)
  request.signal.addEventListener('abort', () => controller.abort())

  try {
    const upstream = await fetch(`http://${device.camIp}/stream`, {
      signal: controller.signal,
    })

    clearTimeout(connectTimeout) // connected — don't cut the stream

    if (!upstream.ok || !upstream.body) {
      return new Response('CAM stream unavailable', { status: 502 })
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'multipart/x-mixed-replace; boundary=frameboundary',
        'Cache-Control': 'no-cache, no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (err) {
    clearTimeout(connectTimeout)
    console.error(`[Stream] CAM unreachable for ${deviceId}:`, err)
    return new Response('CAM unreachable', { status: 502 })
  }
}
