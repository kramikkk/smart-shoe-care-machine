import { createServer, type Server } from 'http'
import os from 'os'
import next from 'next'
import { createWebSocketServer } from './src/lib/websocket'
import prisma from './src/lib/prisma'
import type { WebSocketServer } from 'ws'

// Mutable refs so signal handlers registered early can reference server/wss
// once they're created inside app.prepare().then(). Both start null so
// an early SIGTERM (during cold-start) still exits cleanly.
let serverRef: Server | null = null
let wssRef: WebSocketServer | null = null
let memInterval: NodeJS.Timeout | null = null

process.on('uncaughtException', (err) => {
  console.error('[Global] Uncaught Exception — restarting')
  console.error('[Global] Name:', err.name)
  console.error('[Global] Message:', err.message)
  console.error('[Global] Stack:', err.stack)
  if ((err as NodeJS.ErrnoException).code) {
    console.error('[Global] Code:', (err as NodeJS.ErrnoException).code)
  }
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Global] Unhandled Rejection at:', promise, 'reason:', reason)
})

// Validate required environment variables before starting
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GEMINI_API_KEY',
  'PAYMONGO_SECRET_KEY',
  'PAYMONGO_WEBHOOK_SECRET',
  'WS_AUTH_TOKEN',
  'GMAIL_USER',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
]

const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key])
if (missing.length > 0) {
  console.error(`[Startup] Missing required environment variables: ${missing.join(', ')}`)
  process.exit(1)
}

if (!process.env.TRUSTED_ORIGINS) {
  console.warn('[Startup] TRUSTED_ORIGINS is not set — Better Auth will only trust http://localhost:3000. Set this to your production URL(s).')
}

const dev = process.env.NODE_ENV !== 'production'
const hostname = 'localhost'
const listenHost = '0.0.0.0'
const rawPort = parseInt(process.env.PORT || '3000', 10)
const port = Number.isFinite(rawPort) ? rawPort : 3000

// Register signal handlers BEFORE app.prepare() so a SIGTERM during cold-start
// (Next.js can take 10-30s to prepare) still triggers a clean shutdown instead
// of an immediate unclean exit that leaves Prisma pool connections open on Neon.
let isShuttingDown = false
function shutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[Server] Received ${signal}, shutting down gracefully...`)

  if (memInterval) clearInterval(memInterval)

  // Terminate all WS connections then destroy all open HTTP connections
  // so server.close() callback fires immediately instead of waiting.
  wssRef?.clients.forEach(client => client.terminate())
  wssRef?.close()
  serverRef?.closeAllConnections()

  // Force exit after 3s if server.close() never fires (stuck HMR socket etc.)
  const forceExit = setTimeout(() => {
    console.warn('[Server] Graceful shutdown timed out, forcing exit')
    process.exit(0)
  }, dev ? 500 : 3000)
  forceExit.unref()

  // Disconnect Prisma INSIDE server.close() so in-flight DB queries finish first.
  if (serverRef) {
    serverRef.close(async () => {
      clearTimeout(forceExit)
      await prisma.$disconnect().catch(() => {})
      console.log('[Server] HTTP server closed')
      process.exit(0)
    })
  } else {
    // Server never started (SIGTERM during cold-start) — just exit cleanly.
    prisma.$disconnect().catch(() => {}).finally(() => process.exit(0))
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare()
  .then(() => {
    const server = createServer((req, res) => {
      // /healthz — Render's health check probe. Must respond instantly before
      // Next.js processes anything, so it never times out during cold-start and
      // a DB hiccup never triggers an unnecessary container restart.
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
        return
      }

      // Timeout hung requests so they don't hold Prisma pool connections indefinitely.
      // Neon cold-starts can take 5-15s; 25s gives enough headroom without starving the pool.
      res.setTimeout(25_000, () => {
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'text/plain', 'Connection': 'close' })
          res.end('request timeout')
        }
        res.socket?.destroy()
      })

      handle(req, res).catch(err => {
        console.error('Error occurred handling', req.url, err)
        if (!res.headersSent) {
          res.statusCode = 500
          res.end('internal server error')
        }
      })
    })

    // Render's load balancer has a 75s idle connection timeout.
    // Node.js default keepAliveTimeout is 5s — if Node closes first, the LB
    // tries to reuse the dead connection and returns a 502 to the user.
    // Setting both above 75s prevents this race condition.
    server.keepAliveTimeout = 90_000
    server.headersTimeout = 91_000

    serverRef = server
    wssRef = createWebSocketServer(server)

    // Log RSS every 5 minutes — visible in Render logs so you can spot memory
    // creep before the 512MB OOM hits.
    memInterval = setInterval(() => {
      const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)
      const { rss, heapUsed, heapTotal } = process.memoryUsage()
      console.log(`[Memory] RSS=${mb(rss)}MB heap=${mb(heapUsed)}/${mb(heapTotal)}MB`)
    }, 5 * 60 * 1000)
    memInterval.unref()

    server.listen(port, listenHost, () => {
      const ifaces = os.networkInterfaces()
      const lanIps = Object.values(ifaces)
        .flat()
        .filter((iface): iface is os.NetworkInterfaceInfo =>
          typeof iface === 'object' && iface !== null &&
          iface.family === 'IPv4' && !iface.internal
        )
        .map((iface) => iface.address)
      console.log(`> Ready on:`)
      console.log(`   Local:    http://${hostname}:${port}`)
      lanIps.forEach(ip => console.log(`   Network:  http://${ip}:${port}`))
      console.log(`> WebSocket server running on:`)
      console.log(`   ws://localhost:${port}/api/ws`)
      lanIps.forEach(ip => console.log(`   ws://${ip}:${port}/api/ws`))
    })
  })
  .catch((err) => {
    console.error('[Startup] Next.js failed to prepare:', err)
    process.exit(1)
  })
