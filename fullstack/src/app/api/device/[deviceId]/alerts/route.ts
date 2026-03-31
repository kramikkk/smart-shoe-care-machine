import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireAuth } from '@/lib/auth-middleware'
import { transporter } from '@/lib/mailer'

export const dynamic = 'force-dynamic'

async function verifyOwnership(deviceId: string, userId: string) {
  const device = await prisma.device.findFirst({
    where: { deviceId, pairedBy: userId, paired: true },
  })
  return !!device
}

// GET /api/device/[deviceId]/alerts
// Query params: severity (critical|warning), resolved (true|false, default false)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const authResult = await requireAuth(req)
  if (authResult instanceof NextResponse) return authResult

  const { deviceId } = await params
  const owned = await verifyOwnership(deviceId, authResult.user.id)
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { searchParams } = new URL(req.url)
  const severity = searchParams.get('severity')
  const showResolved = searchParams.get('resolved') === 'true'

  const alerts = await prisma.deviceAlert.findMany({
    where: {
      deviceId,
      ...(severity ? { severity } : {}),
      resolvedAt: showResolved ? { not: null } : null,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return NextResponse.json(alerts)
}

// POST /api/device/[deviceId]/alerts
// Body: { alertKey, severity, title, description }
// Dedup: if unresolved alert with same alertKey exists, return it (no duplicate)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const authResult = await requireAuth(req)
  if (authResult instanceof NextResponse) return authResult

  const { deviceId } = await params
  const owned = await verifyOwnership(deviceId, authResult.user.id)
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: { alertKey?: unknown; severity?: unknown; title?: unknown; description?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const { alertKey, severity, title, description } = body
  if (!alertKey || !severity || !title || !description ||
      typeof alertKey !== 'string' || typeof severity !== 'string' ||
      typeof title !== 'string' || typeof description !== 'string') {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }

  const existing = await prisma.deviceAlert.findFirst({
    where: { deviceId, alertKey, resolvedAt: null },
  })
  if (existing) {
    return NextResponse.json(existing, { status: 200 })
  }

  const alert = await prisma.deviceAlert.create({
    data: { deviceId, alertKey, severity, title, description },
  })

  // Fire-and-forget alert email — never blocks the response
  sendAlertEmail({ userId: authResult.user.id, deviceId, title, description, severity }).catch(
    (err) => console.error('[alerts] Email error:', err)
  )

  return NextResponse.json(alert, { status: 201 })
}

// ---------------------------------------------------------------------------
// Alert email helper
// ---------------------------------------------------------------------------
async function sendAlertEmail({
  userId,
  deviceId,
  title,
  description,
  severity,
}: {
  userId: string
  deviceId: string
  title: string
  description: string
  severity: string
}) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return // mailer not configured — skip silently

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
  if (!user?.email) return

  const severityColor  = severity === 'critical' ? '#dc2626' : severity === 'warning' ? '#d97706' : '#2563eb'
  const severityBg     = severity === 'critical' ? '#fef2f2' : severity === 'warning' ? '#fffbeb' : '#eff6ff'
  const severityBorder = severity === 'critical' ? '#fca5a5' : severity === 'warning' ? '#fcd34d' : '#93c5fd'
  const severityLabel  = severity.charAt(0).toUpperCase() + severity.slice(1)
  const priorityText   = severity === 'critical' ? 'IMMEDIATE ATTENTION REQUIRED' : severity === 'warning' ? 'PROMPT ATTENTION ADVISED' : 'FOR YOUR INFORMATION'

  const timestamp = new Date().toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })

  await transporter.sendMail({
    from: `"SSCM" <${process.env.GMAIL_USER}>`,
    to: user.email,
    subject: `[${severityLabel}] ${title} — Smart Shoe Care Machine`,
    html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e4e4e7;">

      <!-- Header -->
      <tr>
        <td style="background:#18181b;padding:24px 32px;">
          <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:2px;color:#a1a1aa;text-transform:uppercase;">Smart Shoe Care Machine</p>
          <p style="margin:4px 0 0;font-size:11px;color:#52525b;letter-spacing:1px;">Automated Monitoring System</p>
        </td>
      </tr>

      <!-- Severity Banner -->
      <tr>
        <td style="background:${severityBg};border-left:5px solid ${severityColor};border-bottom:1px solid ${severityBorder};padding:16px 32px;">
          <p style="margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:2px;color:${severityColor};text-transform:uppercase;">${severityLabel} Alert &nbsp;·&nbsp; ${priorityText}</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#18181b;line-height:1.3;">${title}</h1>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:32px;">

          <p style="margin:0 0 6px;font-size:14px;color:#3f3f46;">Dear Valued Client,</p>
          <p style="margin:0 0 24px;font-size:14px;color:#52525b;line-height:1.7;">
            This is an automated notification from your Smart Shoe Care Machine monitoring system.
            The following alert condition has been detected and requires your attention.
          </p>

          <!-- Alert Detail Box -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px;">
            <tr>
              <td colspan="2" style="padding:12px 16px;border-bottom:1px solid #e4e4e7;background:#f4f4f5;border-radius:6px 6px 0 0;">
                <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#71717a;text-transform:uppercase;">Alert Details</p>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#71717a;width:160px;vertical-align:top;">Alert Type</td>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#18181b;font-weight:600;">${title}</td>
            </tr>
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#71717a;vertical-align:top;">Severity Level</td>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;">
                <span style="display:inline-block;padding:2px 10px;border-radius:99px;background:${severityBg};color:${severityColor};font-size:12px;font-weight:700;border:1px solid ${severityBorder};">${severityLabel}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#71717a;vertical-align:top;">Description</td>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#3f3f46;line-height:1.6;">${description}</td>
            </tr>
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#71717a;vertical-align:top;">Device ID</td>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#18181b;font-family:monospace;">${deviceId}</td>
            </tr>
            <tr>
              <td style="padding:12px 16px;font-size:13px;color:#71717a;vertical-align:top;">Date &amp; Time</td>
              <td style="padding:12px 16px;font-size:13px;color:#18181b;">${timestamp}</td>
            </tr>
          </table>

          <!-- Recommended Action -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:${severityBg};border:1px solid ${severityBorder};border-radius:6px;margin-bottom:28px;">
            <tr>
              <td style="padding:14px 16px;">
                <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1.5px;color:${severityColor};text-transform:uppercase;">Recommended Action</p>
                <p style="margin:0;font-size:13px;color:#3f3f46;line-height:1.6;">
                  ${severity === 'critical'
                    ? 'Please log in to your dashboard immediately and inspect the affected device. This condition may impact machine operation and service availability.'
                    : severity === 'warning'
                    ? 'Please log in to your dashboard at your earliest convenience to review this condition and take any necessary preventive action.'
                    : 'No immediate action is required. Please review this notice at your convenience.'}
                  Once the underlying issue has been resolved, kindly mark this alert as solved in the System Alerts panel.
                </p>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 4px;font-size:14px;color:#3f3f46;">Sincerely,</p>
          <p style="margin:0;font-size:14px;font-weight:600;color:#18181b;">Smart Shoe Care Machine</p>
          <p style="margin:0;font-size:13px;color:#71717a;">Automated Monitoring System</p>

        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#fafafa;border-top:1px solid #e4e4e7;padding:20px 32px;">
          <p style="margin:0 0 6px;font-size:12px;color:#a1a1aa;line-height:1.6;">
            This is an automated message generated by the Smart Shoe Care Machine monitoring system.
            Please do not reply directly to this email.
          </p>
          <p style="margin:0;font-size:12px;color:#a1a1aa;">
            You are receiving this notification because your account is registered as the owner of device <strong style="color:#71717a;">${deviceId}</strong>.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>
    `,
  })
}
