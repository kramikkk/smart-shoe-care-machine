import { NextRequest, NextResponse } from 'next/server'
import { transporter } from '@/lib/mailer'
import { rateLimit } from '@/lib/rate-limit'

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest) {
    const rateLimitResult = rateLimit(req, { maxRequests: 5, windowMs: 60 * 60 * 1000 }) // 5/hour per IP
    if (rateLimitResult) return rateLimitResult

    let body: { firstName?: unknown; lastName?: unknown; email?: unknown; message?: unknown }
    try {
        body = await req.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }
    const { firstName, lastName, email, message } = body

    if (!firstName || !lastName || !email || !message ||
        typeof firstName !== 'string' || typeof lastName !== 'string' ||
        typeof email !== 'string' || typeof message !== 'string') {
        return NextResponse.json({ error: 'All fields are required.' }, { status: 400 })
    }

    if (!EMAIL_RE.test(email)) {
        return NextResponse.json({ error: 'Invalid email address.' }, { status: 400 })
    }

    const contactEmail = process.env.GMAIL_USER!

    const safeName    = escapeHtml(`${firstName} ${lastName}`)
    const safeEmail   = escapeHtml(email)
    const safeMessage = escapeHtml(message)

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

    const { messageId, rejected } = await transporter.sendMail({
        from: `"SSCM" <${process.env.GMAIL_USER}>`,
        to: contactEmail,
        replyTo: email,
        subject: `New Inquiry from ${safeName} — Smart Shoe Care Machine`,
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
          <p style="margin:4px 0 0;font-size:11px;color:#52525b;letter-spacing:1px;">Customer Inquiry Notification</p>
        </td>
      </tr>

      <!-- Title Banner -->
      <tr>
        <td style="background:#eff6ff;border-left:5px solid #2563eb;border-bottom:1px solid #93c5fd;padding:16px 32px;">
          <p style="margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:2px;color:#2563eb;text-transform:uppercase;">New Inquiry Received</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;color:#18181b;line-height:1.3;">Customer Contact Form Submission</h1>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:32px;">

          <p style="margin:0 0 24px;font-size:14px;color:#52525b;line-height:1.7;">
            A new inquiry has been submitted through the Smart Shoe Care Machine website contact form.
            The details of the submission are provided below for your reference.
          </p>

          <!-- Contact Details -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px;">
            <tr>
              <td colspan="2" style="padding:12px 16px;border-bottom:1px solid #e4e4e7;background:#f4f4f5;border-radius:6px 6px 0 0;">
                <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#71717a;text-transform:uppercase;">Sender Information</p>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#71717a;width:160px;vertical-align:top;">Full Name</td>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#18181b;font-weight:600;">${safeName}</td>
            </tr>
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#71717a;vertical-align:top;">Email Address</td>
              <td style="padding:12px 16px;border-bottom:1px solid #f4f4f5;font-size:13px;">
                <a href="mailto:${safeEmail}" style="color:#2563eb;text-decoration:none;">${safeEmail}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 16px;font-size:13px;color:#71717a;vertical-align:top;">Date &amp; Time</td>
              <td style="padding:12px 16px;font-size:13px;color:#18181b;">${timestamp}</td>
            </tr>
          </table>

          <!-- Message -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:28px;">
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #e4e4e7;background:#f4f4f5;border-radius:6px 6px 0 0;">
                <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#71717a;text-transform:uppercase;">Message</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px;font-size:14px;color:#3f3f46;line-height:1.7;white-space:pre-wrap;">${safeMessage}</td>
            </tr>
          </table>

          <!-- Action Note -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #93c5fd;border-radius:6px;margin-bottom:28px;">
            <tr>
              <td style="padding:14px 16px;">
                <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1.5px;color:#2563eb;text-transform:uppercase;">Action Required</p>
                <p style="margin:0;font-size:13px;color:#3f3f46;line-height:1.6;">
                  Please respond to this inquiry at your earliest convenience. You may reply directly
                  to the sender by writing to <a href="mailto:${safeEmail}" style="color:#2563eb;">${safeEmail}</a>,
                  or use the reply-to address set in this email.
                </p>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 4px;font-size:14px;color:#3f3f46;">Regards,</p>
          <p style="margin:0;font-size:14px;font-weight:600;color:#18181b;">Smart Shoe Care Machine</p>
          <p style="margin:0;font-size:13px;color:#71717a;">Customer Inquiry System</p>

        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#fafafa;border-top:1px solid #e4e4e7;padding:20px 32px;">
          <p style="margin:0 0 6px;font-size:12px;color:#a1a1aa;line-height:1.6;">
            This message was automatically generated upon submission of the contact form on the
            Smart Shoe Care Machine website. Please do not reply directly to this notification email.
          </p>
          <p style="margin:0;font-size:12px;color:#a1a1aa;">
            To respond to the sender, use the reply-to address: <strong style="color:#71717a;">${safeEmail}</strong>
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

    if (rejected?.length) {
        console.error('[contact] Email rejected:', rejected)
        return NextResponse.json({ error: 'Failed to send email.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
}
