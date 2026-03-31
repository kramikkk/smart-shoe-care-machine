'use client'

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { useDeviceFilter } from './DeviceFilterContext'

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

  if (!isConnected) {
    alerts.push({
      id: 'device-offline',
      severity: 'critical',
      title: 'Device Offline',
      description: 'The machine is not connected. Check network and power.',
    })
    return alerts
  }


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

  if (sensorData.temperature > 0) {
    if (sensorData.temperature > 50) {
      alerts.push({
        id: 'temp-critical',
        severity: 'critical',
        title: 'Temperature Critical',
        description: `Chamber temperature is dangerously high (${sensorData.temperature.toFixed(1)}°C). Check ventilation.`,
      })
    } else if (sensorData.temperature > 40) {
      alerts.push({
        id: 'temp-high',
        severity: 'warning',
        title: 'High Temperature',
        description: `Chamber temperature is elevated (${sensorData.temperature.toFixed(1)}°C).`,
      })
    }
  }

  if (sensorData.humidity > 0 && sensorData.humidity > 70) {
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
  serviceTimeRemaining: number
  camSynced: boolean
}

type SensorDataContextType = {
  sensorData: SensorData
  isConnected: boolean
  isLoadingData: boolean
  alertRefreshSignal: number
  sendMessage: (msg: Record<string, unknown>) => boolean
  addMessageHandler: (handler: MessageHandler) => () => void
}

const SensorDataContext = createContext<SensorDataContextType | undefined>(undefined)

const DEFAULT_SENSOR_DATA: SensorData = {
  temperature: 0,
  humidity: 0,
  atomizerDistance: 0,
  foamDistance: 0,
  lastUpdate: null,
  serviceActive: false,
  serviceType: '',
  serviceProgress: 0,
  serviceTimeRemaining: 0,
  camSynced: false,
}

export function SensorDataProvider({ children }: { children: React.ReactNode }) {
  const { selectedDevice } = useDeviceFilter()

  // Keep a ref to the latest sensor data so cleanup can read it without stale closures
  const sensorDataRef = useRef<SensorData>(DEFAULT_SENSOR_DATA)
  // Track previous alert keys to detect transitions
  const prevAlertKeysRef = useRef<Set<string>>(new Set())
  // Debounce alert sync to avoid firing on every rapid sensor tick
  const alertSyncTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
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

  useEffect(() => {
    if (!selectedDevice) return

    // Pre-check live online status so the UI doesn't flicker offline on page refresh.
    // The WS subscribe path is slightly delayed (connect → subscribe → server responds),
    // so we hit the REST status endpoint first to get the current live state immediately.
    fetch(`/api/device/${encodeURIComponent(selectedDevice)}/status`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then((data: { online?: boolean } | null) => { if (data?.online) setIsConnected(true) })
      .catch(() => {})

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/ws?deviceId=${encodeURIComponent(selectedDevice)}`

    let ws: WebSocket

    const connect = () => {
      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
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
              syncAlertsToDb(next, true)
              return next
            })
          }

          if (message.type === 'cam-sync-status') {
            if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
            setIsLoadingData(false)
            setSensorData(prev => {
              const next = { ...prev, camSynced: message.camSynced, lastUpdate: new Date() }
              sensorDataRef.current = next
              syncAlertsToDb(next, true)
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
              syncAlertsToDb(next, true)
              return next
            })
          }

          if (message.type === 'service-status') {
            if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
            setIsLoadingData(false)
            setSensorData(prev => ({
              ...prev,
              serviceActive: message.active,
              serviceType: message.serviceType || '',
              serviceProgress: message.progress || 0,
              serviceTimeRemaining: message.timeRemaining || 0,
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
            setIsConnected(true)
          }

          if (message.type === 'device-offline') {
            setIsConnected(false)
            setSensorData(DEFAULT_SENSOR_DATA)
            sensorDataRef.current = DEFAULT_SENSOR_DATA
          }

          // Forward every message to registered handlers (e.g. Commands page)
          messageHandlersRef.current.forEach(h => h(message))
        } catch (error) {
          console.error('[SensorData] Error parsing message:', error)
        }
      }

      ws.onerror = () => {
        // Don't wipe sensor data on transient errors — the ESP32's data is still
        // valid. Only clear on authoritative device-offline from the server.
        setIsConnected(false)
        setIsLoadingData(false)
        if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
        wsRef.current = null
      }

      ws.onclose = () => {
        // Don't wipe sensor data on reconnect — this causes the gauges to flash
        // to zero every 5s during a brief WS drop. Sensor data is preserved so
        // the dashboard stays stable. Data is cleared only on device-offline.
        setIsConnected(false)
        setIsLoadingData(false)
        if (dataTimeoutRef.current) { clearTimeout(dataTimeoutRef.current); dataTimeoutRef.current = null }
        wsRef.current = null
        reconnectTimeoutRef.current = setTimeout(() => connect(), 5000)
      }
    }

    connect()

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
      if (alertSyncTimeoutRef.current) clearTimeout(alertSyncTimeoutRef.current)
      if (dataTimeoutRef.current) clearTimeout(dataTimeoutRef.current)
      // Reset alert key tracking so remount starts fresh (no stale re-POST surge)
      prevAlertKeysRef.current = new Set()
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
    }
  }, [selectedDevice, syncAlertsToDb])

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
    <SensorDataContext.Provider value={{ sensorData, isConnected, isLoadingData, alertRefreshSignal, sendMessage, addMessageHandler }}>
      {children}
    </SensorDataContext.Provider>
  )
}

export function useSensorData() {
  const context = useContext(SensorDataContext)
  if (context === undefined) {
    throw new Error('useSensorData must be used within a SensorDataProvider')
  }
  return context
}
