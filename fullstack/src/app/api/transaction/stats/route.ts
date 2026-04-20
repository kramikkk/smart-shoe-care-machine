import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'

const PHT_OFFSET_MS = 8 * 60 * 60 * 1000

function getPHTBoundaries(timeRange: string) {
  const now = new Date()
  const nowPHT = new Date(now.getTime() + PHT_OFFSET_MS)

  // PHT midnight today, expressed as UTC
  const todayMidnightUTC = new Date(
    Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth(), nowPHT.getUTCDate()) - PHT_OFFSET_MS
  )

  let currentStart: Date
  let previousStart: Date
  let previousEnd: Date

  switch (timeRange) {
    case 'week': {
      const dayOfWeek = nowPHT.getUTCDay() // 0=Sun
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      currentStart = new Date(todayMidnightUTC.getTime() - daysFromMonday * 24 * 60 * 60 * 1000)
      previousEnd = currentStart
      previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000)
      break
    }
    case 'month': {
      currentStart = new Date(
        Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth(), 1) - PHT_OFFSET_MS
      )
      previousEnd = currentStart
      previousStart = new Date(
        Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth() - 1, 1) - PHT_OFFSET_MS
      )
      break
    }
    case 'year': {
      currentStart = new Date(
        Date.UTC(nowPHT.getUTCFullYear(), 0, 1) - PHT_OFFSET_MS
      )
      previousEnd = currentStart
      previousStart = new Date(
        Date.UTC(nowPHT.getUTCFullYear() - 1, 0, 1) - PHT_OFFSET_MS
      )
      break
    }
    case 'today':
    default: {
      currentStart = todayMidnightUTC
      previousEnd = currentStart
      previousStart = new Date(todayMidnightUTC.getTime() - 24 * 60 * 60 * 1000)
    }
  }

  return { currentStart, previousStart, previousEnd, now }
}

export async function GET(req: NextRequest) {
  try {
    const authResult = await requireAuth(req)
    if (authResult instanceof NextResponse) return authResult

    const userDevices = await prisma.device.findMany({
      where: { pairedBy: authResult.user.id },
      select: { deviceId: true }
    })
    const userDeviceIds = userDevices.map(d => d.deviceId)

    const { searchParams } = new URL(req.url)
    const deviceId = searchParams.get('deviceId')
    const timeRange = searchParams.get('timeRange') || 'today'

    const deviceWhere: any = {}
    if (deviceId) {
      if (!userDeviceIds.includes(deviceId)) {
        return NextResponse.json(
          { success: false, error: 'You do not have access to this device' },
          { status: 403 }
        )
      }
      deviceWhere.deviceId = deviceId
    } else {
      deviceWhere.deviceId = { in: userDeviceIds }
    }

    const phpFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'PHP' })

    if (timeRange === 'all') {
      const allTxs = await prisma.transaction.findMany({
        where: deviceWhere,
        select: { amount: true },
      })
      const totalRevenue = allTxs.reduce((sum, tx) => sum + tx.amount, 0)
      const totalCount = allTxs.length

      return NextResponse.json({
        success: true,
        stats: {
          totalRevenue: {
            value: totalRevenue,
            formatted: phpFormat.format(totalRevenue),
            trend: null,
            isPositive: null,
            previousValue: null,
            previousFormatted: null,
          },
          totalTransactions: {
            value: totalCount,
            trend: null,
            isPositive: null,
            previousValue: null,
          },
        },
      })
    }

    const { currentStart, previousStart, previousEnd, now } = getPHTBoundaries(timeRange)

    // Fetch only the two comparison periods — no all-time scan needed
    const periodTxs = await prisma.transaction.findMany({
      where: { ...deviceWhere, dateTime: { gte: previousStart, lte: now } },
      select: { dateTime: true, amount: true },
    })

    const currentTxs = periodTxs.filter(
      (tx) => new Date(tx.dateTime) >= currentStart && new Date(tx.dateTime) <= now
    )
    const previousTxs = periodTxs.filter(
      (tx) => new Date(tx.dateTime) >= previousStart && new Date(tx.dateTime) < previousEnd
    )

    const currentRevenue = currentTxs.reduce((sum, tx) => sum + tx.amount, 0)
    const currentCount = currentTxs.length
    const previousRevenue = previousTxs.reduce((sum, tx) => sum + tx.amount, 0)
    const previousCount = previousTxs.length

    // Trend: current period vs previous period.
    // If previous had data but current is 0 → -100% (accurate, footer shows the comparison).
    // If previous was also 0 → 0% (no baseline to compare against).
    const revenueTrend = previousRevenue > 0
      ? (((currentRevenue - previousRevenue) / previousRevenue) * 100).toFixed(1)
      : currentRevenue > 0 ? '100' : '0'
    const transactionTrend = previousCount > 0
      ? (((currentCount - previousCount) / previousCount) * 100).toFixed(1)
      : currentCount > 0 ? '100' : '0'

    return NextResponse.json({
      success: true,
      stats: {
        totalRevenue: {
          value: currentRevenue,
          formatted: phpFormat.format(currentRevenue),
          trend: parseFloat(revenueTrend),
          isPositive: currentRevenue > 0 && currentRevenue >= previousRevenue,
          previousValue: previousRevenue,
          previousFormatted: phpFormat.format(previousRevenue),
        },
        totalTransactions: {
          value: currentCount,
          trend: parseFloat(transactionTrend),
          isPositive: currentCount > 0 && currentCount >= previousCount,
          previousValue: previousCount,
        },
      },
    })
  } catch (error) {
    console.error('Error fetching transaction stats:', error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
