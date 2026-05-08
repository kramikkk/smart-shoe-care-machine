import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import type { Server } from 'http'
import type { Duplex } from 'stream'
import prisma from './prisma'
import {
  parseServiceStatusProgress,
  tryParseServiceStatusRemainingSeconds,
} from './service-status-fields'

/**
 * High-volume WebSocket traces (every sensor frame, each browser subscribe, heartbeats).
 * Off by default in production — set WS_VERBOSE=1 or WS_VERBOSE=true to enable (e.g. local debug).
 * Errors and security warnings are always logged.
 */
const WS_VERBOSE =
  process.env.WS_VERBOSE === '1' || process.env.WS_VERBOSE === 'true'

function wsVerbose(...args: unknown[]) {
  if (WS_VERBOSE) console.log(...args)
}

// Store active WebSocket connections by device ID (for clients subscribing to device updates)
// Use a global singleton so all Next.js bundles (API routes, custom server) share the same Map
declare global {
  // eslint-disable-next-line no-var
  var _deviceConnections: Map<string, Set<WebSocket>> | undefined
  // eslint-disable-next-line no-var
  var _deviceLiveConnections: Map<string, WebSocket> | undefined
  // eslint-disable-next-line no-var
  var _deviceLastStatusTime: Map<string, number> | undefined
  // eslint-disable-next-line no-var
  var _deviceLastDbUpdateTime: Map<string, number> | undefined
  // eslint-disable-next-line no-var
  var _deviceCachedPairedStatus: Map<string, boolean> | undefined
  // eslint-disable-next-line no-var
  var _devicePendingOfflineTimers: Map<string, NodeJS.Timeout> | undefined
  // eslint-disable-next-line no-var
  var _resumeGuardTimers: Map<string, NodeJS.Timeout> | undefined
}
const deviceConnections: Map<string, Set<WebSocket>> =
  global._deviceConnections ?? (global._deviceConnections = new Map())

// Tracks the live WebSocket of the ESP32 device itself (set when status-update is received).
// Used to check real-time online status rather than relying on the stale lastSeen timestamp.
const deviceLiveConnections: Map<string, WebSocket> =
  global._deviceLiveConnections ?? (global._deviceLiveConnections = new Map())

// Tracks the last time each device sent a status-update message.
// Used by the application-level timeout to detect ungraceful disconnects (e.g. power cut)
// faster than the TCP heartbeat can.
const deviceLastStatusTime: Map<string, number> =
  global._deviceLastStatusTime ?? (global._deviceLastStatusTime = new Map())

const deviceLastDbUpdateTime: Map<string, number> =
  global._deviceLastDbUpdateTime ?? (global._deviceLastDbUpdateTime = new Map())

const deviceCachedPairedStatus: Map<string, boolean> =
  global._deviceCachedPairedStatus ?? (global._deviceCachedPairedStatus = new Map())

const devicePendingOfflineTimers: Map<string, NodeJS.Timeout> =
  global._devicePendingOfflineTimers ?? (global._devicePendingOfflineTimers = new Map())

// Cancellable staleness-guard timers keyed by transaction ID.
// Stored globally so a second reconnect can cancel the guard armed by the first.
const resumeGuardTimers: Map<string, NodeJS.Timeout> =
  global._resumeGuardTimers ?? (global._resumeGuardTimers = new Map())

// Offline timeout for ungraceful disconnects (power cut/network loss).
// ESP32 sends status every 5s; 15s = 3 missed cycles, enough margin to avoid
// false-offline flaps from brief stalls (OTA handle, DHT read, TLS re-handshake).
const DEVICE_STATUS_TIMEOUT_MS = 15_000

// How long to wait for a kiosk to respond to a service-interrupted broadcast before
// automatically sending skip-resume. 10 min covers the case where the tablet reboots
// slowly or the customer walks away briefly.
const STALE_RESUME_GUARD_MS = 30 * 60 * 1000

// Minimum remaining duration worth resuming. If the checkpoint has less than this left
// (after subtracting time elapsed since the interruption), skip-resume is sent instead.
const MIN_VIABLE_RESUME_MS = 5_000

// Token validation — requires WS_AUTH_TOKEN (enforced at startup in server.ts)
function validateWebSocketToken(token: string | null): boolean {
  if (!token) return false
  const wsToken = process.env.WS_AUTH_TOKEN
  return token === wsToken
}

