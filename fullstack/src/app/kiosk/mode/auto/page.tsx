'use client'

import { Droplets, ShieldCheck, Wind } from 'lucide-react'
import { debug } from '@/lib/debug'
import { useState, useEffect, useMemo, useRef } from 'react'
import { Progress } from "@/components/ui/progress"
import { useRouter, useSearchParams } from 'next/navigation'
import { useKioskWebSocket } from '@/contexts/KioskWebSocketContext'
import { useDurations } from '@/hooks/useDurations'
import {
  normalizeServiceStage,
  packageRemainingSecondsForAuto,
  parseServiceStatusActive,
  tryParseServiceStatusRemainingSeconds,
} from '@/lib/service-status-fields'
import { KioskEmergencyStopButton } from '@/components/kiosk/KioskEmergencyStopButton'

// Recommended care types for each shoe type and service
// Optimized settings for the best care based on material properties
type CareType = 'gentle' | 'normal' | 'strong'
type ServiceType = 'cleaning' | 'drying' | 'sterilizing'

interface ShoeRecommendations {
  cleaning: CareType
  drying: CareType
  sterilizing: CareType
}

const SHOE_CARE_RECOMMENDATIONS: Record<string, ShoeRecommendations> = {
  // Mesh: Delicate synthetic fibers, soft foam interior — gentle clean & dry (heat/pressure damages synthetics), gentle sterilize (UV/mist degrades foam and adhesives)
  mesh: { cleaning: 'gentle', drying: 'gentle', sterilizing: 'gentle' },
  // Canvas: Absorbent cotton, heavy sweat retention — normal clean, strong dry (absorbs water heavily), normal sterilize (moderate disinfection for cotton lining)
  canvas: { cleaning: 'normal', drying: 'strong', sterilizing: 'normal' },
  // Rubber: Durable, waterproof, smooth interior — strong clean (hard surface), normal dry (repels water; strong heat warps rubber), strong sterilize (UV/mist-resistant; thorough treatment safe)
  rubber: { cleaning: 'strong', drying: 'normal', sterilizing: 'strong' },
}

// Default recommendations for unknown shoe types
const DEFAULT_RECOMMENDATIONS: ShoeRecommendations = {
  cleaning: 'normal',
  drying: 'normal',
  sterilizing: 'normal'
}

