import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'

const PHT_OFFSET_MS = 8 * 60 * 60 * 1000

function toPHT(date: Date) {
  return new Date(date.getTime() + PHT_OFFSET_MS)
}

function getGroupKey(date: Date, granularity: string): string {
  const pht = toPHT(date)
  const y = pht.getUTCFullYear()
  const m = String(pht.getUTCMonth() + 1).padStart(2, '0')
  const d = String(pht.getUTCDate()).padStart(2, '0')
  const h = String(pht.getUTCHours()).padStart(2, '0')
  if (granularity === 'hour') return `${y}-${m}-${d}T${h}`
  if (granularity === 'month') return `${y}-${m}`
  return `${y}-${m}-${d}`
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
    const granularity = searchParams.get('granularity') || 'day' // 'hour' | 'day' | 'month'

    const now = new Date()
    const nowPHT = toPHT(now)

    // PHT-aware start date per granularity
    let startDate: Date
    if (granularity === 'hour') {
      // Midnight of today in PHT
      startDate = new Date(
        Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth(), nowPHT.getUTCDate()) - PHT_OFFSET_MS
      )
    } else if (granularity === 'month') {
      // 12 months back from current PHT month
      startDate = new Date(
        Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth() - 11, 1) - PHT_OFFSET_MS
      )
    } else {
      // Use days param for day granularity
      const days = parseInt(searchParams.get('days') || '7')
      startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    }

    const whereClause: any = {
      dateTime: { gte: startDate, lte: now }
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

    const transactions = await prisma.transaction.findMany({
      where: whereClause,
      orderBy: { dateTime: 'asc' }
    })

    // Group by granularity
    const grouped = transactions.reduce((acc, tx) => {
      const key = getGroupKey(new Date(tx.dateTime), granularity)
      if (!acc[key]) acc[key] = { date: key, revenue: 0, transactions: 0 }
      acc[key].revenue += tx.amount
      acc[key].transactions += 1
      return acc
    }, {} as Record<string, { date: string; revenue: number; transactions: number }>)

    // Fill missing slots
    const chartData: { date: string; revenue: number; transactions: number }[] = []

    if (granularity === 'hour') {
      // 24 slots for today in PHT
      const phtStart = toPHT(startDate)
      const y = phtStart.getUTCFullYear()
      const mo = String(phtStart.getUTCMonth() + 1).padStart(2, '0')
      const d = String(phtStart.getUTCDate()).padStart(2, '0')
      for (let h = 0; h < 24; h++) {
        const key = `${y}-${mo}-${d}T${String(h).padStart(2, '0')}`
        chartData.push(grouped[key] || { date: key, revenue: 0, transactions: 0 })
      }
    } else if (granularity === 'month') {
      // 12 months
      for (let i = 0; i <= 11; i++) {
        const d = new Date(Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth() - 11 + i, 1))
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
        chartData.push(grouped[key] || { date: key, revenue: 0, transactions: 0 })
      }
    } else {
      // Daily — iterate from startDate to now
      const current = new Date(startDate)
      while (current <= now) {
        const key = getGroupKey(current, 'day')
        chartData.push(grouped[key] || { date: key, revenue: 0, transactions: 0 })
        current.setDate(current.getDate() + 1)
      }
    }

    return NextResponse.json({
      success: true,
      chartData,
      granularity,
    })
  } catch (error) {
    console.error('Error fetching chart data:', error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
