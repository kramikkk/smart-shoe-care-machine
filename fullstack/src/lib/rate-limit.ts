import { NextRequest, NextResponse } from 'next/server'

interface RateLimitStore {
  count: number
  resetTime: number
}

// Simple in-memory store for rate limiting
// In production, use Redis for distributed rate limiting
const rateLimitStore = new Map<string, RateLimitStore>()
const RATE_LIMIT_MAX_KEYS = 50_000

// Clean up expired entries every 60s.
// Also prunes oldest 25% when the Map exceeds RATE_LIMIT_MAX_KEYS to prevent
// unbounded growth from many unique IPs on Render's 512MB free instance.
// unref() so this timer doesn't prevent clean process exit.
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetTime < now) {
      rateLimitStore.delete(key)
    }
  }
  if (rateLimitStore.size > RATE_LIMIT_MAX_KEYS) {
    const pruneCount = Math.floor(RATE_LIMIT_MAX_KEYS * 0.25)
    let pruned = 0
    for (const key of rateLimitStore.keys()) {
      rateLimitStore.delete(key)
      if (++pruned >= pruneCount) break
    }
  }
}, 60 * 1000).unref()

export interface RateLimitConfig {
  maxRequests: number // Maximum requests allowed
  windowMs: number    // Time window in milliseconds
}

/**
 * Rate limiting middleware
 *
 * @param request - The incoming request
 * @param config - Rate limit configuration
 * @returns NextResponse if rate limit exceeded, null otherwise
 */
export function rateLimit(
  request: NextRequest,
  config: RateLimitConfig = { maxRequests: 100, windowMs: 60000 } // Default: 100 req/min
): NextResponse | null {
  // Get client identifier (IP address)
  // Use the last entry in x-forwarded-for (appended by trusted reverse proxy)
  // rather than the first (client-controlled and spoofable)
  const forwarded = request.headers.get('x-forwarded-for')
  const realIp = request.headers.get('x-real-ip')
  const forwardedParts = forwarded?.split(',').map(s => s.trim()) ?? []
  const ip = forwardedParts.length > 0 ? forwardedParts[forwardedParts.length - 1] : realIp || 'unknown'

  // Create unique key for this endpoint + IP combination
  const pathname = new URL(request.url).pathname
  const key = `${ip}:${pathname}`

  const now = Date.now()
  const record = rateLimitStore.get(key)

  // Initialize or reset if window expired
  if (!record || record.resetTime < now) {
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + config.windowMs
    })
    return null
  }

  // Increment counter
  record.count++

  // Check if limit exceeded
  if (record.count > config.maxRequests) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000)

    return NextResponse.json(
      {
        error: 'Too many requests',
        message: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
        retryAfter
      },
      {
        status: 429,
        headers: {
          'Retry-After': retryAfter.toString(),
          'X-RateLimit-Limit': config.maxRequests.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': new Date(record.resetTime).toISOString()
        }
      }
    )
  }

  // Update remaining count
  return null
}

/**
 * Get rate limit headers for successful requests
 */
export function getRateLimitHeaders(
  request: NextRequest,
  config: RateLimitConfig
): Record<string, string> {
  const forwarded = request.headers.get('x-forwarded-for')
  const realIp = request.headers.get('x-real-ip')
  const forwardedParts = forwarded?.split(',').map(s => s.trim()) ?? []
  const ip = forwardedParts.length > 0 ? forwardedParts[forwardedParts.length - 1] : realIp || 'unknown'
  const pathname = new URL(request.url).pathname
  const key = `${ip}:${pathname}`

  const record = rateLimitStore.get(key)

  if (!record) {
    return {
      'X-RateLimit-Limit': config.maxRequests.toString(),
      'X-RateLimit-Remaining': config.maxRequests.toString(),
    }
  }

  const remaining = Math.max(0, config.maxRequests - record.count)

  return {
    'X-RateLimit-Limit': config.maxRequests.toString(),
    'X-RateLimit-Remaining': remaining.toString(),
    'X-RateLimit-Reset': new Date(record.resetTime).toISOString()
  }
}