export function createWebSocketServer(server: Server) {
  const wss = new WebSocketServer({
    noServer: true,
    path: '/api/ws'
  })

  // Heartbeat: ping every 25s, terminate connections that don't pong back.
  // Firmware self-disconnects at ~21s (enableHeartbeat(15s, 3s, 2)). Using 25s keeps the
  // server as the later detector, providing a 4s buffer against Node.js event-loop jitter
  // on constrained hosting (Render) where setInterval can drift 5–10s under load.
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket & { _isAlive?: boolean }) => {
      if (ws._isAlive === false) {
        ws.terminate()
        return
      }
      ws._isAlive = false
      ws.ping()
    })
  }, 25_000)
  heartbeatInterval.unref()
  wss.on('close', () => clearInterval(heartbeatInterval))

  // Application-level device timeout: detect when an ESP32 stops sending status-updates
  // (e.g. power cut without a graceful TCP close). Faster than the TCP heartbeat because
  // we know the device sends status-update every 5s — 3 missed cycles = offline.
  const deviceTimeoutInterval = setInterval(() => {
    const now = Date.now()
    deviceLiveConnections.forEach((_, devId) => {
      const lastSeen = deviceLastStatusTime.get(devId) ?? 0
      if (now - lastSeen > DEVICE_STATUS_TIMEOUT_MS) {
        console.log(`[WebSocket] Device ${devId} timed out (no status-update in ${DEVICE_STATUS_TIMEOUT_MS}ms) — marking offline`)
        deviceLiveConnections.delete(devId)
        deviceLastStatusTime.delete(devId)
        // Cancel any close-event debounce timer — we're broadcasting now, no need for a second one
        const pendingTimer = devicePendingOfflineTimers.get(devId)
        if (pendingTimer) {
          clearTimeout(pendingTimer)
          devicePendingOfflineTimers.delete(devId)
        }
        broadcastToDevice(devId, { type: 'device-offline', deviceId: devId })
        // Write lastSeen at timeout so the dashboard shows the real offline time
        prisma.device.update({ where: { deviceId: devId }, data: { lastSeen: new Date() } }).catch(() => {})
      }
    })
  }, 3_000)
  deviceTimeoutInterval.unref()
  wss.on('close', () => clearInterval(deviceTimeoutInterval))

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname, searchParams } = new URL(request.url || '', `http://${request.headers.host}`)

    // Only handle our custom WebSocket endpoint
    if (pathname === '/api/ws') {
      const origin = request.headers.origin
      const serverHost = request.headers.host // e.g. "192.168.43.147:3000"

      // Normalize origins: lowercase and remove ALL trailing slashes. 
      // Turns 'file://' or 'file:/' into 'file:', and 'http://host/' into 'http://host'.
      const normalizedOrigin = origin ? origin.toLowerCase().replace(/\/+$/, '') : null
      const allowedOrigins = [
        'http://localhost:3000',
        'https://localhost:3000',
        'file:',
        // TRUSTED_ORIGINS env var (comma-separated) — same variable used by Better Auth
        ...(process.env.TRUSTED_ORIGINS ? process.env.TRUSTED_ORIGINS.split(',').map(s => s.trim().toLowerCase().replace(/\/+$/, '')) : []),
      ].filter(Boolean)

      // Also allow same-host connections (tablet accessing via LAN IP).
      // must allow both http and https origins for the same-host check.
      const isSameHost = normalizedOrigin && serverHost && (
        normalizedOrigin === `http://${serverHost}` || 
        normalizedOrigin === `https://${serverHost}`
      )

      if (origin && !allowedOrigins.includes(normalizedOrigin!) && !isSameHost) {
        console.warn(`[WebSocket] Rejected connection from origin: ${origin} (Normalized: ${normalizedOrigin})`)
        console.warn(`[WebSocket] Allowed origins: ${allowedOrigins.join(', ')}`)
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }

      // Extract token from query params or cookies
      const token = searchParams.get('token') || request.headers.cookie?.match(/auth-token=([^;]+)/)?.[1] || null

      // For device connections (ESP32), allow if they provide a valid SSCM- deviceId
      const deviceId = searchParams.get('deviceId')
      const isDeviceConnection = deviceId && deviceId.startsWith('SSCM-')

      // Allow if:
      // 1. Valid X-Auth-Token/Cookie (admin dashboard login)
      // 2. Or it's a browser context (Kiosk/Dashboard) — relax requirement for deviceId 
      //    so we don't reject initial connections before choice is made. 
      // 3. Or it's the ESP32 itself (detected by SSCM- prefix and no token)
      const source = searchParams.get('source')
      const isBrowserClient = source === 'kiosk' || source === 'dashboard'
      const isESP32 = isDeviceConnection && !token

      if (!validateWebSocketToken(token) && !isBrowserClient && !isESP32) {
        console.warn(`[WebSocket] Unauthorized connection attempt from ${origin || 'unknown'} (deviceId: ${deviceId || 'none'}, source: ${source || 'none'})`)
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    }
    // For other paths (like /_next/webpack-hmr), don't handle them
    // Let Next.js handle its own WebSocket connections
  })

  wss.on('connection', (ws: WebSocket & { _isAlive?: boolean }, request: IncomingMessage) => {
    ws._isAlive = true
    ws.on('pong', () => { ws._isAlive = true })

    const connUrl = new URL(request.url || '', `http://${request.headers.host}`)
    const connDeviceId = connUrl.searchParams.get('deviceId')
    const connSourceParam = connUrl.searchParams.get('source') // 'kiosk' | 'dashboard' | null (ESP32)
    // Both browser and ESP32 connect with deviceId=SSCM-xxx. Browser contexts
    // include a 'source' param; ESP32 firmware does not — use that to label them.
    const connLabel = connSourceParam ?? (connDeviceId ? 'esp32' : 'unknown')
    const connSource = connDeviceId ? `${connLabel} for ${connDeviceId}` : `${connLabel} client`
    // Always log kiosk/dashboard/ESP32 connections; suppress only truly unknown sources.
    if (connSourceParam === 'kiosk' || connSourceParam === 'dashboard' || connLabel === 'esp32') {
      console.log(`[WebSocket] New connection from ${connSource}`)
    } else {
      wsVerbose(`[WebSocket] New connection from ${connSource}`)
    }
    // Set to true only when a status-update message is received.
    // Browser clients (kiosk, dashboard) also pass deviceId in the URL but never send
    // status-update, so they are NOT treated as device connections. Detecting client type
    // from URL params alone would misclassify browser tabs as ESP32 devices because both
    // connect without a valid WS_AUTH_TOKEN in the browser context.
    let isDeviceWsClient = false
    let deviceId: string | null = connDeviceId

    // AUTO-SUBSCRIBE: If deviceId is provided in URL, add to connections set immediately.
    // This ensures that even if the client's first 'subscribe' message is delayed or 
    // the server restarts, the connection is already 'in the room'.
    if (deviceId) {
      let connections = deviceConnections.get(deviceId)
      if (!connections) {
        connections = new Set<WebSocket>()
        deviceConnections.set(deviceId, connections)
      }
      connections.add(ws)
      wsVerbose(`[WebSocket] [${connLabel}] auto-subscribed to device: ${deviceId}`)

      // IMMEDIATE: Tell the joining client if the device is live right now.
      // deviceLiveConnections and deviceCachedPairedStatus are in-memory — no DB wait needed.
      // This fires synchronously so kiosk/dashboard know the device is online instantly on connect,
      // without waiting 1-3s for the Neon DB round-trip below.
      const autoLiveWs = deviceLiveConnections.get(deviceId)
      if (autoLiveWs && autoLiveWs.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'device-online',
          deviceId: deviceId,
          paired: deviceCachedPairedStatus.get(deviceId) ?? false,
          lastSeen: new Date().toISOString()
        }))
      }

      // EAGER PUSH: Async DB lookup for full pairing state (pairingCode, groupToken, camSynced).
      // device-online was already sent above; this only sends device-update.
      ;(async () => {
        try {
          // Implement 8s race timeout
          const timeoutPromise = new Promise<null>((_, reject) => 
            setTimeout(() => reject(new Error('QUERY_TIMEOUT')), 8000)
          )

          const fetchState = prisma.device.findUnique({
            where: { deviceId: deviceId as string },
            select: { paired: true, pairedAt: true, name: true, pairingCode: true, groupToken: true, lastSeen: true, camSynced: true, camDeviceId: true },
          })

          const device = await Promise.race([fetchState, timeoutPromise])

          if (device && ws.readyState === WebSocket.OPEN) {
            // Warmup the in-memory cache with the value from DB
            deviceCachedPairedStatus.set(deviceId, device.paired)

            ws.send(JSON.stringify({
              type: 'device-update',
              deviceId: deviceId,
              data: {
                paired: device.paired,
                pairedAt: device.pairedAt,
                deviceName: device.name,
                pairingCode: device.paired ? null : device.pairingCode,
                groupToken: device.paired ? device.groupToken : null,
                camSynced: device.camSynced,
                camDeviceId: device.camDeviceId,
              }
            }))
          } else if (!device) {
             wsVerbose(`[WebSocket] New device identified (not in DB): ${deviceId}`)
          }

          // Re-deliver service-interrupted to late-joining kiosk clients.
          // Race condition: the firmware boots and sends service-interrupted before the kiosk
          // (Android WebView) finishes loading. The broadcast hits an empty subscriber set.
          // On subscribe we check the DB and re-push directly to this connection.
          try {
            const interruptedTx = await prisma.transaction.findFirst({
              where: { deviceId: deviceId as string, status: 'INTERRUPTED' },
              orderBy: { interruptedAt: 'desc' },
            })
            if (interruptedTx?.serviceCheckpoint && ws.readyState === WebSocket.OPEN) {
              const ckpt = interruptedTx.serviceCheckpoint as Record<string, unknown>
              const origRemMs = Math.max(0, Number(ckpt.remainingMs) || 0)
              const elapsedSinceInterrupt = interruptedTx.interruptedAt
                ? Date.now() - interruptedTx.interruptedAt.getTime()
                : 0
              const adjustedRemMs = Math.max(0, origRemMs - elapsedSinceInterrupt)
              if (adjustedRemMs < MIN_VIABLE_RESUME_MS) {
                await prisma.transaction.update({
                  where: { id: interruptedTx.id },
                  data: { status: 'ABANDONED' },
                })
                ws.send(JSON.stringify({ type: 'skip-resume', deviceId: deviceId as string }))
              } else {
                const subscribeGuardExpiresAtMs = interruptedTx.interruptedAt
                  ? interruptedTx.interruptedAt.getTime() + STALE_RESUME_GUARD_MS
                  : Date.now() + STALE_RESUME_GUARD_MS
                ws.send(JSON.stringify({
                  type: 'service-interrupted',
                  deviceId: deviceId as string,
                  transactionId: interruptedTx.id,
                  checkpoint: ckpt,
                  remainingMs: adjustedRemMs,
                  guardExpiresAtMs: subscribeGuardExpiresAtMs,
                }))
                // Ensure the staleness guard is running (may be missing if server also restarted).
                if (!resumeGuardTimers.has(interruptedTx.id)) {
                  const txId = interruptedTx.id
                  const devId = deviceId as string
                  const guard = setTimeout(async () => {
                    resumeGuardTimers.delete(txId)
                    try {
                      const result = await prisma.transaction.updateMany({
                        where: { id: txId, status: 'INTERRUPTED' },
                        data: { status: 'ABANDONED' },
                      })
                      if (result.count > 0) {
                        console.log(`[WebSocket] Staleness guard (subscribe): auto skip-resume for ${devId} txid=${txId}`)
                        broadcastToDevice(devId, { type: 'skip-resume', deviceId: devId })
                      }
                    } catch { /* device may have resumed already */ }
                  }, STALE_RESUME_GUARD_MS)
                  resumeGuardTimers.set(txId, guard)
                }
              }
            }
          } catch (txErr) {
            console.warn(`[WebSocket] Interrupted tx check failed for ${deviceId as string}: ${txErr}`)
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Unknown error'
          console.warn(`[WebSocket] Eager push failed for ${deviceId}: ${errMsg}`)
        }
      })()
    }

    ws.on('message', async (data: Buffer) => {
      try {
        const rawData = data.toString()
        if (rawData.length > 65536) { // 64KB max message size
          console.warn('[WebSocket] Message too large, ignoring')
          return
        }
        const message = JSON.parse(rawData)

        // Handle client subscription to device updates
        // groupToken is NOT required for WS subscriptions — security for the
        // CAM→backend path is enforced via X-Group-Token on the classify HTTP endpoint
        if (message.type === 'subscribe' && message.deviceId) {
          const subscribeDeviceId = message.deviceId as string

          // ESP32 devices may only subscribe to their own deviceId
          if (deviceId && deviceId.startsWith('SSCM-') && deviceId !== subscribeDeviceId) {
            console.warn(`[WebSocket] Device ${deviceId} attempted to subscribe to ${subscribeDeviceId} — rejected`)
            return
          }

          deviceId = subscribeDeviceId
          let connections = deviceConnections.get(subscribeDeviceId)
          if (!connections) {
            connections = new Set<WebSocket>()
            deviceConnections.set(subscribeDeviceId, connections)
          }
          connections.add(ws)

          wsVerbose(`[WebSocket] [${connLabel}] subscribed to device: ${subscribeDeviceId}`)

          ws.send(JSON.stringify({
            type: 'subscribed',
            deviceId: subscribeDeviceId
          }))

          // IMMEDIATE: Send device-online synchronously from in-memory state (no DB wait).
          const subLiveWs = deviceLiveConnections.get(subscribeDeviceId)
          if (subLiveWs && subLiveWs.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'device-online',
              deviceId: subscribeDeviceId,
              paired: deviceCachedPairedStatus.get(subscribeDeviceId) ?? false,
              lastSeen: new Date().toISOString()
            }))
          }

          // Push full pairing state async (pairingCode, groupToken, camSynced need DB).
          // Skip if already auto-subscribed on connect — the eager push above already handled it.
          if (subscribeDeviceId !== connDeviceId) {
            ;(async () => {
              try {
                const device = await prisma.device.findUnique({
                  where: { deviceId: subscribeDeviceId },
                  select: { paired: true, pairedAt: true, name: true, pairingCode: true, groupToken: true, lastSeen: true, camSynced: true, camDeviceId: true },
                })
                if (device && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'device-update',
                    deviceId: subscribeDeviceId,
                    data: {
                      paired: device.paired,
                      pairedAt: device.pairedAt,
                      deviceName: device.name,
                      pairingCode: device.paired ? null : device.pairingCode,
                      groupToken: device.paired ? device.groupToken : null,
                      camSynced: device.camSynced,
                      camDeviceId: device.camDeviceId,
                    }
                  }))
                }
              } catch (err) {
                console.warn(`[WebSocket] Could not push initial device state for ${subscribeDeviceId}`)
              }
            })()
          }
        }

        // Handle device status update from ESP32
        else if (message.type === 'status-update' && message.deviceId) {
          const updateDeviceId = message.deviceId as string
          const pendingOffline = devicePendingOfflineTimers.get(updateDeviceId)
          if (pendingOffline) {
            clearTimeout(pendingOffline)
            devicePendingOfflineTimers.delete(updateDeviceId)
          }

          // Mark this connection as an actual ESP32 device — only firmware sends status-update.
          // This is used by the close handler to decide whether to broadcast device-offline.
          if (!isDeviceWsClient) {
            console.log(`[WebSocket] ESP32 identified: ${updateDeviceId}`)
          }
          // Track whether this device was already considered online before this message.
          // Only treat it as live if the old socket is actually OPEN.
          const oldWs = deviceLiveConnections.get(updateDeviceId)
          const wasAlreadyLive = !!oldWs && oldWs.readyState === WebSocket.OPEN

          isDeviceWsClient = true
          deviceLiveConnections.set(updateDeviceId, ws)

          // CRITICAL: Ensure the device is in the subscription set so it can receive commands.
          // If the server restarted, the ESP32 might still be connected but forgotten by memory.
          let connections = deviceConnections.get(updateDeviceId)
          if (!connections) {
            connections = new Set<WebSocket>()
            deviceConnections.set(updateDeviceId, connections)
          }
          if (!connections.has(ws)) {
            connections.add(ws)
            console.log(`[WebSocket] Auto-resubscribed device: ${updateDeviceId}`)
          }

          const now = Date.now()
          const lastDbUpdate = deviceLastDbUpdateTime.get(updateDeviceId) || 0;
          deviceLastStatusTime.set(updateDeviceId, now)

          // High-frequency: only when WS_VERBOSE=1 (throttled to ≤1/min per device when verbose)
          if (
            WS_VERBOSE &&
            (now - lastDbUpdate > 60_000 || !deviceCachedPairedStatus.has(updateDeviceId))
          ) {
            console.log(`[WebSocket] Status heartbeat from device: ${updateDeviceId}`)
          }

          // Update lastSeen in database and get current paired status
          // Throttle database writes to once every 60 seconds to prevent connection pool exhaustion
          let isPaired = deviceCachedPairedStatus.get(updateDeviceId) ?? false;

          // Broadcast online only on offline→online transition.
          if (!wasAlreadyLive) {
            broadcastToDevice(updateDeviceId, {
              type: 'device-online',
              deviceId: updateDeviceId,
              paired: isPaired,
              camSynced: message.camSynced,
              camDeviceId: message.camDeviceId,
              lastSeen: new Date().toISOString()
            })
          }

          try {
            if (now - lastDbUpdate > 60_000 || !deviceCachedPairedStatus.has(updateDeviceId)) {
              const updatedDevice = await prisma.device.upsert({
                where: { deviceId: updateDeviceId },
                // lastSeen is intentionally NOT written on heartbeats — only on disconnect so
                // the DB value accurately reflects "when was this device last online" rather than
                // "when did it last send a heartbeat" (which makes it always look like "Just now").
                create: { deviceId: updateDeviceId, lastSeen: new Date(), camSynced: message.camSynced, camDeviceId: message.camDeviceId },
                update: { camSynced: message.camSynced, camDeviceId: message.camDeviceId }
              })
              isPaired = updatedDevice.paired;
              deviceCachedPairedStatus.set(updateDeviceId, isPaired);
              deviceLastDbUpdateTime.set(updateDeviceId, now);
            }

            // Send acknowledgment with current paired status for sync
            ws.send(JSON.stringify({
              type: 'status-ack',
              deviceId: updateDeviceId,
              success: true,
              paired: isPaired
            }))
          } catch (error) {
            console.error(`[WebSocket] Failed to update device ${updateDeviceId}:`, error)
            ws.send(JSON.stringify({
              type: 'status-ack',
              deviceId: updateDeviceId,
              success: false,
              error: 'Database update failed'
            }))
          }
        }

        // Handle coin insertion from ESP32
        else if (message.type === 'coin-inserted' && message.deviceId) {
          const coinDeviceId = message.deviceId as string
          const coinValue = Number(message.coinValue)
          if (!Number.isFinite(coinValue) || coinValue <= 0 || coinValue > 1000) {
            console.warn(`[WebSocket] Invalid coinValue: ${message.coinValue} — rejected`)
            return
          }
          console.log(`[WebSocket] Coin: ₱${coinValue} on ${coinDeviceId}`)
          broadcastToDevice(coinDeviceId, message)
        }

        // Handle bill insertion from ESP32
        else if (message.type === 'bill-inserted' && message.deviceId) {
          const billDeviceId = message.deviceId as string
          const billValue = Number(message.billValue)
          if (!Number.isFinite(billValue) || billValue <= 0 || billValue > 1000) {
            console.warn(`[WebSocket] Invalid billValue: ${message.billValue} — rejected`)
            return
          }
          console.log(`[WebSocket] Bill: ₱${billValue} on ${billDeviceId}`)
          broadcastToDevice(billDeviceId, message)
        }

        // Handle payment system enable from frontend
        else if (message.type === 'enable-payment' && message.deviceId) {
          const paymentDeviceId = message.deviceId as string
          wsVerbose(`[WebSocket] Enable payment system on ${paymentDeviceId}`)
          // Forward to ESP32 device
          broadcastToDevice(paymentDeviceId, message)
        }

        // Handle payment system disable from frontend
        else if (message.type === 'disable-payment' && message.deviceId) {
          const paymentDeviceId = message.deviceId as string
          wsVerbose(`[WebSocket] Disable payment system on ${paymentDeviceId}`)
          // Forward to ESP32 device
          broadcastToDevice(paymentDeviceId, message)
        }

        // Handle sensor data from ESP32 (temperature & humidity)
        else if (message.type === 'sensor-data' && message.deviceId) {
          const sensorDeviceId = message.deviceId as string
          wsVerbose(
            `[WebSocket] Sensor data from ${sensorDeviceId}: Temp ${message.temperature}°C, Humidity ${message.humidity}%, CAM Synced: ${message.camSynced}, CAM ID: ${message.camDeviceId || 'NOT PROVIDED'}`
          )

          // Update camSynced and camDeviceId in database only if they changed, throttled to once per 60s.
          // sensor-data fires every 5s — unthrottled DB calls saturate the pool and leak memory.
          if (message.camSynced !== undefined || message.camDeviceId) {
            const sensorNow = Date.now()
            const lastSensorDb = deviceLastDbUpdateTime.get(sensorDeviceId) || 0
            if (sensorNow - lastSensorDb > 60_000) {
              ;(async () => {
                try {
                  const existing = await prisma.device.findUnique({
                    where: { deviceId: sensorDeviceId },
                    select: { camDeviceId: true, camSynced: true }
                  })

                  const updateData: { camSynced?: boolean; camDeviceId?: string } = {}

                  if (existing) {
                    if (message.camSynced !== undefined && existing.camSynced !== message.camSynced) {
                      updateData.camSynced = message.camSynced
                    }
                    if (message.camDeviceId && existing.camDeviceId !== message.camDeviceId) {
                      updateData.camDeviceId = message.camDeviceId as string
                      console.log(`[WebSocket] ✅ Saved CAM Device ID to database: ${message.camDeviceId}`)
                    }
                  }

                  if (Object.keys(updateData).length > 0) {
                    await prisma.device.update({
                      where: { deviceId: sensorDeviceId },
                      data: updateData
                    })
                  }
                  deviceLastDbUpdateTime.set(sensorDeviceId, sensorNow)
                } catch (error) {
                  console.error(`[WebSocket] ❌ Failed to save to database:`, error)
                }
              })()
            }
          }

          // Broadcast to all clients subscribed to this device
          broadcastToDevice(sensorDeviceId, message)
        }

        // Handle CAM sync status from ESP32 (main board)
        else if (message.type === 'cam-sync-status' && message.deviceId) {
          const syncDeviceId = message.deviceId as string
          wsVerbose(
            `[WebSocket] CAM sync status from ${syncDeviceId}: ${message.camSynced ? 'SYNCED' : 'NOT_SYNCED'}${message.camDeviceId ? `, CAM ID: ${message.camDeviceId}` : ''}`
          )

          // Update camSynced and camDeviceId in database - throttle to once per 60s
          const now = Date.now()
          const lastDbUpdate = deviceLastDbUpdateTime.get(syncDeviceId) || 0
          if (now - lastDbUpdate > 60_000) {
            ;(async () => {
              try {
                const updateData: { camSynced?: boolean; camDeviceId?: string } = { camSynced: message.camSynced }
                if (message.camDeviceId) updateData.camDeviceId = message.camDeviceId as string

                await prisma.device.update({
                  where: { deviceId: syncDeviceId },
                  data: updateData
                })
                deviceLastDbUpdateTime.set(syncDeviceId, now)
              } catch (error) {
                // Device might not exist yet, ignore
              }
            })()
          }

          // Broadcast to all clients subscribed to this device
          broadcastToDevice(syncDeviceId, message)
        }

        // Handle CAM pairing acknowledgment from ESP32 main board
        // Sent after CAM responds to pairing broadcast with PairingAck
        else if (message.type === 'cam-paired' && message.deviceId) {
          const mainDeviceId = message.deviceId as string
          const camDeviceId = message.camDeviceId as string
          const camIp = message.camIp as string | undefined
          console.log(`[WebSocket] CAM paired: ${camDeviceId} -> ${mainDeviceId}${camIp ? ` @ ${camIp}` : ''}`)

          // Update camDeviceId, camIp, and camSynced in database
          try {
            await prisma.device.update({
              where: { deviceId: mainDeviceId },
              data: {
                camDeviceId: camDeviceId,
                camSynced: true,
                ...(camIp ? { camIp } : {}),
              }
            })
          } catch (error) {
            console.error(`[WebSocket] Failed to save CAM pairing for ${mainDeviceId}:`, error)
          }

          // Broadcast to all clients subscribed to this device (tablets can react to cam sync)
          broadcastToDevice(mainDeviceId, message)
        }

        // Handle distance data from ESP32 (atomizer & foam levels)
        else if (message.type === 'distance-data' && message.deviceId) {
          const distanceDeviceId = message.deviceId as string
          wsVerbose(
            `[WebSocket] Distance data from ${distanceDeviceId}: Atomizer ${message.atomizerDistance}cm, Foam ${message.foamDistance}cm`
          )
          // Broadcast to all clients subscribed to this device
          broadcastToDevice(distanceDeviceId, message)
        }

        // Handle start-service command from frontend
        else if (message.type === 'start-service' && message.deviceId) {
          const serviceDeviceId = message.deviceId as string
          console.log(`[WebSocket] Start service on ${serviceDeviceId}: ${message.serviceType} (${message.careType})`)

          // Inject service-specific settings from DB before forwarding to firmware
          let enrichedMessage = message

          if (message.serviceType === 'drying' && message.careType) {
            try {
              const careType = message.careType as string
              const tempEntry = await prisma.dryingTemp.findFirst({ where: { careType, deviceId: serviceDeviceId } })
                .then(r => r ?? prisma.dryingTemp.findFirst({ where: { careType, deviceId: null } }))
              if (tempEntry) {
                enrichedMessage = { ...enrichedMessage, dryingTempSetpoint: tempEntry.tempC }
                wsVerbose(`[WebSocket] Injecting dryingTempSetpoint=${tempEntry.tempC} for ${careType}`)
              }
            } catch (e) {
              console.error('[WebSocket] Failed to fetch drying temp settings:', e)
            }
          }

          if (message.serviceType === 'cleaning' && message.careType) {
            try {
              const careType = message.careType as string

              const [distEntry, speedEntry] = await Promise.all([
                prisma.cleaningDistance.findFirst({ where: { careType, deviceId: serviceDeviceId } })
                  .then(r => r ?? prisma.cleaningDistance.findFirst({ where: { careType, deviceId: null } })),
                prisma.motorSpeed.findFirst({ where: { careType, deviceId: serviceDeviceId } })
                  .then(r => r ?? prisma.motorSpeed.findFirst({ where: { careType, deviceId: null } })),
              ])

              if (distEntry) {
                enrichedMessage = { ...enrichedMessage, cleaningDistanceMm: distEntry.distanceMm }
                wsVerbose(`[WebSocket] Injecting cleaningDistanceMm=${distEntry.distanceMm} for ${careType}`)
              }
              if (speedEntry) {
                enrichedMessage = { ...enrichedMessage, motorSpeedPwm: speedEntry.speedPwm }
                wsVerbose(`[WebSocket] Injecting motorSpeedPwm=${speedEntry.speedPwm} for ${careType}`)
              }
            } catch (e) {
              console.error('[WebSocket] Failed to fetch cleaning settings:', e)
            }
          }

          broadcastToDevice(serviceDeviceId, enrichedMessage)
        }

        // Kiosk back-navigation: stop running service on the device
        else if (message.type === 'stop-service' && message.deviceId) {
          const stopDeviceId = message.deviceId as string
          wsVerbose(`[WebSocket] Stop service on ${stopDeviceId}`)
          broadcastToDevice(stopDeviceId, {
            type: 'stop-service',
            deviceId: stopDeviceId,
          })
          // Mark the ACTIVE transaction for this device as ABANDONED (customer stopped early)
          prisma.transaction.updateMany({
            where: { deviceId: stopDeviceId, status: 'ACTIVE' },
            data: { status: 'ABANDONED' },
          }).catch(e => console.error('[WebSocket] Failed to mark transaction ABANDONED:', e))
        }

        // Handle service status updates from ESP32
        else if (message.type === 'service-status' && message.deviceId) {
          const statusDeviceId = message.deviceId as string
          const m = message as Record<string, unknown>
          const pct = parseServiceStatusProgress(m)
          const rem = tryParseServiceStatusRemainingSeconds(m)
          wsVerbose(
            `[WebSocket] Service status from ${statusDeviceId}: ${pct}% complete, ${rem === null ? '--' : `${rem}s`} remaining`
          )
          // Broadcast to all clients subscribed to this device
          broadcastToDevice(statusDeviceId, message)
        }

        // Handle service complete notification from ESP32
        else if (message.type === 'service-complete' && message.deviceId) {
          const completeDeviceId = message.deviceId as string
          console.log(`[WebSocket] Service complete on ${completeDeviceId}: ${message.serviceType}`)
          // Mark ACTIVE transaction as COMPLETED. Prefer matching by transactionId when the
          // firmware includes it (new firmware); fall back to deviceId match for old firmware.
          const txId = typeof message.transactionId === 'string' ? message.transactionId : null
          if (txId) {
            prisma.transaction.updateMany({
              where: { id: txId, status: 'ACTIVE' },
              data: { status: 'COMPLETED' },
            }).catch(e => console.error('[WebSocket] Failed to mark transaction COMPLETED:', e))
          } else {
            prisma.transaction.updateMany({
              where: { deviceId: completeDeviceId, status: 'ACTIVE' },
              data: { status: 'COMPLETED' },
            }).catch(e => console.error('[WebSocket] Failed to mark transaction COMPLETED:', e))
          }
          // Broadcast to all clients subscribed to this device
          broadcastToDevice(completeDeviceId, message)
        }

        // Handle power-cut interruption report from ESP32 on reconnect
        else if (message.type === 'service-interrupted' && message.deviceId) {
          const intDeviceId = message.deviceId as string
          const rawCheckpoint = message.checkpoint
          const isValidCheckpoint = (
            rawCheckpoint !== null &&
            typeof rawCheckpoint === 'object' &&
            typeof (rawCheckpoint as Record<string, unknown>).transactionId === 'string'
          )
          if (!isValidCheckpoint) {
            broadcastToDevice(intDeviceId, { type: 'skip-resume', deviceId: intDeviceId })
          } else {
            const checkpoint = rawCheckpoint as Record<string, unknown>
            const txId = checkpoint.transactionId as string
            console.log(`[WebSocket] Service interrupted on ${intDeviceId}: txid=${txId}`)
            ;(async () => {
              try {
                const tx = await prisma.transaction.findFirst({
                  where: { id: txId, deviceId: intDeviceId },
                })
                if (!tx) {
                  broadcastToDevice(intDeviceId, { type: 'skip-resume', deviceId: intDeviceId })
                  return
                }
                // Device reconnected while the kiosk banner was already showing — refresh it
                // with time adjusted for how long the banner has been waiting.
                if (tx.status === 'INTERRUPTED') {
                  const storedCkpt = tx.serviceCheckpoint as Record<string, unknown> | null
                  if (!storedCkpt) {
                    broadcastToDevice(intDeviceId, { type: 'skip-resume', deviceId: intDeviceId })
                    return
                  }
                  const origRemMs = Math.max(0, Number(storedCkpt.remainingMs) || 0)
                  const elapsedSinceInterrupt = tx.interruptedAt ? Date.now() - tx.interruptedAt.getTime() : 0
                  const adjustedRemMs = Math.max(0, origRemMs - elapsedSinceInterrupt)
                  if (adjustedRemMs < MIN_VIABLE_RESUME_MS) {
                    await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'ABANDONED' } })
                    broadcastToDevice(intDeviceId, { type: 'skip-resume', deviceId: intDeviceId })
                    return
                  }
                  // Do NOT reset interruptedAt — keep the original timestamp so resume-confirmed
                  // calculates total elapsed since the first interruption, not just since this reconnect.
                  broadcastToDevice(intDeviceId, {
                    type: 'service-interrupted',
                    deviceId: intDeviceId,
                    transactionId: tx.id,
                    checkpoint: storedCkpt,
                    remainingMs: adjustedRemMs,
                    guardExpiresAtMs: tx.interruptedAt
                      ? tx.interruptedAt.getTime() + STALE_RESUME_GUARD_MS
                      : Date.now() + STALE_RESUME_GUARD_MS,
                  })
                  return
                }
                if (tx.status !== 'ACTIVE') {
                  broadcastToDevice(intDeviceId, { type: 'skip-resume', deviceId: intDeviceId })
                  return
                }
                await prisma.transaction.update({
                  where: { id: tx.id },
                  data: {
                    status: 'INTERRUPTED',
                    interruptedAt: new Date(),
                    serviceCheckpoint: checkpoint as object,
                  },
                })
                const remainingMs = Math.max(0, Number(checkpoint.remainingMs) || 0)
                const guardExpiresAtMs = Date.now() + STALE_RESUME_GUARD_MS
                broadcastToDevice(intDeviceId, {
                  type: 'service-interrupted',
                  deviceId: intDeviceId,
                  transactionId: tx.id,
                  checkpoint,
                  remainingMs,
                  guardExpiresAtMs,
                })

                // Staleness guard: auto skip-resume if kiosk does not respond within 10 min.
                // Cancel any prior guard for this transaction (e.g. from a previous reconnect).
                const existingGuard = resumeGuardTimers.get(tx.id)
                if (existingGuard) clearTimeout(existingGuard)
                const guard = setTimeout(async () => {
                  resumeGuardTimers.delete(tx.id)
                  try {
                    // Conditional update: only wins if the tx is still INTERRUPTED.
                    // Prevents overwriting ACTIVE (set by resume-confirmed) with ABANDONED.
                    const result = await prisma.transaction.updateMany({
                      where: { id: tx.id, status: 'INTERRUPTED' },
                      data: { status: 'ABANDONED' },
                    })
                    if (result.count > 0) {
                      console.log(`[WebSocket] Staleness guard: auto skip-resume for ${intDeviceId} txid=${tx.id}`)
                      broadcastToDevice(intDeviceId, { type: 'skip-resume', deviceId: intDeviceId })
                    }
                  } catch { /* device may have reconnected and resumed already */ }
                }, STALE_RESUME_GUARD_MS)
                resumeGuardTimers.set(tx.id, guard)
              } catch (e) {
                console.error('[WebSocket] service-interrupted handler error:', e)
                broadcastToDevice(intDeviceId, { type: 'skip-resume', deviceId: intDeviceId })
              }
            })()
          }
        }

        // Kiosk sends resume-confirmed when customer taps "Resume Service"
        else if (message.type === 'resume-confirmed' && message.deviceId && message.transactionId) {
          const resumeDeviceId = message.deviceId as string
          const resumeTxId = message.transactionId as string
          console.log(`[WebSocket] Resume confirmed for ${resumeDeviceId} txid=${resumeTxId}`)

          ;(async () => {
            try {
              // Cancel staleness guard — customer responded, no need for auto skip-resume
              const guard = resumeGuardTimers.get(resumeTxId)
              if (guard) {
                clearTimeout(guard)
                resumeGuardTimers.delete(resumeTxId)
              }

              const tx = await prisma.transaction.findUnique({ where: { id: resumeTxId } })
              // Only proceed if the transaction is still waiting for a resume decision.
              // If the staleness guard already set it to ABANDONED, or it was completed/cancelled
              // by another path, bail out so we don't resurrect a dead transaction.
              if (!tx || !tx.serviceCheckpoint || tx.status !== 'INTERRUPTED') {
                broadcastToDevice(resumeDeviceId, { type: 'skip-resume', deviceId: resumeDeviceId })
                return
              }
              const ckpt = tx.serviceCheckpoint as Record<string, unknown>
              const checkpointRemMs = Math.max(0, Number(ckpt.remainingMs) || 0)
              // Subtract time elapsed since the power cut so firmware gets an accurate duration
              const elapsedSinceInterrupt = tx.interruptedAt ? Date.now() - tx.interruptedAt.getTime() : 0
              const remainingMs = Math.max(0, checkpointRemMs - elapsedSinceInterrupt)
              const careType = (ckpt.careType as string) || ''
              const serviceType = (ckpt.serviceType as string) || ''

              // Nothing meaningful left to resume — abandon instead
              if (remainingMs < MIN_VIABLE_RESUME_MS) {
                await prisma.transaction.update({
                  where: { id: resumeTxId },
                  data: { status: 'ABANDONED' },
                })
                broadcastToDevice(resumeDeviceId, { type: 'skip-resume', deviceId: resumeDeviceId })
                return
              }

              // Conditional update: only wins if tx is still INTERRUPTED.
              // Guards against the staleness guard firing between our findUnique and this update.
              const activated = await prisma.transaction.updateMany({
                where: { id: resumeTxId, status: 'INTERRUPTED' },
                data: { status: 'ACTIVE' },
              })
              if (activated.count === 0) {
                // Lost the race — staleness guard already abandoned this tx
                broadcastToDevice(resumeDeviceId, { type: 'skip-resume', deviceId: resumeDeviceId })
                return
              }

              // Fetch DB settings (same enrichment as start-service)
              let enriched: Record<string, unknown> = {
                type: 'resume-service',
                deviceId: resumeDeviceId,
                serviceType,
                shoeType: ckpt.shoeType,
                careType,
                remainingMs,
                resumeFromCycle: Number(ckpt.cyclesCompleted) || 0,
              }
              if (serviceType === 'drying') {
                const tempEntry = await prisma.dryingTemp.findFirst({ where: { careType, deviceId: resumeDeviceId } })
                  .then(r => r ?? prisma.dryingTemp.findFirst({ where: { careType, deviceId: null } }))
                if (tempEntry) enriched = { ...enriched, dryingTempSetpoint: tempEntry.tempC }
              }
              if (serviceType === 'cleaning') {
                const [distEntry, speedEntry] = await Promise.all([
                  prisma.cleaningDistance.findFirst({ where: { careType, deviceId: resumeDeviceId } })
                    .then(r => r ?? prisma.cleaningDistance.findFirst({ where: { careType, deviceId: null } })),
                  prisma.motorSpeed.findFirst({ where: { careType, deviceId: resumeDeviceId } })
                    .then(r => r ?? prisma.motorSpeed.findFirst({ where: { careType, deviceId: null } })),
                ])
                if (distEntry) enriched = { ...enriched, cleaningDistanceMm: distEntry.distanceMm }
                if (speedEntry) enriched = { ...enriched, motorSpeedPwm: speedEntry.speedPwm }
              }
              broadcastToDevice(resumeDeviceId, enriched)
            } catch (e) {
              console.error('[WebSocket] resume-confirmed handler error:', e)
              // skip-resume is broadcast below — it reaches both the firmware (clears NVS checkpoint)
              // and the kiosk (closes banner). With the checkpoint gone there is nothing left to
              // resume, so ABANDONED is the correct final state, not INTERRUPTED.
              try {
                await prisma.transaction.update({
                  where: { id: resumeTxId },
                  data: { status: 'ABANDONED' },
                })
              } catch { /* ignore secondary failure */ }
              broadcastToDevice(resumeDeviceId, { type: 'skip-resume', deviceId: resumeDeviceId })
            }
          })()
        }

        // Kiosk sends resume-declined when customer taps "Start New Service"
        else if (message.type === 'resume-declined' && message.deviceId && message.transactionId) {
          const declineDeviceId = message.deviceId as string
          const declineTxId = message.transactionId as string
          console.log(`[WebSocket] Resume declined for ${declineDeviceId} txid=${declineTxId}`)
          // Cancel staleness guard — customer already decided, no need for auto skip-resume
          const declineGuard = resumeGuardTimers.get(declineTxId)
          if (declineGuard) {
            clearTimeout(declineGuard)
            resumeGuardTimers.delete(declineTxId)
          }
          prisma.transaction.update({
            where: { id: declineTxId },
            data: { status: 'ABANDONED' },
          }).catch(e => console.error('[WebSocket] Failed to mark tx ABANDONED on decline:', e))
          broadcastToDevice(declineDeviceId, { type: 'skip-resume', deviceId: declineDeviceId })
        }

        // Device cleared its checkpoint after skip-resume — log only
        else if (message.type === 'checkpoint-cleared' && message.deviceId) {
          console.log(`[WebSocket] Checkpoint cleared on ${message.deviceId as string}`)
        }

        // ===================== ESP32-CAM MESSAGES =====================

        // Handle CAM status updates
        else if (message.type === 'cam-status' && message.deviceId) {
          const camDeviceId = message.deviceId as string
          wsVerbose(
            `[WebSocket] CAM status from ${camDeviceId}: camera=${message.cameraReady}, classifying=${message.classifying}`
          )
          // Broadcast to main board and UI clients
          // CAM device ID is SSCM-CAM-xxx, main board is SSCM-xxx
          const mainDeviceId = camDeviceId.replace('SSCM-CAM-', 'SSCM-')
          broadcastToDevice(mainDeviceId, message)
          broadcastToDevice(camDeviceId, message)
        }

        // Handle classification request from tablet/frontend
        // New flow: forward to main board, which triggers CAM via ESP-NOW direct path
        else if ((message.type === 'start-classification' || message.type === 'request-classification') && message.deviceId) {
          const requestDeviceId = message.deviceId as string

          // Normalise to main board ID (strip SSCM-CAM- prefix if tablet sent CAM id by mistake)
          const mainDeviceId = requestDeviceId.startsWith('SSCM-CAM-')
            ? requestDeviceId.replace('SSCM-CAM-', 'SSCM-')
            : requestDeviceId

          console.log(`[WebSocket] Classification request → main board: ${mainDeviceId}`)
          broadcastToDevice(mainDeviceId, {
            type: 'start-classification',
            deviceId: mainDeviceId
          })
        }

        // Handle classification result — now sent by main board (relayed from CAM via ESP-NOW)
        // Backward compat: also handles old path where CAM sent directly (SSCM-CAM-xxx)
        else if (message.type === 'classification-result' && message.deviceId) {
          const sourceId = message.deviceId as string
          const confPct =
            typeof message.confidence === 'number' && Number.isFinite(message.confidence)
              ? `${(message.confidence * 100).toFixed(1)}%`
              : 'n/a'
          console.log(`[WebSocket] Classification result from ${sourceId}: ${message.result} (${confPct})`)

          if (sourceId.startsWith('SSCM-CAM-')) {
            // Old path: CAM sent directly (backward compat)
            const mainDeviceId = sourceId.replace('SSCM-CAM-', 'SSCM-')
            broadcastToDevice(mainDeviceId, message)
          } else {
            // New path: main board relayed the result — broadcast to all tablet subscribers
            broadcastToDevice(sourceId, message)
          }
        }

        // Handle classification error — now sent by main board on behalf of CAM
        else if (message.type === 'classification-error' && message.deviceId) {
          const sourceId = message.deviceId as string
          console.warn(`[WebSocket] Classification error from ${sourceId}: ${message.error}`)

          const targetId = sourceId.startsWith('SSCM-CAM-')
            ? sourceId.replace('SSCM-CAM-', 'SSCM-')
            : sourceId
          broadcastToDevice(targetId, message)
        }

        // Handle classification started (kept for backward compat with old CAM firmware)
        else if (message.type === 'classification-started' && message.deviceId) {
          const sourceId = message.deviceId as string
          const mainId = sourceId.startsWith('SSCM-CAM-')
            ? sourceId.replace('SSCM-CAM-', 'SSCM-')
            : sourceId
          console.log(`[WebSocket] Classification started on ${mainId}`)
          broadcastToDevice(mainId, message)
        }

        // Handle classification busy (backward compat)
        else if (message.type === 'classification-busy' && message.deviceId) {
          const sourceId = message.deviceId as string
          const mainId = sourceId.startsWith('SSCM-CAM-')
            ? sourceId.replace('SSCM-CAM-', 'SSCM-')
            : sourceId
          console.log(`[WebSocket] Classification busy on ${mainId}`)
          broadcastToDevice(mainId, message)
        }

        // Handle enable-classification (page enter) from frontend
        else if (message.type === 'enable-classification' && message.deviceId) {
          const mainDeviceId = message.deviceId as string
          wsVerbose(`[WebSocket] Classification page entered, enabling LED for ${mainDeviceId}`)
          broadcastToDevice(mainDeviceId, {
            type: 'enable-classification',
            deviceId: mainDeviceId
          })
        }

        // Handle disable-classification (page leave) from frontend
        else if (message.type === 'disable-classification' && message.deviceId) {
          const mainDeviceId = message.deviceId as string
          wsVerbose(`[WebSocket] Classification page exited, disabling LED for ${mainDeviceId}`)
          broadcastToDevice(mainDeviceId, {
            type: 'disable-classification',
            deviceId: mainDeviceId
          })
        }

        // Handle restart-device command from admin
        else if (message.type === 'restart-device' && message.deviceId) {
          const restartDeviceId = message.deviceId as string
          console.log(`[WebSocket] Restart requested for ${restartDeviceId}`)
          // Forward to ESP32 device
          broadcastToDevice(restartDeviceId, {
            type: 'restart-device',
            deviceId: restartDeviceId
          })
        }

        // Handle serial-command from dashboard — forward raw command to device
        else if (message.type === 'serial-command' && message.deviceId && message.command) {
          const targetId = message.deviceId as string
          const command = String(message.command).slice(0, 256) // length guard
          console.log(`[WebSocket] Serial command → ${targetId}: ${command}`)
          broadcastToDevice(targetId, {
            type: 'serial-command',
            deviceId: targetId,
            command,
          })
        }

        // Handle graceful offline intent from ESP32 before restart/disconnect.
        else if (message.type === 'going-offline' && message.deviceId) {
          const offlineDeviceId = message.deviceId as string
          const pending = devicePendingOfflineTimers.get(offlineDeviceId)
          if (pending) {
            clearTimeout(pending)
            devicePendingOfflineTimers.delete(offlineDeviceId)
          }
          if (deviceLiveConnections.get(offlineDeviceId) === ws) {
            deviceLiveConnections.delete(offlineDeviceId)
            deviceLastStatusTime.delete(offlineDeviceId)
            // Clear DB throttle clock so the first status-update after reconnect re-fetches
            // camSynced/camDeviceId from DB instead of serving a potentially stale cached value.
            deviceLastDbUpdateTime.delete(offlineDeviceId)
            console.log(`[WebSocket] ESP32 graceful offline: ${offlineDeviceId} — broadcasting offline status`)
            broadcastToDevice(offlineDeviceId, { type: 'device-offline', deviceId: offlineDeviceId })
            // Write lastSeen now so the dashboard shows the correct "last seen" time after disconnect
            prisma.device.update({ where: { deviceId: offlineDeviceId }, data: { lastSeen: new Date() } }).catch(() => {})
          }
        }

        // Handle relay state change from ESP32 — forward to dashboard subscribers
        else if (message.type === 'relay-status' && message.deviceId) {
          broadcastToDevice(message.deviceId as string, message)
        }

        // Handle all-relays-off from ESP32 — forward to dashboard subscribers
        else if (message.type === 'all-relays-off' && message.deviceId) {
          broadcastToDevice(message.deviceId as string, message)
        }

        // Forward firmware log messages to kiosk subscribers
        else if (message.type === 'firmware-log' && message.deviceId) {
          broadcastToDevice(message.deviceId as string, message)
        }

        // Unknown message type
        else {
          console.warn(`[WebSocket] Unknown message type: ${message.type} from ${deviceId || 'unknown'}`)
        }
      } catch (error) {
        console.error('[WebSocket] Error parsing message:', error)
      }
    })

    ws.on('close', () => {
      // Remove connection from all subscriptions
      if (deviceId) {
        const closedDeviceId = deviceId
        const connections = deviceConnections.get(closedDeviceId)
        if (connections) {
          connections.delete(ws)
          if (connections.size === 0) {
            deviceConnections.delete(closedDeviceId)
          }
        }
        // If the ESP32 device itself disconnected, clean up live connection tracking and
        // broadcast offline immediately for faster UI sync on deliberate restarts/unpair.
        if (isDeviceWsClient) {
          if (deviceLiveConnections.get(closedDeviceId) === ws) {
            deviceLiveConnections.delete(closedDeviceId)
            const pending = setTimeout(() => {
              // Debounce close events to avoid offline/online flaps on quick reconnect.
              // 15s window: ESP32 needs 5s reconnect delay + up to 10s for TLS handshake
              // on production (Render). If a new status-update arrives, the timer is
              // cancelled in the message handler — so healthy reconnects never fire this.
              const liveWs = deviceLiveConnections.get(closedDeviceId)
              if (!liveWs || liveWs.readyState !== WebSocket.OPEN) {
                deviceLastStatusTime.delete(closedDeviceId)
                console.log(`[WebSocket] ESP32 device disconnected: ${closedDeviceId} — broadcasting offline status`)
                broadcastToDevice(closedDeviceId, { type: 'device-offline', deviceId: closedDeviceId })
                // Write lastSeen at the moment of confirmed disconnect
                prisma.device.update({ where: { deviceId: closedDeviceId }, data: { lastSeen: new Date() } }).catch(() => {})
              }
              devicePendingOfflineTimers.delete(closedDeviceId)
            }, 15_000)
            devicePendingOfflineTimers.set(closedDeviceId, pending)
          } else {
            console.log(`[WebSocket] Stale ESP32 connection closed: ${closedDeviceId} — ignoring since a newer connection exists`)
          }
        }
        // When no subscribers remain for a device (ESP32 + all browser clients gone),
        // clean up caches that the deviceTimeoutInterval won't reach for graceful disconnects.
        const remainingConnections = deviceConnections.get(closedDeviceId)
        if (!remainingConnections || remainingConnections.size === 0) {
          const pending = devicePendingOfflineTimers.get(closedDeviceId)
          if (pending) {
            clearTimeout(pending)
            devicePendingOfflineTimers.delete(closedDeviceId)
          }
          deviceCachedPairedStatus.delete(closedDeviceId)
          deviceLastDbUpdateTime.delete(closedDeviceId)
          deviceLastStatusTime.delete(closedDeviceId)
        }
        wsVerbose(`[WebSocket] [${isDeviceWsClient ? 'esp32' : connLabel}] unsubscribed from device: ${closedDeviceId}`)
      }
    })

    ws.on('error', (error) => {
      console.error('[WebSocket] Connection error:', error)
    })
  })

  return wss
}

