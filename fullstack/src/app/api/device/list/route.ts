import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { isDeviceLive } from '@/lib/websocket'

export const dynamic = 'force-dynamic'

/**
 * GET /api/device/list
 *
 * List devices paired by the current admin user
 * Includes pairing information and user details
 */
export async function GET() {
  try {
    // Check authentication
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Fetch devices paired by the current user
    const devices = await prisma.device.findMany({
      where: {
        pairedBy: session.user.id
      },
      orderBy: {
        createdAt: 'desc'
      }
    })

    // Add user info to each device
    const devicesWithUser = devices.map(device => ({
      ...device,
      online: isDeviceLive(device.deviceId),
      pairedByUser: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      }
    }))

    return NextResponse.json({
      success: true,
      devices: devicesWithUser
    })
  } catch (error) {
    console.error('Error fetching devices:', error)
    return NextResponse.json(
      { error: 'Failed to fetch devices' },
      { status: 500 }
    )
  }
}
