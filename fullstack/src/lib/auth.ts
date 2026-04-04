import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import prisma from '@/lib/prisma'
import { nextCookies } from 'better-auth/next-js'
import { admin } from 'better-auth/plugins'
import { sendMail } from '@/lib/mailer'

// Get trusted origins from environment variable or use defaults
const getTrustedOrigins = () => {
  const envOrigins = process.env.TRUSTED_ORIGINS
  if (envOrigins) {
    return envOrigins.split(',').map(origin => origin.trim())
  }
  // Default to localhost for development
  return ['http://localhost:3000']
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true, // all accounts created by admin only
    requireEmailVerification: true,
  },
  emailVerification: {
    sendOnSignUp: true,
    callbackURL: '/client/login',
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({
        from: `"SSCM" <${process.env.GMAIL_USER}>`,
        to: user.email,
        replyTo: process.env.GMAIL_USER!,
        subject: 'Verify your Smart Shoe Care Machine account',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0a0a0a;color:#ffffff;border-radius:8px;">
            <h2 style="font-size:20px;font-weight:900;letter-spacing:-0.5px;margin:0 0 8px;">Verify your email</h2>
            <p style="color:#888;font-size:14px;margin:0 0 24px;">You've been registered as a client on the Smart Shoe Care Machine platform. Click the button below to verify your email address and activate your account.</p>
            <a href="${url}" style="display:inline-block;background:#3b82f6;color:#fff;font-weight:700;font-size:14px;padding:12px 24px;border-radius:6px;text-decoration:none;letter-spacing:0.05em;">Verify Email</a>
            <p style="color:#555;font-size:12px;margin:24px 0 0;">If you did not expect this email, you can safely ignore it.</p>
          </div>
        `,
      })
    },
  },
  session: {
    expiresIn: 60 * 60 * 8,        // 8 hours
    updateAge: 60 * 60,             // refresh session timestamp every 1 hour
  },
  trustedOrigins: getTrustedOrigins(),
  plugins: [nextCookies(), admin()],
})