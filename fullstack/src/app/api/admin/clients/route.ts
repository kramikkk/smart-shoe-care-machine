import { NextRequest, NextResponse } from 'next/server'
import { requireAdminAuth } from '@/lib/auth-middleware'
import { auth } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { headers } from 'next/headers'
import { transporter } from '@/lib/mailer'
import { SignJWT } from 'jose'

export async function GET(request: NextRequest) {
  const authResult = await requireAdminAuth(request)
  if (authResult instanceof NextResponse) return authResult

  try {
    const clients = await prisma.user.findMany({
      where: { role: 'client' },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    // Get device counts per client
    const deviceCounts = await prisma.device.groupBy({
      by: ['pairedBy'],
      where: { pairedBy: { in: clients.map((c) => c.id) } },
      _count: { id: true },
    })

    const countMap = new Map(deviceCounts.map((d) => {
      const row = d as unknown as { pairedBy: string | null; _count: { id: number } }
      return [row.pairedBy, row._count.id]
    }))

    const result = clients.map((c) => ({
      ...c,
      deviceCount: countMap.get(c.id) ?? 0,
    }))

    return NextResponse.json(result)
  } catch (err) {
    console.error('[Admin] Get clients error:', err)
    return NextResponse.json({ error: 'Failed to fetch clients' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireAdminAuth(request)
  if (authResult instanceof NextResponse) return authResult

  const body = await request.json()
  const { name, email, password } = body

  if (!name || !email || !password) {
    return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 })
  }

  let createdUserId: string | undefined
  try {
    const result = await auth.api.createUser({
      // role cast needed: Better Auth's type only knows "user"|"admin",
      // but at runtime it passes through to Prisma where 'client' is valid in our enum.
      // Without this, Better Auth injects defaultRole:"user" which fails our user_role enum.
      body: { name, email, password, role: 'client' as any },
      headers: await headers(),
    })
    createdUserId = result.user.id

    // Set role to 'client' and mark email as unverified.
    // Better Auth's admin createUser sets emailVerified: true by default —
    // override it so sendVerificationEmail accepts the request.
    await prisma.user.update({
      where: { id: result.user.id },
      data: { role: 'client', emailVerified: false },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create client'
    const isDuplicate = msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('already exists')
    if (!isDuplicate) console.error('[Admin] Create client error:', err)
    return NextResponse.json(
      { error: isDuplicate ? 'A user with that email already exists' : msg },
      { status: isDuplicate ? 409 : 500 },
    )
  }

  // Send verification email manually — auth.api.sendVerificationEmail checks the
  // session in headers and finds the admin (already verified), not the new client.
  // We bypass it by generating a signed JWT (same format Better Auth uses internally)
  // and sending the email ourselves via the shared transporter.
  try {
    const secret = new TextEncoder().encode(process.env.BETTER_AUTH_SECRET)
    const expiresIn = 24 * 60 * 60 // 24 hours in seconds
    const token = await new SignJWT({ email: email.toLowerCase() })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
      .sign(secret)

    const verifyUrl = `${process.env.BETTER_AUTH_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=%2Fclient%2Flogin`

    await transporter.sendMail({
      from: `"SSCM" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'Verify your Smart Shoe Care Machine account',
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
          <p style="margin:4px 0 0;font-size:11px;color:#52525b;letter-spacing:1px;">Account Verification</p>
        </td>
      </tr>

      <!-- Banner -->
      <tr>
        <td style="background:#eff6ff;border-left:5px solid #2563eb;border-bottom:1px solid #93c5fd;padding:16px 32px;">
          <p style="margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:2px;color:#2563eb;text-transform:uppercase;">Action Required</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#18181b;line-height:1.3;">Verify your email address</h1>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:32px;">
          <p style="margin:0 0 6px;font-size:14px;color:#3f3f46;">Hello,</p>
          <p style="margin:0 0 24px;font-size:14px;color:#52525b;line-height:1.7;">
            You've been registered as a client on the <strong style="color:#18181b;">Smart Shoe Care Machine</strong> platform.
            Please verify your email address to activate your account and gain access to your dashboard.
          </p>

          <!-- CTA -->
          <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td style="border-radius:6px;background:#2563eb;">
                <a href="${verifyUrl}" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.05em;border-radius:6px;">Verify Email Address</a>
              </td>
            </tr>
          </table>

          <!-- Details -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px;">
            <tr>
              <td colspan="2" style="padding:12px 16px;border-bottom:1px solid #e4e4e7;background:#f4f4f5;border-radius:6px 6px 0 0;">
                <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#71717a;text-transform:uppercase;">What happens next</p>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#71717a;width:160px;vertical-align:top;">Step 1</td>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#3f3f46;">Click the button above to verify your email address</td>
            </tr>
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#71717a;vertical-align:top;">Step 2</td>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#3f3f46;">Log in using the credentials provided by your administrator</td>
            </tr>
            <tr>
              <td style="padding:12px 16px;font-size:13px;color:#71717a;vertical-align:top;">Step 3</td>
              <td style="padding:12px 16px;font-size:13px;color:#3f3f46;">Access your Smart Shoe Care Machine dashboard</td>
            </tr>
          </table>

          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;margin-bottom:28px;">
            <tr>
              <td style="padding:14px 16px;">
                <p style="margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#d97706;text-transform:uppercase;">Important</p>
                <p style="margin:0;font-size:13px;color:#3f3f46;line-height:1.6;">This verification link expires in <strong>24 hours</strong>. If you did not expect this email, you can safely ignore it — no account will be activated without verification.</p>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 4px;font-size:14px;color:#3f3f46;">Regards,</p>
          <p style="margin:0;font-size:14px;font-weight:600;color:#18181b;">Smart Shoe Care Machine</p>
          <p style="margin:0;font-size:13px;color:#71717a;">Client Account System</p>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#fafafa;border-top:1px solid #e4e4e7;padding:20px 32px;">
          <p style="margin:0 0 6px;font-size:12px;color:#a1a1aa;line-height:1.6;">
            If the button above doesn't work, copy and paste this URL into your browser:
          </p>
          <p style="margin:0;font-size:11px;color:#2563eb;word-break:break-all;">${verifyUrl}</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>
      `,
    })
  } catch (err: unknown) {
    // Roll back the created user — client cannot log in without verifying
    await prisma.user.delete({ where: { id: createdUserId } }).catch(() => undefined)
    console.error('[Admin] Failed to send verification email:', err)
    return NextResponse.json(
      { error: 'Account created but verification email failed to send. Please check email configuration.' },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true }, { status: 201 })
}
