import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'

// PATCH /api/device/[deviceId]/alerts/resolve
// Body: { alertKeys: string[] }
// Marks all unresolved alerts matching any of these keys as resolved
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

  const { alertKeys } = await req.json() as { alertKeys: string[] }
  if (!Array.isArray(alertKeys) || alertKeys.length === 0) {
    return NextResponse.json({ updated: 0 })
  }

  const result = await prisma.deviceAlert.updateMany({
    where: { deviceId, alertKey: { in: alertKeys }, resolvedAt: null },
    data: { resolvedAt: new Date() },
  })

  return NextResponse.json({ updated: result.count })
}
