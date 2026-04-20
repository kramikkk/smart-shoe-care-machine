'use client'

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import {
  parseServiceStatusActive,
  parseServiceStatusProgress,
  tryParseServiceStatusRemainingSeconds,
} from '@/lib/service-status-fields'
import { useDeviceFilter, SELECTED_DEVICE_KEY } from './DeviceFilterContext'

// Re-export deriveAlerts so SystemAlertCard can use the same logic
export type AlertSeverity = 'critical' | 'warning' | 'info'

export type DerivedAlert = {
  id: string          // stable alertKey, e.g. 'atomizer-critical'
  severity: AlertSeverity
  title: string
  description: string
}

export type MessageHandler = (msg: Record<string, unknown>) => void

const MIN_DIST = 8
const MAX_DIST = 21
const TANK_MAX_LITERS = 5.0

function distanceToPercent(distance: number): number {
  const d = Math.min(Math.max(distance, MIN_DIST), MAX_DIST)
  return ((MAX_DIST - d) / (MAX_DIST - MIN_DIST)) * 100
}

function distanceToLiters(distance: number): number {
  return (distanceToPercent(distance) / 100) * TANK_MAX_LITERS
}

export function deriveAlerts(sensorData: SensorData, isConnected: boolean): DerivedAlert[] {
  const alerts: DerivedAlert[] = []

  if (sensorData.atomizerDistance === -1 || sensorData.atomizerDistance > 21) {
    alerts.push({
      id: 'atomizer-invalid',
      severity: 'warning',
      title: 'Atomizer Sensor Invalid',
      description: 'Atomizer level sensor returned an invalid reading. Check sensor connection.',
    })
  } else {
    const atomizerPct = distanceToPercent(sensorData.atomizerDistance)
    const atomizerL = distanceToLiters(sensorData.atomizerDistance)
    if (atomizerPct < 20) {
      alerts.push({
        id: 'atomizer-critical',
        severity: 'critical',
        title: 'Atomizer Water Critical',
        description: `Atomizer tank is critically low (${atomizerL.toFixed(1)}L). Refill immediately.`,
      })
    } else if (atomizerPct < 40) {
      alerts.push({
        id: 'atomizer-warning',
        severity: 'warning',
        title: 'Atomizer Water Low',
        description: `Atomizer tank is running low (${atomizerL.toFixed(1)}L). Consider refilling soon.`,
      })
    }
  }

  if (sensorData.foamDistance === -1 || sensorData.foamDistance > 21) {
    alerts.push({
      id: 'foam-invalid',
      severity: 'warning',
      title: 'Foam Sensor Invalid',
      description: 'Foam level sensor returned an invalid reading. Check sensor connection.',
    })
  } else {
    const foamPct = distanceToPercent(sensorData.foamDistance)
    const foamL = distanceToLiters(sensorData.foamDistance)
    if (foamPct < 20) {
      alerts.push({
        id: 'foam-critical',
        severity: 'critical',
        title: 'Foam Solution Critical',
        description: `Foam solution tank is critically low (${foamL.toFixed(1)}L). Refill immediately.`,
      })
    } else if (foamPct < 40) {
      alerts.push({
        id: 'foam-warning',
        severity: 'warning',
        title: 'Foam Solution Low',
        description: `Foam solution tank is running low (${foamL.toFixed(1)}L). Consider refilling soon.`,
      })
    }
  }

  if (sensorData.temperature === -1) {
    alerts.push({
      id: 'temp-invalid',
      severity: 'warning',
      title: 'Temperature Sensor Invalid',
      description: 'DHT11 returned an invalid temperature reading. Check sensor connection.',
    })
  } else if (sensorData.temperature > 0) {
    if (sensorData.temperature > 50) {
      alerts.push({
        id: 'temp-critical',
        severity: 'critical',
        title: 'Temperature Critical',
        description: `Chamber temperature is dangerously high (${sensorData.temperature.toFixed(1)}°C). Check ventilation.`,
      })
    } else if (sensorData.temperature > 45) {
      alerts.push({
        id: 'temp-high',
        severity: 'warning',
        title: 'High Temperature',
        description: `Chamber temperature is elevated (${sensorData.temperature.toFixed(1)}°C).`,
      })
    }
  }

  if (sensorData.humidity === -1) {
    alerts.push({
      id: 'humidity-invalid',
      severity: 'warning',
      title: 'Humidity Sensor Invalid',
      description: 'DHT11 returned an invalid humidity reading. Check sensor connection.',
    })
  } else if (sensorData.humidity > 0 && sensorData.humidity > 50) {
    alerts.push({
      id: 'humidity-high',
      severity: 'warning',
      title: 'High Humidity',
      description: `Chamber humidity is high (${sensorData.humidity.toFixed(1)}%). May affect drying performance.`,
    })
  }

  return alerts
}

