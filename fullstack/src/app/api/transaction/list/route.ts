import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'
import { z } from 'zod'

// Query parameter validation schema
const TransactionListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  paymentMethod: z.enum(['Cash', 'Online']).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  deviceId: z.string().optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'INTERRUPTED', 'ABANDONED']).optional(),
})

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

    // Parse and validate query parameters
    const searchParams = Object.fromEntries(req.nextUrl.searchParams)
    const validation = TransactionListQuerySchema.safeParse(searchParams)

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid query parameters',
          details: validation.error.issues
        },
        { status: 400 }
      )
    }

    const { page, limit, paymentMethod, startDate, endDate, deviceId, status } = validation.data

    // Build filter conditions
    const where: any = {}

    if (paymentMethod) {
      where.paymentMethod = paymentMethod
    }

    if (status) {
      where.status = status
    }

    // Enforce device ownership
    if (deviceId) {
      if (!userDeviceIds.includes(deviceId)) {
        return NextResponse.json(
          { success: false, error: 'You do not have access to this device' },
          { status: 403 }
        )
      }
      where.deviceId = deviceId
    } else {
      where.deviceId = { in: userDeviceIds }
    }

    if (startDate || endDate) {
      where.dateTime = {}
      if (startDate) {
        where.dateTime.gte = startDate
      }
      if (endDate) {
        where.dateTime.lte = endDate
      }
    }

    // Calculate pagination
    const skip = (page - 1) * limit

    // Fetch transactions with pagination and filters
    const [transactions, totalCount] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: {
          dateTime: 'desc',
        },
        skip,
        take: limit,
      }),
      prisma.transaction.count({ where })
    ])

    const totalPages = Math.ceil(totalCount / limit)

    return NextResponse.json({
      success: true,
      transactions,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasMore: page < totalPages,
      },
    })
  } catch (error) {
    console.error('Error fetching transactions:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch transactions',
      },
      { status: 500 }
    )
  }
}