const Auto = () => {
  const searchParams = useSearchParams()
  const shoe          = searchParams.get('shoe')           || 'mesh'
  const transactionId = searchParams.get('transactionId') || ''
  const router        = useRouter()

  // Get recommended care types for this shoe type
  const recommendations = useMemo(() => {
    const shoeKey = shoe.toLowerCase()
    return SHOE_CARE_RECOMMENDATIONS[shoeKey] || DEFAULT_RECOMMENDATIONS
  }, [shoe])

  const { durations, isLoaded: isDurationsLoaded } = useDurations()

  const careTierFallback = useMemo(
    () =>
      ({
        gentle: 180,
        normal: 360,
        strong: 540,
      }) as Record<CareType, number>,
    []
  )

  // Calculate stage durations based on shoe type recommendations and fetched durations
  const stageDurations = useMemo(() => ({
    cleaning:
      durations.cleaning?.[recommendations.cleaning] ??
      careTierFallback[recommendations.cleaning],
    drying:
      durations.drying?.[recommendations.drying] ?? careTierFallback[recommendations.drying],
    sterilizing:
      durations.sterilizing?.[recommendations.sterilizing] ??
      careTierFallback[recommendations.sterilizing],
  }), [durations, recommendations, careTierFallback])

  // Calculate total time based on recommended care types for each service
  const totalTime = useMemo(() => {
    return stageDurations.cleaning + stageDurations.drying + stageDurations.sterilizing
  }, [stageDurations])

  /** Wall-clock seconds left for the full package (ESP32 + stage tail model). */
  const [packageRemainingDisplay, setPackageRemainingDisplay] = useState(0)
  const [deviceSynced, setDeviceSynced] = useState(false)
  const [currentStage, setCurrentStage] = useState<ServiceType>('cleaning')
  const [serviceStarted, setServiceStarted] = useState(false)

  const stageDurationsRef = useRef(stageDurations)
  useEffect(() => {
    stageDurationsRef.current = stageDurations
  }, [stageDurations])

  const displayRemaining = deviceSynced ? packageRemainingDisplay : totalTime
  const progress =
    deviceSynced && totalTime > 0
      ? Math.min(100, Math.max(0, (100 * (totalTime - displayRemaining)) / totalTime))
      : 0

  // Get the care type for the current stage
  const getCurrentCareType = (): CareType => {
    return recommendations[currentStage]
  }

  // Use centralized WebSocket context
  const { isConnected, deviceId, sendMessage, onMessage } = useKioskWebSocket()
  const lastSentStageRef = useRef<string>('')
  const sendMessageRef = useRef(sendMessage)
  const deviceIdRef = useRef(deviceId)
  const skipUnmountStopRef = useRef(false)
  // Set to true when emergency stop is initiated so incoming service-complete
  // messages don't advance to the next stage while the component is still mounted.
  const emergencyStoppedRef = useRef(false)

  // Keep refs in sync with current values
  useEffect(() => {
    sendMessageRef.current = sendMessage
    deviceIdRef.current = deviceId
  }, [sendMessage, deviceId])

  // ESP32 is source of truth: service-status drives package time + active stage; service-complete advances stages / finishes.
  useEffect(() => {
    const unsubscribe = onMessage((message) => {
      if (message.type === 'service-status') {
        const m = message as Record<string, unknown>
        // Only process active status updates. The firmware sends a final service-status
        // with status="completed" right after service-complete; if we let it through it
        // resets currentStage back to the just-finished stage, causing the stage-change
        // effect to re-send start-service for the wrong stage.
        if (!parseServiceStatusActive(m)) return
        const st = normalizeServiceStage(String(m.serviceType ?? ''))
        if (st) setCurrentStage(st)
        const rem = tryParseServiceStatusRemainingSeconds(m)
        if (st && rem !== null) {
          const pkg = packageRemainingSecondsForAuto(st, rem, stageDurationsRef.current)
          setPackageRemainingDisplay(pkg)
          setDeviceSynced(true)
        }
      } else if (message.type === 'service-complete') {
        // Emergency stop already sent — ignore the abort-triggered service-complete
        // so the stage-change effect doesn't fire and send start-service for the next stage.
        if (emergencyStoppedRef.current) return
        const m = message as Record<string, unknown>
        const done = normalizeServiceStage(String(m.serviceType ?? ''))
        if (done === 'cleaning') {
          setCurrentStage('drying')
        } else if (done === 'drying') {
          setCurrentStage('sterilizing')
        } else if (done === 'sterilizing') {
          // Service finished normally — don't send stop-service on unmount (would abort the
          // 15s post-sterilization exhaust purge the firmware runs automatically).
          skipUnmountStopRef.current = true
          setPackageRemainingDisplay(0)
          debug.log(`[Auto] All stages complete — redirecting to success (shoe: ${shoe})`)
          router.push(`/kiosk/success/service?shoe=${shoe}&service=package`)
        }
      }
    })
    return unsubscribe
  }, [onMessage, router, shoe])

  // Send initial cleaning command when connected
  useEffect(() => {
    if (!isConnected || !deviceId || serviceStarted || !isDurationsLoaded) return

    const cleaningCareType = recommendations.cleaning
    sendMessage({
      type: 'start-service',
      deviceId,
      shoeType: shoe,
      serviceType: 'cleaning',
      careType: cleaningCareType,
      duration: stageDurations.cleaning,
      ...(transactionId ? { transactionId } : {}),
    })
    debug.log(`[Auto] Service started — shoe: ${shoe}, stage: cleaning, care: ${cleaningCareType}`)
    lastSentStageRef.current = 'cleaning'
    setServiceStarted(true)
  }, [
    isConnected,
    deviceId,
    serviceStarted,
    recommendations.cleaning,
    shoe,
    sendMessage,
    isDurationsLoaded,
    stageDurations.cleaning,
  ])

  // Send stage change command when stage updates
  useEffect(() => {
    if (!serviceStarted || !isConnected || currentStage === lastSentStageRef.current) return

    const stageCareType = recommendations[currentStage]
    sendMessage({
      type: 'start-service',
      deviceId,
      shoeType: shoe,
      serviceType: currentStage,
      careType: stageCareType,
      duration: stageDurations[currentStage],
      ...(transactionId ? { transactionId } : {}),
    })
    debug.log(`[Auto] Stage change → ${currentStage} (care: ${stageCareType})`)
    lastSentStageRef.current = currentStage
  }, [
    currentStage,
    isConnected,
    serviceStarted,
    deviceId,
    shoe,
    recommendations,
    sendMessage,
    stageDurations,
  ])

  // Send stop-service message on unmount (handles back-navigation)
  useEffect(() => {
    return () => {
      if (skipUnmountStopRef.current) return
      if (deviceIdRef.current) {
        sendMessageRef.current({ type: 'stop-service', deviceId: deviceIdRef.current })
      }
    }
  }, [])

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  const getStageName = () => {
    switch (currentStage) {
      case 'cleaning':    return 'Cleaning'
      case 'drying':      return 'Drying'
      case 'sterilizing': return 'Sterilizing'
    }
  }

  const getCareTypeName = () => {
    const careType = getCurrentCareType()
    return careType.charAt(0).toUpperCase() + careType.slice(1)
  }

  const getShoeTypeName = () => {
    return shoe.charAt(0).toUpperCase() + shoe.slice(1)
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-4">
      {/* Title */}
      <h1 className="text-5xl font-bold text-center mb-6 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        Shoe Care in Progress
      </h1>

      {/* Process Stages Indicator */}
      <div className='flex justify-center gap-6 mb-4'>
        {/* Cleaning Stage */}
        <div className="flex flex-col items-center transition-all duration-300">
          <div className={`rounded-full p-4 transition-all duration-300 ${
            currentStage === 'cleaning'
              ? 'bg-gradient-to-br from-blue-500 to-cyan-500 shadow-lg scale-105'
              : 'bg-gray-200 shadow-md'
          }`}>
            <Droplets className={`w-20 h-20 transition-colors duration-300 ${
              currentStage === 'cleaning' ? 'text-white' : 'text-gray-400'
            }`} />
          </div>
        </div>

        {/* Drying Stage */}
        <div className="flex flex-col items-center transition-all duration-300">
          <div className={`rounded-full p-4 transition-all duration-300 ${
            currentStage === 'drying'
              ? 'bg-gradient-to-br from-cyan-500 to-green-500 shadow-lg scale-105'
              : 'bg-gray-200 shadow-md'
          }`}>
            <Wind className={`w-20 h-20 transition-colors duration-300 ${
              currentStage === 'drying' ? 'text-white' : 'text-gray-400'
            }`} />
          </div>
        </div>

        {/* Sterilizing Stage */}
        <div className="flex flex-col items-center transition-all duration-300">
          <div className={`rounded-full p-4 transition-all duration-300 ${
            currentStage === 'sterilizing'
              ? 'bg-gradient-to-br from-green-500 to-emerald-500 shadow-lg scale-105'
              : 'bg-gray-200 shadow-md'
          }`}>
            <ShieldCheck className={`w-20 h-20 transition-colors duration-300 ${
              currentStage === 'sterilizing' ? 'text-white' : 'text-gray-400'
            }`} />
          </div>
        </div>
      </div>

      {/* Current Stage Name */}
      <h2 className="text-4xl font-bold text-center mb-3 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        {getStageName()}
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
          {formatTime(displayRemaining)}
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

      <div className="mb-6 flex w-full max-w-2xl justify-center px-1">
        <KioskEmergencyStopButton
          deviceId={deviceId}
          sendMessage={sendMessage}
          exitHref={`/kiosk/stopped?shoe=${encodeURIComponent(shoe)}&service=package`}
          onEmergencyInitiated={() => {
            skipUnmountStopRef.current = true
            emergencyStoppedRef.current = true
          }}
        />
      </div>

      {/* Instruction Text */}
      <p className="text-center text-gray-500 text-lg max-w-2xl leading-relaxed">
        Please wait while we take care of your shoes. You will be automatically redirected when complete.
      </p>
    </div>
  )
}

export default Auto
