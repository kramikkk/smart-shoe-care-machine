import { createServer } from 'http'
import next from 'next'
import { createWebSocketServer } from './src/lib/websocket'

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
  'GMAIL_APP_PASSWORD',
]

const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key])
if (missing.length > 0) {
  console.error(`[Startup] Missing required environment variables: ${missing.join(', ')}`)
  process.exit(1)
}

// TRUSTED_ORIGINS is optional but required in production for auth and WebSocket
// to accept requests from the real host. Without it, Better Auth falls back to
// localhost only, silently rejecting all non-localhost logins.
if (!process.env.TRUSTED_ORIGINS) {
  console.warn('[Startup] TRUSTED_ORIGINS is not set — Better Auth will only trust http://localhost:3000. Set this to your production URL(s).')
}

const dev = process.env.NODE_ENV !== 'production'
const hostname = 'localhost'
const listenHost = '0.0.0.0'
const port = parseInt(process.env.PORT || '3000', 10)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare()
  .then(() => {
    const server = createServer(async (req, res) => {
      try {
        await handle(req, res)
      } catch (err) {
        console.error('Error occurred handling', req.url, err)
        res.statusCode = 500
        res.end('internal server error')
      }
    })

    const wss = createWebSocketServer(server)

    server.listen(port, listenHost, () => {
      const os = require('os')
      const ifaces = os.networkInterfaces()
      const lanIps = Object.values(ifaces)
        .flat()
        .filter((iface): iface is { family: string; internal: boolean; address: string } =>
          typeof iface === 'object' && iface !== null &&
          'family' in iface && iface.family === 'IPv4' &&
          'internal' in iface && !iface.internal &&
          'address' in iface && typeof iface.address === 'string'
        )
        .map((iface) => iface.address)
      console.log(`> Ready on:`)
      console.log(`   Local:    http://${hostname}:${port}`)
      lanIps.forEach(ip => console.log(`   Network:  http://${ip}:${port}`))
      console.log(`> WebSocket server running on:`)
      console.log(`   ws://localhost:${port}/api/ws`)
      lanIps.forEach(ip => console.log(`   ws://${ip}:${port}/api/ws`))
    })

    // Graceful shutdown handlers
    let isShuttingDown = false
    function shutdown(signal: string) {
      if (isShuttingDown) return
      isShuttingDown = true
      console.log(`[Server] Received ${signal}, shutting down gracefully...`)

      // Terminate all WS connections then destroy all open HTTP connections
      // so server.close() callback fires immediately instead of waiting.
      // wss.close() alone does not terminate existing clients — must call terminate()
      // on each client explicitly since upgraded WS sockets are no longer tracked
      // by the HTTP server and won't be reached by closeAllConnections().
      wss.clients.forEach(client => client.terminate())
      wss.close()
      server.closeAllConnections()

      // Force exit after 3s in case some connection (e.g. Next.js HMR) keeps the
      // server open and server.close() callback never fires.
      const forceExit = setTimeout(() => {
        console.warn('[Server] Graceful shutdown timed out, forcing exit')
        process.exit(0)
      }, dev ? 500 : 3000)
      forceExit.unref()

      server.close(() => {
        console.log('[Server] HTTP server closed')
        clearTimeout(forceExit)
        process.exit(0)
      })
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  })
  .catch((err) => {
    console.error('[Startup] Next.js failed to prepare:', err)
    process.exit(1)
  })