// Generic broadcast function
function broadcastToDevice(deviceId: string, message: any) {
  const connections = deviceConnections.get(deviceId)
  if (connections && connections.size > 0) {
    const messageStr = JSON.stringify(message)
    connections.forEach((ws) => {
      // PROACTIVELY PRUNE ZOMBIE CONNECTIONS
      // If a socket is closed but somehow still in our Set, remove it now.
      // This prevents the memory leak that leads to Render "exceeded memory limit" crashes.
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connections.delete(ws)
        return
      }

      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(messageStr)
        } catch (err) {
          // Socket closed between readyState check and send — safe to ignore
          console.warn(`[WebSocket] Send failed for ${deviceId}:`, err)
        }
      }
    })
  }
}

// Returns true if the device has an open live WebSocket connection right now.
// Used by the status REST endpoint to report real-time online state without
// relying on the stale lastSeen DB timestamp.
export function isDeviceLive(deviceId: string): boolean {
  const liveWs = deviceLiveConnections.get(deviceId)
  return !!liveWs && liveWs.readyState === WebSocket.OPEN
}

// Broadcast restart command to ESP32
export function broadcastRestartDevice(deviceId: string) {
  broadcastToDevice(deviceId, {
    type: 'restart-device',
    deviceId
  })
}

// Broadcast device status update to all subscribed clients
export function broadcastDeviceUpdate(deviceId: string, data: {
  paired: boolean
  pairedAt: Date | null
  deviceName?: string | null
  pairingCode?: string | null
  groupToken?: string | null
}) {
  // Sync the local cache immediately so the next status-update 
  // from the device gets the correct value without waiting for DB throttle
  deviceCachedPairedStatus.set(deviceId, data.paired);
  deviceLastDbUpdateTime.set(deviceId, Date.now());

  broadcastToDevice(deviceId, {
    type: 'device-update',
    deviceId,
    data: {
      paired: data.paired,
      pairedAt: data.pairedAt,
      deviceName: data.deviceName,
      pairingCode: data.paired ? null : (data.pairingCode ?? null),
      groupToken: data.paired ? (data.groupToken ?? null) : null,
    }
  })
}

