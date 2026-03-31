import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'

export async function GET(req: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireAuth(req)
    if (authResult instanceof NextResponse) {
      return authResult
    }

    // Get user's devices for ownership check
    const userDevices = await prisma.device.findMany({
      where: { pairedBy: authResult.user.id },
      select: { deviceId: true }
    })
    const userDeviceIds = userDevices.map(d => d.deviceId)

    // Get device filter, distribution type, and optional date range from query params
    const { searchParams } = new URL(req.url)
    const deviceId = searchParams.get('deviceId')
    const type = searchParams.get('type') || 'service'
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    // Build where clause with device ownership enforcement
    const whereClause: any = {}
    if (startDate && endDate) {
      const start = new Date(startDate)
      const end = new Date(endDate)
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return NextResponse.json({ success: false, error: 'Invalid date range' }, { status: 400 })
      }
      whereClause.dateTime = { gte: start, lte: end }
    }
    if (deviceId) {
      if (!userDeviceIds.includes(deviceId)) {
        return NextResponse.json(
          { success: false, error: 'You do not have access to this device' },
          { status: 403 }
        )
      }
      whereClause.deviceId = deviceId
    } else {
      whereClause.deviceId = { in: userDeviceIds }
    }

    // Fetch transactions with optional device filter — cap at 10k rows to avoid OOM
    const transactions = await prisma.transaction.findMany({
      where: whereClause,
      take: 10000,
    })

    // Determine which field to group by based on type
    const getGroupKey = (tx: any) => {
      switch (type) {
        case 'shoe':
          return tx.shoeType.toLowerCase()
        case 'care':
          return tx.careType.toLowerCase()
        case 'service':
        default:
          return tx.serviceType.toLowerCase()
      }
    }

    // Group by the selected type and calculate totals
    const distribution = transactions.reduce((acc, tx) => {
      const key = getGroupKey(tx)
      if (!acc[key]) {
        acc[key] = {
          type: key,
          service: 0,
          revenue: 0,
        }
      }
      acc[key].service += 1
      acc[key].revenue += tx.amount
      return acc
    }, {} as Record<string, { type: string; service: number; revenue: number }>)

    // Convert to array
    const serviceData = Object.values(distribution).map((item) => ({
      ...item,
      fill: `var(--color-${item.type})`,
    }))

    return NextResponse.json({
      success: true,
      serviceData,
      total: {
        transactions: transactions.length,
        revenue: transactions.reduce((sum, tx) => sum + tx.amount, 0),
      },
    })
  } catch (error) {
    console.error('Error fetching distribution:', error)
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
