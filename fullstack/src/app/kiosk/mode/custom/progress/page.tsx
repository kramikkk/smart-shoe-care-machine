'use client'

import React, { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { Progress } from "@/components/ui/progress"
import { useSearchParams, useRouter } from 'next/navigation'
import { useKioskWebSocket } from '@/contexts/KioskWebSocketContext'
import {
  parseServiceStatusDurationSeconds,
  parseServiceStatusProgress,
  tryParseServiceStatusRemainingSeconds,
} from '@/lib/service-status-fields'
import { KioskEmergencyStopButton } from '@/components/kiosk/KioskEmergencyStopButton'

const DEFAULT_DURATIONS: Record<string, Record<string, number>> = {
  cleaning: { gentle: 60, normal: 180, strong: 300 },
  drying: { gentle: 60, normal: 180, strong: 300 },
  sterilizing: { gentle: 60, normal: 180, strong: 300 },
}

const CustomProgress = () => {
  const searchParams = useSearchParams()
  const shoe    = searchParams.get('shoe')    || 'mesh'
  const service = searchParams.get('service') || 'cleaning'
  const care    = searchParams.get('care')    || 'normal'
  const router  = useRouter()

  const { isConnected, deviceId, sendMessage, onMessage } = useKioskWebSocket()

  const fallbackDuration = DEFAULT_DURATIONS[service.toLowerCase()]?.[care.toLowerCase()] ?? 120
  const [totalTime, setTotalTime] = useState(fallbackDuration)
  const [resolvedDuration, setResolvedDuration] = useState<number | null>(null)
  /** Seconds left — interpolated from last firmware service-status (ESP32 source of truth). */
  const [displayRemaining, setDisplayRemaining] = useState(fallbackDuration)
  /** When set, progress bar uses firmware `progress` field. */
  const [firmwareProgress, setFirmwareProgress] = useState<number | null>(null)

  const remainingAnchorRef = useRef({ value: fallbackDuration, atMs: Date.now() })
  const serviceStartedRef = useRef(false)

  // Refs for stop-service on unmount
  const sendMessageRef = useRef(sendMessage)
  const deviceIdRef    = useRef(deviceId)
  const skipUnmountStopRef = useRef(false)
  const abortedByEmergencyRef = useRef(false)
  useEffect(() => {
    sendMessageRef.current = sendMessage
    deviceIdRef.current    = deviceId
  }, [sendMessage, deviceId])

  const safeRemaining =
    Number.isFinite(displayRemaining) && displayRemaining >= 0 ? displayRemaining : 0
  const progress =
    firmwareProgress !== null
      ? firmwareProgress
      : resolvedDuration !== null && totalTime > 0
        ? Math.min(100, Math.max(0, ((totalTime - safeRemaining) / totalTime) * 100))
        : 0

  // Fetch configured duration from API
  useEffect(() => {
    const controller = new AbortController()
    const fetchDuration = async () => {
      try {
        const storedDeviceId = localStorage.getItem('kiosk_device_id')
        const url = storedDeviceId
          ? `/api/duration?deviceId=${encodeURIComponent(storedDeviceId)}`
          : '/api/duration'
        const res  = await fetch(url, { signal: controller.signal })
        const data = await res.json()
        if (data.success) {
          const entry = data.durations.find(
            (d: { serviceType: string; careType: string; duration: number }) =>
              d.serviceType === service.toLowerCase() && d.careType === care.toLowerCase()
          )
          const duration = entry?.duration ?? fallbackDuration
          if (duration > 0) {
            setTotalTime(duration)
            setDisplayRemaining(duration)
            remainingAnchorRef.current = { value: duration, atMs: Date.now() }
          }
          setResolvedDuration(duration > 0 ? duration : fallbackDuration)
        } else {
          setResolvedDuration(fallbackDuration)
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setResolvedDuration(fallbackDuration)
        }
      }
    }
    fetchDuration()
    return () => controller.abort()
  }, [service, care, fallbackDuration])

  // Send start-service once when connected and duration is resolved
  useEffect(() => {
    if (!isConnected || !deviceId || resolvedDuration === null || serviceStartedRef.current) return
    serviceStartedRef.current = true
    sendMessage({
      type: 'start-service',
      deviceId,
      shoeType: shoe,
      serviceType: service,
      careType: care,
      duration: resolvedDuration,
    })
  }, [isConnected, deviceId, resolvedDuration, shoe, service, care, sendMessage])

  // Firmware service-status: anchor remaining + progress; smooth ticks between 1s ESP updates.
  useEffect(() => {
    const unsubscribe = onMessage((message) => {
      if (message.type === 'service-status') {
        const m = message as Record<string, unknown>
        const rem = tryParseServiceStatusRemainingSeconds(m)
        if (rem !== null) {
          remainingAnchorRef.current = { value: rem, atMs: Date.now() }
          setDisplayRemaining(rem)
          setFirmwareProgress(parseServiceStatusProgress(m))
        }
        const duration = parseServiceStatusDurationSeconds(m)
        if (duration !== null) {
          setTotalTime(duration)
        }
      } else if (message.type === 'service-complete') {
        remainingAnchorRef.current = { value: 0, atMs: Date.now() }
        setDisplayRemaining(0)
        setFirmwareProgress(100)
      }
    })
    return unsubscribe
  }, [onMessage])

  useEffect(() => {
    const id = setInterval(() => {
      if (!isConnected) return
      const { value, atMs } = remainingAnchorRef.current
      const next = Math.max(0, value - Math.floor((Date.now() - atMs) / 1000))
      setDisplayRemaining(next)
    }, 250)
    return () => clearInterval(id)
  }, [isConnected])

  // Send stop-service on unmount (back-navigation guard)
  useEffect(() => {
    return () => {
      if (skipUnmountStopRef.current) return
      if (deviceIdRef.current) {
        sendMessageRef.current({ type: 'stop-service', deviceId: deviceIdRef.current })
      }
    }
  }, [])

  // Redirect only after a run was started — avoids spurious success if remaining parsed as 0 from bad payloads
  useEffect(() => {
    if (!serviceStartedRef.current || displayRemaining !== 0) return
    if (abortedByEmergencyRef.current) return
    // Service completed normally — don't send stop-service on unmount so the firmware's
    // 15s post-drying/sterilizing exhaust purge is not aborted.
    skipUnmountStopRef.current = true
    router.push(`/kiosk/success/service?shoe=${shoe}&service=${service}&care=${care}`)
  }, [displayRemaining, router, shoe, service, care])

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
    const s = Math.floor(seconds)
    const mins = Math.floor(s / 60)
    const secs = s % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  const getServiceConfig = () => {
    switch (service.toLowerCase()) {
      case 'cleaning':
        return {
          image: '/Water3D.webp',
          name: 'Cleaning',
          gradientFrom: 'from-blue-500',
          gradientTo: 'to-cyan-500'
        }
      case 'drying':
        return {
          image: '/Wind3D.webp',
          name: 'Drying',
          gradientFrom: 'from-cyan-500',
          gradientTo: 'to-green-500'
        }
      case 'sterilizing':
        return {
          image: '/Shield3D.webp',
          name: 'Sterilizing',
          gradientFrom: 'from-green-500',
          gradientTo: 'to-emerald-500'
        }
      default:
        return {
          image: '/Water3D.webp',
          name: 'Cleaning',
          gradientFrom: 'from-blue-500',
          gradientTo: 'to-cyan-500'
        }
    }
  }

  const getCareTypeName = () => {
    return care.charAt(0).toUpperCase() + care.slice(1)
  }

  const getShoeTypeName = () => {
    return shoe.charAt(0).toUpperCase() + shoe.slice(1)
  }

  const serviceConfig = getServiceConfig()

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-6">
      {/* Title */}
      <h1 className="text-5xl font-bold text-center mb-6 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        Shoe Care in Progress
      </h1>

      {/* Service Icon */}
      <div className='flex justify-center mb-4'>
        <div className="flex flex-col items-center transition-all duration-300">
          <div className={`rounded-full p-4 transition-all duration-300 bg-gradient-to-br ${serviceConfig.gradientFrom} ${serviceConfig.gradientTo} shadow-lg scale-105`}>
            <Image src={serviceConfig.image} alt={serviceConfig.name} width={80} height={80} className="w-20 h-20" />
          </div>
        </div>
      </div>

      {/* Service Name */}
      <h2 className="text-4xl font-bold text-center mb-3 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        {serviceConfig.name}
      </h2>

      {/* Shoe Type & Care Type Badges */}
      <div className="flex gap-3 mb-4">
        <span className="inline-block px-5 py-1.5 bg-gradient-to-r from-purple-100 to-pink-100 rounded-full text-base font-semibold text-purple-800 shadow-sm">
          {getShoeTypeName()} Type
        </span>
        <span className="inline-block px-5 py-1.5 bg-gradient-to-r from-blue-100 to-cyan-100 rounded-full text-base font-semibold text-blue-800 shadow-sm">
          {getCareTypeName()} Care
        </span>
      </div>

      {/* Connection Status */}
      <div className="flex items-center justify-center gap-2 mb-6">
        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
        <p className="text-xs text-gray-600">
          {isConnected ? 'Connected to device' : 'Reconnecting — time frozen at last device update'}
        </p>
      </div>

      {/* Time Remaining */}
      <div className="mb-6">
        <p className="text-xl text-gray-500 text-center mb-1">Time Remaining</p>
        <p className="text-6xl font-bold text-center bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
          {resolvedDuration === null || !Number.isFinite(displayRemaining)
            ? '--:--'
            : formatTime(displayRemaining)}
        </p>
      </div>

      {/* Progress Bar */}
      <div className="w-full max-w-2xl mb-6">
        <Progress
          value={progress}
          className='bg-gray-200 relative h-5 w-full overflow-hidden rounded-full shadow-inner [&>*]:bg-gradient-to-r [&>*]:from-blue-600 [&>*]:via-cyan-600 [&>*]:to-green-600 [&>*]:transition-all [&>*]:duration-500'
        />
        <p className="text-center text-gray-500 mt-2 text-base font-medium">{Math.round(progress)}% Complete</p>
      </div>

      {/* Instruction Text */}
      <p className="text-center text-gray-500 text-lg max-w-2xl leading-relaxed">
        Please wait while we take care of your shoes. You will be automatically redirected when complete.
      </p>

      <div className="mt-8 flex w-full max-w-2xl justify-center">
        <KioskEmergencyStopButton
          deviceId={deviceId}
          sendMessage={sendMessage}
          exitHref={`/kiosk/stopped?shoe=${encodeURIComponent(shoe)}&service=${encodeURIComponent(service)}&care=${encodeURIComponent(care)}`}
          onEmergencyInitiated={() => {
            skipUnmountStopRef.current = true
            abortedByEmergencyRef.current = true
          }}
        />
      </div>
    </div>
  )
}

export default CustomProgress
