import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { z } from 'zod'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const DeviceStatusSchema = z.object({
  deviceId: z.string().regex(/^SSCM-[A-F0-9]{6}$/, 'Invalid device ID format'),
})

/**
 * POST /api/device/status
 *
 * Updates the lastSeen timestamp for an already-paired device
 * This allows the device to maintain its online status
 */
export async function POST(request: NextRequest) {
  const rateLimitResult = rateLimit(request, { maxRequests: 30, windowMs: 60000 })
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json()
    const validatedData = DeviceStatusSchema.parse(body)
    const { deviceId } = validatedData

    // Check if device exists and is paired
    const device = await prisma.device.findUnique({
      where: { deviceId }
    })

    if (!device) {
      return NextResponse.json(
        { error: 'Device not found' },
        { status: 404 }
      )
    }

    if (!device.paired) {
      return NextResponse.json(
        { error: 'Device is not paired' },
        { status: 400 }
      )
    }

    // Update lastSeen timestamp
    await prisma.device.update({
      where: { deviceId },
      data: { lastSeen: new Date() }
    })

    return NextResponse.json({
      success: true,
      message: 'Device status updated',
      deviceId
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.issues },
        { status: 400 }
      )
    }

    console.error('Error updating device status:', error)
    return NextResponse.json(
      { error: 'Failed to update device status' },
      { status: 500 }
    )
  }
}
