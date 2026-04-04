'use client'

import { Droplets, ShieldCheck, Wind } from 'lucide-react'
import { debug } from '@/lib/debug'
import { useState, useEffect, useMemo, useRef } from 'react'
import { Progress } from "@/components/ui/progress"
import { useRouter, useSearchParams } from 'next/navigation'
import { useKioskWebSocket } from '@/contexts/KioskWebSocketContext'
import { useDurations } from '@/hooks/useDurations'

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
  // Mesh: Delicate, breathable - gentle cleaning, normal drying, gentle sterilizing
  mesh: { cleaning: 'gentle', drying: 'normal', sterilizing: 'gentle' },
  // Canvas: Durable fabric - strong cleaning, normal drying, normal sterilizing
  canvas: { cleaning: 'strong', drying: 'normal', sterilizing: 'normal' },
  // Rubber: Very durable, waterproof - strong cleaning, normal drying, strong sterilizing
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
  const shoe = searchParams.get('shoe') || 'mesh'
  const router = useRouter()

  // Get recommended care types for this shoe type
  const recommendations = useMemo(() => {
    const shoeKey = shoe.toLowerCase()
    return SHOE_CARE_RECOMMENDATIONS[shoeKey] || DEFAULT_RECOMMENDATIONS
  }, [shoe])

  const { durations, isLoaded: isDurationsLoaded } = useDurations()

  // Calculate stage durations based on shoe type recommendations and fetched durations
  const stageDurations = useMemo(() => ({
    cleaning:    durations.cleaning?.[recommendations.cleaning]    ?? 300,
    drying:      durations.drying?.[recommendations.drying]        ?? 120,
    sterilizing: durations.sterilizing?.[recommendations.sterilizing] ?? 60,
  }), [durations, recommendations])

  // Calculate total time based on recommended care types for each service
  const totalTime = useMemo(() => {
    return stageDurations.cleaning + stageDurations.drying + stageDurations.sterilizing
  }, [stageDurations])

  const [timeRemaining, setTimeRemaining] = useState(totalTime)
  const [currentStage, setCurrentStage] = useState<ServiceType>('cleaning')
  const [serviceStarted, setServiceStarted] = useState(false)

  // Tracks previous connection state for freeze/resume logging across effect re-runs
  const prevConnectedRef = useRef(false)

  // Re-initialize timer once durations have been fetched
  const hasInitializedTimer = useRef(false)
  useEffect(() => {
    if (isDurationsLoaded && !hasInitializedTimer.current) {
      hasInitializedTimer.current = true
      setTimeRemaining(totalTime)
    }
  }, [isDurationsLoaded, totalTime])

  const progress = ((totalTime - timeRemaining) / totalTime) * 100

  // Get the care type for the current stage
  const getCurrentCareType = (): CareType => {
    return recommendations[currentStage]
  }

  // Use centralized WebSocket context
  const { isConnected, deviceId, sendMessage, onMessage, camSynced } = useKioskWebSocket()
  const lastSentStageRef = useRef<string>('')
  const sendMessageRef = useRef(sendMessage)
  const deviceIdRef = useRef(deviceId)

  // Keep refs in sync with current values
  useEffect(() => {
    sendMessageRef.current = sendMessage
    deviceIdRef.current = deviceId
  }, [sendMessage, deviceId])

  // Listen for ESP32 messages
  useEffect(() => {
    const unsubscribe = onMessage((_message) => {
      // handled by firmware; no UI action needed here
    })
    return unsubscribe
  }, [onMessage])

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
      duration: durations['cleaning']?.[cleaningCareType],
    })
    debug.log(`[Auto] Service started — shoe: ${shoe}, stage: cleaning, care: ${cleaningCareType}`)
    lastSentStageRef.current = 'cleaning'
    setServiceStarted(true)
  }, [isConnected, deviceId, serviceStarted, recommendations, shoe, sendMessage, isDurationsLoaded])

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
      duration: durations[currentStage]?.[stageCareType],
    })
    debug.log(`[Auto] Stage change → ${currentStage} (care: ${stageCareType})`)
    lastSentStageRef.current = currentStage
  }, [currentStage, isConnected, serviceStarted, deviceId, shoe, recommendations, sendMessage, durations])

  // Timer — pauses when WebSocket disconnects
  useEffect(() => {
    if (!isDurationsLoaded) return

    const timer = setInterval(() => {
      if (!isConnected) {
        if (prevConnectedRef.current) {
          debug.log('[Auto] Timer frozen — WebSocket disconnected')
          prevConnectedRef.current = false
        }
        return
      }
      if (!prevConnectedRef.current) {
        debug.log('[Auto] Timer resumed — WebSocket reconnected')
        prevConnectedRef.current = true
      }
      setTimeRemaining((prev) => {
        if (prev <= 0) {
          clearInterval(timer)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [isDurationsLoaded, isConnected])

  // Separate effect to update stage based on timeRemaining
  useEffect(() => {
    const cleaningEnd = totalTime - stageDurations.cleaning
    const dryingEnd = cleaningEnd - stageDurations.drying

    let newStage: ServiceType
    if (timeRemaining > cleaningEnd) {
      newStage = 'cleaning'
    } else if (timeRemaining > dryingEnd) {
      newStage = 'drying'
    } else {
      newStage = 'sterilizing'
    }

    if (newStage !== currentStage) {
      setCurrentStage(newStage)
    }
  }, [timeRemaining, totalTime, stageDurations, currentStage])

  useEffect(() => {
    if (timeRemaining === 0) {
      debug.log(`[Auto] All stages complete — redirecting to success (shoe: ${shoe})`)
      router.push(`/kiosk/success/service?shoe=${shoe}&service=package`)
    }
  }, [timeRemaining, router, shoe])

  // Send stop-service message on unmount (handles back-navigation)
  useEffect(() => {
    return () => {
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
          {isConnected ? 'Connected to device' : 'Reconnecting — timer paused'}
        </p>
      </div>

      {/* Time Remaining */}
      <div className="mb-6">
        <p className="text-xl text-gray-500 text-center mb-1">Time Remaining</p>
        <p className="text-6xl font-bold text-center bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
          {formatTime(timeRemaining)}
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
    </div>
  )
}

export default Auto
