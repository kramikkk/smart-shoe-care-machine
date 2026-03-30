import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const authResult = await requireAuth(req)
  if (authResult instanceof NextResponse) return authResult

  const { deviceId } = await params

  const device = await prisma.device.findFirst({
    where: { deviceId, pairedBy: authResult.user.id, paired: true },
  })
  if (!device) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const result = await prisma.deviceAlert.updateMany({
    where: { deviceId, readAt: null },
    data: { readAt: new Date() },
  })

  return NextResponse.json({ updated: result.count })
}
