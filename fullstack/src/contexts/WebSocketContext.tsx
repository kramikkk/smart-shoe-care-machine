'use client'

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { debug } from '@/lib/debug'

interface WebSocketMessage {
  type: string
  [key: string]: any
}

interface WebSocketContextType {
  isConnected: boolean
  isPaired: boolean | null
  pairingCode: string
  deviceId: string
  sendMessage: (message: WebSocketMessage) => void
  subscribe: (deviceId: string) => void
  onMessage: (handler: (message: WebSocketMessage) => void) => () => void
}

const WebSocketContext = createContext<WebSocketContextType | undefined>(undefined)

// WebSocket connection states
enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting'
}

const DEVICE_ID_KEY    = 'kiosk_device_id'
const GROUP_TOKEN_KEY  = 'kiosk_group_token'
const MAX_RECONNECT_DELAY_MS = 10000
const RECONNECT_DELAY_MS = 3000

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false)
  const [isPaired, setIsPaired] = useState<boolean | null>(null)
  const [pairingCode, setPairingCode] = useState<string>('')
  const [deviceId, setDeviceId] = useState<string>('')

  const wsRef = useRef<WebSocket | null>(null)
  const connectionStateRef = useRef<ConnectionState>(ConnectionState.DISCONNECTED)
  const reconnectAttemptsRef = useRef<number>(0)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const intentionalCloseRef = useRef<boolean>(false)
  const messageHandlersRef = useRef<Set<(message: WebSocketMessage) => void>>(new Set())
  const prevIsPairedRef = useRef<boolean | null>(null)

  const connectWebSocket = useCallback((devId: string) => {
    // Prevent duplicate connections
    if (connectionStateRef.current === ConnectionState.CONNECTING ||
        connectionStateRef.current === ConnectionState.CONNECTED) {
      debug.log('[WebSocket] Already connected or connecting, skipping')
      return
    }

    // Clear any pending reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    connectionStateRef.current = reconnectAttemptsRef.current > 0
      ? ConnectionState.RECONNECTING
      : ConnectionState.CONNECTING

    // Determine WebSocket protocol based on current protocol
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${window.location.host}/api/ws?deviceId=${encodeURIComponent(devId)}&source=kiosk`

    debug.log(`[WebSocket] ${connectionStateRef.current === ConnectionState.RECONNECTING ? 'Reconnecting' : 'Connecting'} to ${wsUrl}`)

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      debug.log('[WebSocket] Connected successfully')
      connectionStateRef.current = ConnectionState.CONNECTED
      setIsConnected(true)
      reconnectAttemptsRef.current = 0

      // Include groupToken in subscribe if we have one stored (3-way binding)
      const storedGroupToken = localStorage.getItem(GROUP_TOKEN_KEY)
      const subscribeMsg: Record<string, string> = { type: 'subscribe', deviceId: devId }
      if (storedGroupToken) subscribeMsg.groupToken = storedGroupToken

      ws.send(JSON.stringify(subscribeMsg))
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)

        // Handle pairing-specific messages
        if (message.type === 'subscribed') {
          debug.log(`[WebSocket] Subscribed to device: ${message.deviceId}`)
        } else if (message.type === 'device-update') {
          debug.log('[WebSocket] Received device update:', message.data)
          setIsPaired(message.data.paired)
          setPairingCode(message.data.pairingCode || '')
          if (message.data.groupToken) {
            localStorage.setItem(GROUP_TOKEN_KEY, message.data.groupToken)
            debug.log('[WebSocket] Stored groupToken for 3-way binding')
          }
        } else if (message.type === 'device-online') {
          debug.log('[WebSocket] Device is online:', message.deviceId)
          setIsPaired(message.paired)
        } else if (message.type === 'error' && message.code === 'INVALID_GROUP_TOKEN') {
          console.warn('[WebSocket] GroupToken rejected — clearing and reloading')
          localStorage.removeItem(GROUP_TOKEN_KEY)
          window.location.reload()
        } else if (message.type === 'firmware-log') {
          // Always show firmware logs regardless of DEBUG flag
          const prefix = `[FIRMWARE:${(message.level as string)?.toUpperCase() || 'INFO'}]`
          if (message.level === 'error') console.error(prefix, message.message)
          else if (message.level === 'warn') console.warn(prefix, message.message)
          else console.log(prefix, message.message)
        } else {
          debug.log(`[WebSocket] Message received: ${message.type}`, message)
        }

        // Notify all registered message handlers
        messageHandlersRef.current.forEach(handler => {
          try {
            handler(message)
          } catch (error) {
            console.error('[WebSocket] Handler error:', error)
          }
        })
      } catch (error) {
        console.error('[WebSocket] Error parsing message:', error)
      }
    }

    ws.onerror = () => {
      console.error('[WebSocket] Connection error')
      connectionStateRef.current = ConnectionState.DISCONNECTED
      setIsConnected(false)
    }

    ws.onclose = (event) => {
      connectionStateRef.current = ConnectionState.DISCONNECTED
      setIsConnected(false)

      // Don't reconnect if close was intentional
      if (intentionalCloseRef.current) {
        debug.log('[WebSocket] Disconnected (intentional)')
        return
      }

      debug.log(`[WebSocket] Disconnected (code: ${event.code}, reason: ${event.reason || 'none'})`)

      // Attempt to reconnect with exponential backoff, capped at MAX_RECONNECT_DELAY_MS
      reconnectAttemptsRef.current++
      const delay = Math.min(
        RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current - 1),
        MAX_RECONNECT_DELAY_MS
      )
      console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`)

      reconnectTimeoutRef.current = setTimeout(() => {
        connectWebSocket(devId)
      }, delay)
    }
  }, [])

  // Initial setup
  useEffect(() => {
    const checkInitialStatus = async () => {
      try {
        const storedDeviceId = localStorage.getItem(DEVICE_ID_KEY)

        if (storedDeviceId) {
          const response = await fetch(`/api/device/${storedDeviceId}/status`, {
            method: 'GET',
            cache: 'no-store',
          })

          if (response.ok) {
            const data = await response.json()
            setDeviceId(data.deviceId)
            setIsPaired(data.paired)
            setPairingCode(data.pairingCode || '')
            if (data.groupToken) {
              localStorage.setItem(GROUP_TOKEN_KEY, data.groupToken)
            }
            connectWebSocket(data.deviceId)
          } else if (response.status === 404) {
            localStorage.removeItem(DEVICE_ID_KEY)
            setDeviceId('No device configured')
            setIsPaired(false)
            setPairingCode('')
          }
        } else {
          setDeviceId('No device configured')
          setIsPaired(false)
          setPairingCode('')
        }
      } catch (error) {
        console.error('Initial pairing check error:', error)
        setDeviceId('Connection error')
        setIsPaired(false)
        setPairingCode('')
      }
    }

    checkInitialStatus()

    // Cleanup on unmount
    return () => {
      intentionalCloseRef.current = true
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connectWebSocket])

  // Reload the kiosk page when the device gets unpaired remotely.
  // Delay gives the ESP32 time to reboot and register a fresh pairing code first.
  useEffect(() => {
    if (prevIsPairedRef.current === true && isPaired === false) {
      const timer = setTimeout(() => window.location.reload(), 3000)
      return () => clearTimeout(timer)
    }
    prevIsPairedRef.current = isPaired
  }, [isPaired])

  const sendMessage = useCallback((message: WebSocketMessage) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    } else {
      debug.warn('[WebSocket] Cannot send message, not connected')
    }
  }, [])

  const subscribe = useCallback((targetDeviceId: string) => {
    const storedGroupToken = localStorage.getItem(GROUP_TOKEN_KEY)
    const msg: WebSocketMessage = { type: 'subscribe', deviceId: targetDeviceId }
    if (storedGroupToken) msg.groupToken = storedGroupToken
    sendMessage(msg)
  }, [sendMessage])

  const onMessage = useCallback((handler: (message: WebSocketMessage) => void) => {
    messageHandlersRef.current.add(handler)
    return () => {
      messageHandlersRef.current.delete(handler)
    }
  }, [])

  const value: WebSocketContextType = {
    isConnected,
    isPaired,
    pairingCode,
    deviceId,
    sendMessage,
    subscribe,
    onMessage
  }

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  )
}

export function useWebSocket() {
  const context = useContext(WebSocketContext)
  if (context === undefined) {
    throw new Error('useWebSocket must be used within a WebSocketProvider')
  }
  return context
}
