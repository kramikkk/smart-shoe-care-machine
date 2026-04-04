/**
 * Gmail API mailer — uses fetch over HTTPS instead of SMTP.
 * Works on Render free tier (no port 465/587 needed).
 * Requires GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.
 */

async function getAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
      grant_type:    'refresh_token',
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Failed to get access token: ${err}`)
  }
  const data = await res.json() as { access_token?: string }
  if (!data.access_token) throw new Error('No access token in response')
  return data.access_token
}

function buildRawEmail(options: {
  from: string
  to: string
  replyTo: string
  subject: string
  html: string
}): string {
  const lines = [
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Reply-To: ${options.replyTo}`,
    `Subject: =?UTF-8?B?${Buffer.from(options.subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    options.html,
  ]
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

export async function sendMail(options: {
  from: string
  to: string
  replyTo: string
  subject: string
  html: string
}) {
  const accessToken = await getAccessToken()
  const raw = buildRawEmail(options)

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail API error: ${err}`)
  }
}
