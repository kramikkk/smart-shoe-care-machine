import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import type { Server } from 'http'
import type { Duplex } from 'stream'
import prisma from './prisma'

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

// Offline after 3 missed status-update cycles (ESP32 sends every 5s → 15s threshold).
// Using 3x the send interval prevents false offline events caused by normal network jitter.
// A 1ms race between the timeout interval and an in-flight status-update was causing
// the device to flicker offline every ~5s, clearing sensor data and disrupting sync.
const DEVICE_STATUS_TIMEOUT_MS = 15_000

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

  // Heartbeat: ping every 15s, terminate connections that don't pong back.
  // This cleans up dead TCP connections (e.g. network drop without FIN) that
  // would otherwise accumulate in deviceConnections with readyState === OPEN.
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket & { _isAlive?: boolean }) => {
      if (ws._isAlive === false) {
        ws.terminate()
        return
      }
      ws._isAlive = false
      ws.ping()
    })
  }, 15_000)
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
        broadcastToDevice(devId, { type: 'device-offline', deviceId: devId })
      }
    })
  }, 5_000)
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
    console.log(`[WebSocket] New connection from ${connSource}`)
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
      console.log(`[WebSocket] [${connLabel}] auto-subscribed to device: ${deviceId}`);

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
             console.log(`[WebSocket] New device identified (not in DB): ${deviceId}`)
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

          console.log(`[WebSocket] [${connLabel}] subscribed to device: ${subscribeDeviceId}`)

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
          // Also send device-online from DB lastSeen as a fallback for the case where
          // the server just cold-started and deviceLiveConnections is empty but the
          // ESP32 was recently active (e.g. Render cold start, brief server restart).
          ;(async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

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

                // DB-based device-online fallback: if the in-memory live connection map
                // is empty (server just cold-started) but the device was seen recently,
                // tell the joining client the device is likely online. Use a 30s window —
                // wide enough to survive a Render cold start + ESP32 reconnect cycle.
                const secondsSinceLastSeen = device.lastSeen
                  ? (Date.now() - new Date(device.lastSeen).getTime()) / 1000
                  : Infinity
                if (secondsSinceLastSeen < 30 && !deviceLiveConnections.has(subscribeDeviceId)) {
                  ws.send(JSON.stringify({
                    type: 'device-online',
                    deviceId: subscribeDeviceId,
                    paired: device.paired,
                    lastSeen: device.lastSeen?.toISOString()
                  }))
                }
              }
            } catch (err) {
              console.warn(`[WebSocket] Could not push initial device state for ${subscribeDeviceId}`)
            } finally {
              clearTimeout(timeout)
            }
          })()
        }

        // Handle device status update from ESP32
        else if (message.type === 'status-update' && message.deviceId) {
          const updateDeviceId = message.deviceId as string

          // Mark this connection as an actual ESP32 device — only firmware sends status-update.
          // This is used by the close handler to decide whether to broadcast device-offline.
          if (!isDeviceWsClient) {
            console.log(`[WebSocket] ESP32 identified: ${updateDeviceId}`)
          }
          // Track whether this device was already considered online before this message.
          // Used below to decide whether to broadcast device-online (only on transition).
          const wasAlreadyLive = deviceLiveConnections.has(updateDeviceId)

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

          // Silence status-update logging unless there's a change or it's the first time
          if (now - lastDbUpdate > 60_000 || !deviceCachedPairedStatus.has(updateDeviceId)) {
            console.log(`[WebSocket] Status heartbeat from device: ${updateDeviceId}`)
          }

          // Update lastSeen in database and get current paired status
          // Throttle database writes to once every 60 seconds to prevent connection pool exhaustion
          let isPaired = deviceCachedPairedStatus.get(updateDeviceId) ?? false;

          // Only broadcast device-online on the transition from offline→online.
          // Skipping the broadcast on every 5s heartbeat prevents React re-renders and
          // spurious state updates in all subscribed browser clients.
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
                create: { deviceId: updateDeviceId, lastSeen: new Date(), camSynced: message.camSynced, camDeviceId: message.camDeviceId },
                update: { lastSeen: new Date(), camSynced: message.camSynced, camDeviceId: message.camDeviceId }
              })
              isPaired = updatedDevice.paired;
              deviceCachedPairedStatus.set(updateDeviceId, isPaired);
              deviceLastDbUpdateTime.set(updateDeviceId, now);

              // Re-broadcast with confirmed paired status from DB only if this was a
              // transition (first status-update after coming online or after cold start).
              if (!wasAlreadyLive) {
                broadcastToDevice(updateDeviceId, {
                  type: 'device-online',
                  deviceId: updateDeviceId,
                  paired: isPaired,
                  lastSeen: new Date().toISOString()
                })
              }
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
          console.log(`[WebSocket] Enable payment system on ${paymentDeviceId}`)
          // Forward to ESP32 device
          broadcastToDevice(paymentDeviceId, message)
        }

        // Handle payment system disable from frontend
        else if (message.type === 'disable-payment' && message.deviceId) {
          const paymentDeviceId = message.deviceId as string
          console.log(`[WebSocket] Disable payment system on ${paymentDeviceId}`)
          // Forward to ESP32 device
          broadcastToDevice(paymentDeviceId, message)
        }

        // Handle sensor data from ESP32 (temperature & humidity)
        else if (message.type === 'sensor-data' && message.deviceId) {
          const sensorDeviceId = message.deviceId as string
          console.log(`[WebSocket] Sensor data from ${sensorDeviceId}: Temp ${message.temperature}°C, Humidity ${message.humidity}%, CAM Synced: ${message.camSynced}, CAM ID: ${message.camDeviceId || 'NOT PROVIDED'}`)

          // Update camSynced and camDeviceId in database only if they changed
          if (message.camSynced !== undefined || message.camDeviceId) {
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
            } catch (error) {
              console.error(`[WebSocket] ❌ Failed to save to database:`, error)
            }
          }

          // Broadcast to all clients subscribed to this device
          broadcastToDevice(sensorDeviceId, message)
        }

        // Handle CAM sync status from ESP32 (main board)
        else if (message.type === 'cam-sync-status' && message.deviceId) {
          const syncDeviceId = message.deviceId as string
          console.log(`[WebSocket] CAM sync status from ${syncDeviceId}: ${message.camSynced ? 'SYNCED' : 'NOT_SYNCED'}${message.camDeviceId ? `, CAM ID: ${message.camDeviceId}` : ''}`)

          // Update camSynced and camDeviceId in database - throttle to once per 60s
          const now = Date.now()
          const lastDbUpdate = deviceLastDbUpdateTime.get(syncDeviceId) || 0
          if (now - lastDbUpdate > 60_000) {
            ;(async () => {
               const controller = new AbortController();
               const timeout = setTimeout(() => controller.abort(), 10000);
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
              } finally {
                clearTimeout(timeout)
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
          console.log(`[WebSocket] Distance data from ${distanceDeviceId}: Atomizer ${message.atomizerDistance}cm, Foam ${message.foamDistance}cm`)
          // Broadcast to all clients subscribed to this device
          broadcastToDevice(distanceDeviceId, message)
        }

        // Handle start-service command from frontend
        else if (message.type === 'start-service' && message.deviceId) {
          const serviceDeviceId = message.deviceId as string
          console.log(`[WebSocket] Start service on ${serviceDeviceId}: ${message.serviceType} (${message.careType})`)

          // Inject cleaning distance (mm) for cleaning service so firmware uses DB value
          let enrichedMessage = message
          if (message.serviceType === 'cleaning' && message.careType) {
            try {
              const { PrismaClient } = await import('@prisma/client')
              const p = new PrismaClient()
              const entry = await p.cleaningDistance.findFirst({
                where: {
                  careType: message.careType as string,
                  deviceId: serviceDeviceId,
                },
              }) || await p.cleaningDistance.findFirst({
                where: { careType: message.careType as string, deviceId: null },
              })
              await p.$disconnect()
              if (entry) {
                enrichedMessage = { ...message, cleaningDistanceMm: entry.distanceMm }
                console.log(`[WebSocket] Injecting cleaningDistanceMm=${entry.distanceMm} for ${message.careType}`)
              }
            } catch (e) {
              console.error('[WebSocket] Failed to fetch cleaning distance:', e)
            }
          }

          broadcastToDevice(serviceDeviceId, enrichedMessage)
        }

        // Handle service status updates from ESP32
        else if (message.type === 'service-status' && message.deviceId) {
          const statusDeviceId = message.deviceId as string
          console.log(`[WebSocket] Service status from ${statusDeviceId}: ${message.progress}% complete, ${message.timeRemaining}s remaining`)
          // Broadcast to all clients subscribed to this device
          broadcastToDevice(statusDeviceId, message)
        }

        // Handle service complete notification from ESP32
        else if (message.type === 'service-complete' && message.deviceId) {
          const completeDeviceId = message.deviceId as string
          console.log(`[WebSocket] Service complete on ${completeDeviceId}: ${message.serviceType}`)
          // Broadcast to all clients subscribed to this device
          broadcastToDevice(completeDeviceId, message)
        }

        // ===================== ESP32-CAM MESSAGES =====================

        // Handle CAM status updates
        else if (message.type === 'cam-status' && message.deviceId) {
          const camDeviceId = message.deviceId as string
          console.log(`[WebSocket] CAM status from ${camDeviceId}: camera=${message.cameraReady}, classifying=${message.classifying}`)
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
          console.log(`[WebSocket] Classification result from ${sourceId}: ${message.result} (${(message.confidence * 100).toFixed(1)}%)`)

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
          console.log(`[WebSocket] Classification error from ${sourceId}: ${message.error}`)

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
          console.log(`[WebSocket] Classification page entered, enabling LED for ${mainDeviceId}`)
          broadcastToDevice(mainDeviceId, {
            type: 'enable-classification',
            deviceId: mainDeviceId
          })
        }

        // Handle disable-classification (page leave) from frontend
        else if (message.type === 'disable-classification' && message.deviceId) {
          const mainDeviceId = message.deviceId as string
          console.log(`[WebSocket] Classification page exited, disabling LED for ${mainDeviceId}`)
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
        const connections = deviceConnections.get(deviceId)
        if (connections) {
          connections.delete(ws)
          if (connections.size === 0) {
            deviceConnections.delete(deviceId)
          }
        }
        // If the ESP32 device itself disconnected, clean up live connection tracking.
        // Do NOT broadcast device-offline here — let the deviceTimeoutInterval handle it
        // after DEVICE_STATUS_TIMEOUT_MS of silence. This prevents false offline flashes
        // when the ESP32 briefly drops and reconnects within its 5s reconnect window:
        // the timeout won't fire if a fresh status-update arrives before the threshold.
        if (isDeviceWsClient) {
          if (deviceLiveConnections.get(deviceId) === ws) {
            deviceLiveConnections.delete(deviceId)
            // Leave deviceLastStatusTime intact — the timeout uses it to decide when to
            // actually fire device-offline. If the ESP32 reconnects quickly, it will
            // overwrite deviceLastStatusTime via status-update before the threshold.
            console.log(`[WebSocket] ESP32 device disconnected: ${deviceId} — waiting for timeout or reconnect`)
          } else {
            console.log(`[WebSocket] Stale ESP32 connection closed: ${deviceId} — ignoring since a newer connection exists`)
          }
        }
        console.log(`[WebSocket] [${isDeviceWsClient ? 'esp32' : connLabel}] unsubscribed from device: ${deviceId}`)
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
  broadcastToDevice(deviceId, {
    type: 'classification-error',
    deviceId,
    error: sanitizedError,
  })
}
