import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { rateLimit } from '@/lib/rate-limit'
import { isDeviceLive } from '@/lib/websocket'

export const dynamic = 'force-dynamic'

/**
 * GET /api/device/[deviceId]/status
 *
 * Called by ESP32/dashboard to check device pairing status and real-time online state.
 * lastSeen is NOT written here — only the WebSocket disconnect handlers update it
 * so it accurately reflects when the device was last connected, not when it was last polled.
 *
 * Returns device pairing status
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  // Apply rate limiting (30 requests per minute per IP)
  const rateLimitResult = rateLimit(request, { maxRequests: 30, windowMs: 60000 })
  if (rateLimitResult) return rateLimitResult

  try {
    const { deviceId } = await params

    if (!deviceId) {
      return NextResponse.json(
        { error: 'Device ID is required' },
        { status: 400 }
      )
    }

    // Find device (don't auto-create to prevent ghost devices)
    const device = await prisma.device.findUnique({
      where: { deviceId },
      select: { deviceId: true, paired: true, pairedAt: true, pairingCode: true, groupToken: true },
    })

    if (!device) {
      // Device doesn't exist - return 404
      // Only /api/device/register should create devices
      return NextResponse.json(
        { error: 'Device not found. Please register via /api/device/register first.' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      paired: device.paired,
      deviceId: device.deviceId,
      pairedAt: device.pairedAt,
      pairingCode: device.paired ? null : device.pairingCode,
      groupToken: device.paired ? device.groupToken : null,
      online: isDeviceLive(deviceId),
    })
  } catch (error) {
    console.error('Device status check error:', error)
    return NextResponse.json(
      { error: 'Failed to check device status' },
      { status: 500 }
    )
  }
}