type SensorData = {
  temperature: number
  humidity: number
  atomizerDistance: number
  foamDistance: number
  lastUpdate: Date | null
  serviceActive: boolean
  serviceType: string
  serviceProgress: number
  /** Seconds left from firmware; `null` when payload omits time — show "--" in UI */
  serviceTimeRemaining: number | null
  camSynced: boolean
}

interface DashboardWebSocketContextType {
  sensorData: SensorData
  isConnected: boolean
  isLoadingData: boolean
  alertRefreshSignal: number
  sendMessage: (msg: Record<string, unknown>) => boolean
  addMessageHandler: (handler: MessageHandler) => () => void
}

const DashboardWebSocketContext = createContext<DashboardWebSocketContextType | undefined>(undefined)

const DEFAULT_SENSOR_DATA: SensorData = {
  temperature: 0,
  humidity: 0,
  atomizerDistance: 0,
  foamDistance: 0,
  lastUpdate: null,
  serviceActive: false,
  serviceType: '',
  serviceProgress: 0,
  serviceTimeRemaining: null,
  camSynced: false,
}

export function DashboardWebSocketProvider({ children }: { children: React.ReactNode }) {
  // Read selectedDevice directly — DeviceFilterContext propagates the same
  // localStorage value but only after a render cycle. Reading it here lets
  // the WS connect on the very first render without waiting for context.
  const { selectedDevice: contextDevice } = useDeviceFilter()
  const selectedDevice = contextDevice ||
    (typeof window !== 'undefined' ? (localStorage.getItem(SELECTED_DEVICE_KEY) ?? '') : '')

  // Keep a ref to the latest sensor data so cleanup can read it without stale closures
  const sensorDataRef = useRef<SensorData>(DEFAULT_SENSOR_DATA)
  // Track previous alert keys to detect transitions
  const prevAlertKeysRef = useRef<Set<string>>(new Set())
  // Debounce alert sync to avoid firing on every rapid sensor tick
  const alertSyncTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const connectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const dataTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const messageHandlersRef = useRef<Set<MessageHandler>>(new Set())

  const [sensorData, setSensorData] = useState<SensorData>(DEFAULT_SENSOR_DATA)
  const [isConnected, setIsConnected] = useState(false)
  const [isLoadingData, setIsLoadingData] = useState(false)
  const [alertRefreshSignal, setAlertRefreshSignal] = useState(0)

  const syncAlertsToDb = useCallback(
    (currentSensorData: SensorData, currentIsConnected: boolean) => {
      if (!selectedDevice) return

      if (alertSyncTimeoutRef.current) clearTimeout(alertSyncTimeoutRef.current)

      alertSyncTimeoutRef.current = setTimeout(async () => {
        const currentAlerts = deriveAlerts(currentSensorData, currentIsConnected)
        const currentKeys = new Set(currentAlerts.map(a => a.id))
        const prevKeys = prevAlertKeysRef.current

        // Appeared: in current but not in prev
        const appeared = currentAlerts.filter(a => !prevKeys.has(a.id))

        // Update tracking — cleared conditions are removed so re-appearance triggers POST again
        prevAlertKeysRef.current = currentKeys

        // POST new alerts — server dedup prevents duplicates while alert is unresolved
        let hadNewAlert = false
        for (const alert of appeared) {
          try {
            const res = await fetch(`/api/device/${selectedDevice}/alerts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                alertKey: alert.id,
                severity: alert.severity,
                title: alert.title,
                description: alert.description,
              }),
            })
            if (res.status === 201) hadNewAlert = true
          } catch {
            // Non-critical — sensor data still flows
          }
        }

        // Signal SystemAlertCard to refresh only when a genuinely new alert was created
        if (hadNewAlert) {
          setAlertRefreshSignal(s => s + 1)
        }
      }, 2000) // 2s debounce — prevents rapid-fire on fast sensor ticks
    },
    [selectedDevice]
  )

  // Keep ref current so the WS effect can call syncAlertsToDb without it being
  // in the effect's dependency array — prevents WS teardown/reconnect on re-render.
  const syncAlertsToDbRef = useRef(syncAlertsToDb)
  useEffect(() => { syncAlertsToDbRef.current = syncAlertsToDb }, [syncAlertsToDb])

  useEffect(() => {
    if (!selectedDevice) return

    reconnectAttemptsRef.current = 0

    // PARALLEL SYNC: Start the WebSocket connection immediately while the fetch check is running.
    // This removes 500ms-2s of delay before real-time data starts flowing.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/ws?deviceId=${encodeURIComponent(selectedDevice)}&source=dashboard`
    
    // REST check (kept for robust offline checking)
    fetch(`/api/device/${encodeURIComponent(selectedDevice)}/status`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then((data: { online?: boolean } | null) => { if (data?.online) setIsConnected(true) })
      .catch(() => {})

    let ws: WebSocket

    const connect = () => {
      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      // Avoid hanging forever in CONNECTING on flaky networks.
      // 20s: Render free tier cold-starts take 15-30s (TLS + server wake-up).
      // A 6s timeout was causing premature close → "WebSocket is closed before
      // the connection is established" browser error on every cold-start visit.
      if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current)
      connectTimeoutRef.current = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onclose = null  // prevent the close from scheduling a second reconnect
          ws.onerror = null  // (reconnect is handled below after the close)
          try { ws.close() } catch {}
          wsRef.current = null
          reconnectAttemptsRef.current++
          const delay = Math.min(3000 * Math.pow(2, reconnectAttemptsRef.current - 1), 30000)
          reconnectTimeoutRef.current = setTimeout(() => connect(), delay)
        }
      }, 20000)

      ws.onopen = () => {
        if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
        reconnectAttemptsRef.current = 0
        // Don't set isConnected here — only device-online message confirms the device is alive
        setIsLoadingData(true)
        ws.send(JSON.stringify({ type: 'subscribe', deviceId: selectedDevice }))
        // Give device 10s to send first data; if nothing arrives, stop loading
        if (dataTimeoutRef.current) clearTimeout(dataTimeoutRef.current)
        dataTimeoutRef.current = setTimeout(() => setIsLoadingData(false), 10000)
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          const messageDeviceId = typeof message.deviceId === 'string' ? message.deviceId : null
          const isDeviceScopedMessage = !!messageDeviceId
          if (isDeviceScopedMessage && messageDeviceId !== selectedDevice) {
            return
          }

          if (message.type === 'sensor-data') {
            if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
            setIsLoadingData(false)
            setSensorData(prev => {
              const next = {
                ...prev,
                temperature: message.temperature ?? prev.temperature,
                humidity: message.humidity ?? prev.humidity,
                camSynced: message.camSynced !== undefined ? message.camSynced : prev.camSynced,
                lastUpdate: new Date(),
              }
              sensorDataRef.current = next
              syncAlertsToDbRef.current(next, true)
              return next
            })
          }

          if (message.type === 'cam-sync-status') {
            if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
            setIsLoadingData(false)
            setSensorData(prev => {
              const next = { ...prev, camSynced: message.camSynced, lastUpdate: new Date() }
              sensorDataRef.current = next
              syncAlertsToDbRef.current(next, true)
              return next
            })
          }

          if (message.type === 'distance-data') {
            if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
            setIsLoadingData(false)
            setSensorData(prev => {
              const next = {
                ...prev,
                atomizerDistance: message.atomizerDistance ?? prev.atomizerDistance,
                foamDistance: message.foamDistance ?? prev.foamDistance,
                lastUpdate: new Date(),
              }
              sensorDataRef.current = next
              syncAlertsToDbRef.current(next, true)
              return next
            })
          }

          if (message.type === 'service-status') {
            if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
            setIsLoadingData(false)
            const m = message as Record<string, unknown>
            setSensorData(prev => ({
              ...prev,
              serviceActive: parseServiceStatusActive(m),
              serviceType: (m.serviceType as string) || '',
              serviceProgress: parseServiceStatusProgress(m),
              serviceTimeRemaining: tryParseServiceStatusRemainingSeconds(m),
              lastUpdate: new Date(),
            }))
          }

          if (message.type === 'service-complete') {
            if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
            setIsLoadingData(false)
            setSensorData(prev => ({
              ...prev,
              serviceActive: false,
              serviceProgress: 100,
              serviceTimeRemaining: 0,
              lastUpdate: new Date(),
            }))
          }

          if (message.type === 'device-online') {
            // If sensor data was cleared when the device went offline (lastUpdate
            // is null), show the loading spinner until fresh data arrives instead
            // of immediately rendering stale zeros with "Normal" status badges.
            if (sensorDataRef.current.lastUpdate === null) {
              setIsLoadingData(true)
              if (dataTimeoutRef.current) clearTimeout(dataTimeoutRef.current)
              dataTimeoutRef.current = setTimeout(() => setIsLoadingData(false), 10000)
            }
            setIsConnected(true)
            if (message.camSynced !== undefined) {
              setSensorData(prev => ({ ...prev, camSynced: message.camSynced }))
            }
          }

          if (message.type === 'device-offline') {
            setIsConnected(false)
            setIsLoadingData(false)
            if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
            setSensorData(DEFAULT_SENSOR_DATA)
            sensorDataRef.current = DEFAULT_SENSOR_DATA
          }

          // Forward every message to registered handlers (e.g. Commands page)
          messageHandlersRef.current.forEach(h => h(message))
        } catch (error) {
          console.error('[DashboardWebSocket] Error parsing message:', error)
        }
      }

      ws.onerror = () => {
        if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
        setIsConnected(false)
        setIsLoadingData(false)
        if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
        wsRef.current = null
        // Null onclose before closing so the close event doesn't schedule a
        // duplicate reconnect — onclose will still fire but do nothing.
        ws.onclose = null
        try { ws.close() } catch {}
        reconnectAttemptsRef.current++
        const delay = Math.min(3000 * Math.pow(2, reconnectAttemptsRef.current - 1), 30000)
        reconnectTimeoutRef.current = setTimeout(() => connect(), delay)
      }

      ws.onclose = () => {
        if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
        // Don't wipe sensor data on reconnect — this causes the gauges to flash
        // to zero every 5s during a brief WS drop. Sensor data is preserved so
        // the dashboard stays stable. Data is cleared only on device-offline.
        setIsConnected(false)
        setIsLoadingData(false)
        if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
        wsRef.current = null
        reconnectAttemptsRef.current++
        const delay = Math.min(3000 * Math.pow(2, reconnectAttemptsRef.current - 1), 30000)
        reconnectTimeoutRef.current = setTimeout(() => connect(), delay)
      }
    }

    connect()

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
      if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current)
      if (alertSyncTimeoutRef.current) clearTimeout(alertSyncTimeoutRef.current)
      if (dataTimeoutRef.current) clearTimeout(dataTimeoutRef.current)
      // Reset alert key tracking so remount starts fresh (no stale re-POST surge)
      prevAlertKeysRef.current = new Set()
      // Null out handlers before closing so the stale onclose doesn't schedule a
      // reconnect that races with (or duplicates) the next effect run's connection.
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.onerror = null
      }
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
    }
  }, [selectedDevice])

  const sendMessage = useCallback((msg: Record<string, unknown>): boolean => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return false
    wsRef.current.send(JSON.stringify(msg))
    return true
  }, [])

  const addMessageHandler = useCallback((handler: MessageHandler): (() => void) => {
    messageHandlersRef.current.add(handler)
    return () => { messageHandlersRef.current.delete(handler) }
  }, [])

  // Sync on connection state change (device-offline alert)
  useEffect(() => {
    syncAlertsToDb(sensorData, isConnected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected])

  return (
    <DashboardWebSocketContext.Provider value={{ sensorData, isConnected, isLoadingData, alertRefreshSignal, sendMessage, addMessageHandler }}>
      {children}
    </DashboardWebSocketContext.Provider>
  )
}

export function useDashboardWebSocket() {
  const context = useContext(DashboardWebSocketContext)
  if (context === undefined) {
    throw new Error('useDashboardWebSocket must be used within a DashboardWebSocketProvider')
  }
  return context
}
