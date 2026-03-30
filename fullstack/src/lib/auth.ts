import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import prisma from '@/lib/prisma'
import { nextCookies } from 'better-auth/next-js'
import { admin } from 'better-auth/plugins'

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
  },
  session: {
    expiresIn: 60 * 60 * 8,        // 8 hours
    updateAge: 60 * 60,             // refresh session timestamp every 1 hour
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,               // cache session cookie for 5 minutes
    },
  },
  trustedOrigins: getTrustedOrigins(),
  plugins: [nextCookies(), admin()],
})