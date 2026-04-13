import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth, requireAdminAuth } from '@/lib/auth-middleware'
import { z } from 'zod'

const PricingUpdateSchema = z.object({
  serviceType: z.enum(['cleaning', 'drying', 'sterilizing', 'package']),
  price: z.number().nonnegative('Price must be a non-negative number').max(10000).nullable(),
  deviceId: z.string().optional(),
})

// GET - Fetch service pricing for specific device (public endpoint)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const deviceId = searchParams.get('deviceId')

    const allServiceTypes = ['cleaning', 'drying', 'sterilizing', 'package']

    // Fetch device-specific pricing if deviceId provided
    const deviceSpecificPricing = deviceId
      ? await prisma.servicePricing.findMany({
          where: { deviceId },
          orderBy: { serviceType: 'asc' },
        })
      : []

    // Fetch global defaults
    let globalPricing = await prisma.servicePricing.findMany({
      where: { deviceId: null },
      orderBy: { serviceType: 'asc' },
    })

    // If no global pricing exists, create it
    if (globalPricing.length === 0) {
      const defaultPricing = [
        { serviceType: 'cleaning', price: 45, deviceId: null },
        { serviceType: 'drying', price: 45, deviceId: null },
        { serviceType: 'sterilizing', price: 25, deviceId: null },
        { serviceType: 'package', price: 100, deviceId: null },
      ]

      await prisma.servicePricing.createMany({
        data: defaultPricing,
        skipDuplicates: true,
      })

      globalPricing = await prisma.servicePricing.findMany({
        where: { deviceId: null },
        orderBy: { serviceType: 'asc' },
      })
    }

    // Build final pricing: use device-specific if exists, otherwise use global
    const pricing = allServiceTypes.map(serviceType => {
      const devicePrice = deviceSpecificPricing.find(p => p.serviceType === serviceType)
      const globalPrice = globalPricing.find(p => p.serviceType === serviceType)
      return devicePrice || globalPrice
    }).filter(Boolean) // Remove any undefined entries

    return NextResponse.json({
      success: true,
      pricing,
    })
  } catch (error) {
    console.error('Error fetching pricing:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch pricing',
      },
      { status: 500 }
    )
  }
}

// PUT - Update service pricing for specific device (requires authentication)
export async function PUT(req: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireAuth(req)
    if (authResult instanceof NextResponse) {
      return authResult
    }

    const body = await req.json()

    // Validate input
    const validation = PricingUpdateSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid input',
          details: validation.error.issues
        },
        { status: 400 }
      )
    }

    const { serviceType, price, deviceId } = validation.data
    const targetDeviceId = deviceId || null

    // Global pricing requires admin
    if (!targetDeviceId) {
      const adminResult = await requireAdminAuth(req)
      if (adminResult instanceof NextResponse) return adminResult
    }

    // Verify ownership: User can only edit pricing for devices they own
    if (targetDeviceId) {
      const device = await prisma.device.findUnique({
        where: { deviceId: targetDeviceId },
        select: { pairedBy: true }
      })

      if (!device) {
        return NextResponse.json(
          {
            success: false,
            error: 'Device not found',
          },
          { status: 404 }
        )
      }

      if (device.pairedBy !== authResult.user.id) {
        return NextResponse.json(
          {
            success: false,
            error: 'You do not have permission to edit pricing for this device',
          },
          { status: 403 }
        )
      }
    }

    let updatedPricing
    if (targetDeviceId !== null) {
      // Device-specific pricing — compound unique key is reliable
      updatedPricing = await prisma.servicePricing.upsert({
        where: { deviceId_serviceType: { deviceId: targetDeviceId, serviceType } },
        update: { price },
        create: { serviceType, price, deviceId: targetDeviceId },
      })
    } else {
      // Global pricing (deviceId: null) — PostgreSQL NULLs are not equal in unique constraints,
      // so we must find by id to avoid duplicates
      const existing = await prisma.servicePricing.findFirst({
        where: { deviceId: null, serviceType }
      })
      updatedPricing = existing
        ? await prisma.servicePricing.update({ where: { id: existing.id }, data: { price } })
        : await prisma.servicePricing.create({ data: { serviceType, price, deviceId: null } })
    }

    return NextResponse.json({
      success: true,
      pricing: updatedPricing,
    })
  } catch (error) {
    console.error('Error updating pricing:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update pricing',
      },
      { status: 500 }
    )
  }
}