// Broadcast classification result to all subscribed clients (tablets)
export function broadcastClassificationResult(
  deviceId: string,
  result: string,
  confidence: number,
  subCategory: string = '',
  condition: 'normal' | 'too_dirty' = 'normal',
  snapshotBase64?: string
) {
  console.log(
    `[Classify:Live] Emit classification-result -> ${deviceId}: ${result} (${(confidence * 100).toFixed(1)}%), subCategory="${subCategory}", condition=${condition}, snapshot=${snapshotBase64 ? 'yes' : 'no'}`
  )
  broadcastToDevice(deviceId, {
    type: 'classification-result',
    deviceId,
    result,
    confidence,
    subCategory,
    condition,
    ...(snapshotBase64 ? { snapshotBase64 } : {}),
  })
}

// Broadcast payment success to kiosk tablet — triggers navigation to success page
export function broadcastPaymentSuccess(deviceId: string, transactionId: string, amount: number) {
  broadcastToDevice(deviceId, {
    type: 'payment-success',
    deviceId,
    transactionId,
    amount,
  })
}

// Broadcast classification error to all subscribed clients (tablets)
export function broadcastClassificationError(deviceId: string, error: string) {
  // Sanitize error message — don't forward raw error strings from devices
  const sanitizedError = typeof error === 'string' && error.length < 200
    ? error
    : 'Classification failed'
  console.warn(`[Classify:Live] Emit classification-error -> ${deviceId}: ${sanitizedError}`)
  broadcastToDevice(deviceId, {
    type: 'classification-error',
    deviceId,
    error: sanitizedError,
  })
}
