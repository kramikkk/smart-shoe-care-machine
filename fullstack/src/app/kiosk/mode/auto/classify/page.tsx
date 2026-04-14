'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Loader2, CheckCircle, AlertCircle, WifiOff, ImageOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useKioskWebSocket } from '@/contexts/KioskWebSocketContext'
import { debug } from '@/lib/debug'
import { StepIndicator } from '@/components/kiosk/StepIndicator'
import { AUTO_STEPS } from '@/lib/kiosk-constants'

type ClassificationState = 'connecting' | 'syncing' | 'classifying' | 'success' | 'error'

type ClassificationResult = {
  shoeType: 'mesh' | 'canvas' | 'rubber' | 'invalid' | 'no_shoe'
  confidence: number // -1 = manually selected
  subCategory?: string
  condition?: 'normal' | 'too_dirty'
  snapshotDataUrl?: string
}

const VALID_SHOE_TYPES = ['mesh', 'canvas', 'rubber'] as const

export default function ClassifyPage() {
  const router = useRouter()
  const {
    isConnected,
    camSynced: contextCamSynced,
    deviceId,
    sendMessage,
    subscribe,
    onMessage
  } = useKioskWebSocket()
  const [state, setState] = useState<ClassificationState>('connecting')
  const [camSynced, setCamSynced] = useState<boolean>(false)
  const [hasReceivedSyncStatus, setHasReceivedSyncStatus] = useState<boolean>(false)
  const [result, setResult] = useState<ClassificationResult | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [error, setError] = useState<string>('')
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const classificationSentRef = useRef<boolean>(false)
  const subscriptionsSetRef = useRef<boolean>(false)
  const hasResultRef = useRef<boolean>(false)
  const syncDelayRef = useRef<NodeJS.Timeout | null>(null)

  // Seed local sync state from context so we don't get stuck waiting for
  // an extra sensor/cam event before starting classification.
  useEffect(() => {
    if (!isConnected) return
    setCamSynced(contextCamSynced)
    setHasReceivedSyncStatus(true)
  }, [isConnected, contextCamSynced])

  useEffect(() => {
    if (!deviceId || deviceId === 'No device configured') {
      setError('Device not configured')
      setState('error')
      return
    }

    if (!isConnected) {
      setState('connecting')
      return
    }

    if (!subscriptionsSetRef.current) {
      subscriptionsSetRef.current = true
      subscribe(deviceId)
    }

    debug.log(`[Classify] Sending enable-classification — device: ${deviceId}, camSynced: ${camSynced}`)
    sendMessage({ type: 'enable-classification', deviceId: deviceId })

    // Don't override success/error state with sync status updates
    if (hasResultRef.current) return

    if (!hasReceivedSyncStatus) {
      setState('connecting')
      return
    }

    if (!camSynced) {
      setState('syncing')
      return
    }

    if (classificationSentRef.current) {
      return
    }

    syncDelayRef.current = setTimeout(() => {
      if (isConnected && camSynced && !classificationSentRef.current) {
        classificationSentRef.current = true
        setState('classifying')
        console.log('[Classify] Sending start-classification')
        sendMessage({ type: 'start-classification', deviceId: deviceId })

        timeoutRef.current = setTimeout(() => {
          setState((currentState) => {
            if (currentState === 'classifying') {
              setError('Classification timed out. Please try again.')
              return 'error'
            }
            return currentState
          })
        }, 15000)
      }
    }, 500)

    return () => {
      if (syncDelayRef.current) {
        clearTimeout(syncDelayRef.current)
        syncDelayRef.current = null
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [isConnected, deviceId, sendMessage, subscribe, camSynced, hasReceivedSyncStatus])

  const deviceIdRef = useRef(deviceId)
  const sendMessageRef = useRef(sendMessage)
  const isConnectedRef = useRef(isConnected)

  useEffect(() => {
    deviceIdRef.current = deviceId
    sendMessageRef.current = sendMessage
    isConnectedRef.current = isConnected
  }, [deviceId, sendMessage, isConnected])

  useEffect(() => {
    if (!isConnected || !deviceId) return

    const unsubscribe = onMessage((message) => {
      if (message.type === 'sensor-data' && message.camSynced !== undefined) {
        debug.log(`[Classify] sensor-data — camSynced: ${message.camSynced}`)
        setCamSynced(message.camSynced)
        setHasReceivedSyncStatus(true)
      }
      else if (message.type === 'cam-sync-status') {
        debug.log(`[Classify] cam-sync-status — camSynced: ${message.camSynced}`)
        setCamSynced(message.camSynced)
        setHasReceivedSyncStatus(true)
      }
      else if (message.type === 'device-update' && message.data?.camSynced !== undefined) {
        debug.log(`[Classify] device-update — camSynced: ${message.data.camSynced}`)
        setCamSynced(message.data.camSynced)
        setHasReceivedSyncStatus(true)
      }
      else if (message.type === 'device-online' && message.camSynced !== undefined) {
        debug.log(`[Classify] device-online — camSynced: ${message.camSynced}`)
        setCamSynced(message.camSynced)
        setHasReceivedSyncStatus(true)
      }
      else if (message.type === 'classification-result') {
        debug.log(`[Classify] Result — type: ${message.result}, confidence: ${(message.confidence * 100).toFixed(1)}%, condition: ${message.condition}`)
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }
        hasResultRef.current = true
        setResult({
          shoeType: message.result as ClassificationResult['shoeType'],
          confidence: message.confidence,
          subCategory: message.subCategory ?? '',
          condition: message.condition === 'too_dirty' ? 'too_dirty' : 'normal',
          snapshotDataUrl: message.snapshotBase64
            ? `data:image/jpeg;base64,${message.snapshotBase64}`
            : undefined,
        })
        setShowPicker(false)
        setState('success')
      }
      else if (message.type === 'classification-error') {
        if (hasResultRef.current) return  // already have a result — ignore late error from main board
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }
        debug.error(`[Classify] Error — ${message.error}`)
        setError(message.error || 'Classification failed')
        setState('error')
      }
      else if (message.type === 'classification-busy') {
        debug.warn('[Classify] Classification system busy')
        setError('Classification system is busy. Please wait.')
        setState('error')
      }
    })

    return () => {
      unsubscribe()
    }
  }, [isConnected, deviceId, onMessage])

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (syncDelayRef.current) clearTimeout(syncDelayRef.current)
      if (isConnectedRef.current && deviceIdRef.current) {
        sendMessageRef.current({
          type: 'disable-classification',
          deviceId: deviceIdRef.current
        })
      }
    }
  }, [])

  const handleRetry = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    classificationSentRef.current = false
    hasResultRef.current = false
    setError('')
    setResult(null)
    setShowPicker(false)

    if (!deviceId || deviceId === 'No device configured') {
      setError('Device not configured')
      setState('error')
      return
    }

    if (!camSynced) {
      setState('syncing')
      return
    }

    setState('classifying')

    if (isConnected && camSynced && !classificationSentRef.current) {
      classificationSentRef.current = true
      // Re-enable classification LED before each retry.
      // Dashboard camera tools may have turned it off after the previous attempt.
      sendMessage({ type: 'enable-classification', deviceId: deviceId })
      window.setTimeout(() => {
        sendMessage({ type: 'start-classification', deviceId: deviceId })
      }, 50)

      timeoutRef.current = setTimeout(() => {
        setState((currentState) => {
          if (currentState === 'classifying') {
            setError('Classification timed out. Please try again.')
            return 'error'
          }
          return currentState
        })
      }, 15000)
    }
  }

  const handleManualSelect = (shoeType: 'mesh' | 'canvas' | 'rubber') => {
    debug.log(`[Classify] Manual shoe type selected: ${shoeType}`)
    setResult({ shoeType, confidence: -1 })
    setShowPicker(false)
  }

  const handleProceedToPayment = () => {
    if (result && VALID_SHOE_TYPES.includes(result.shoeType as typeof VALID_SHOE_TYPES[number])) {
      router.replace(`/kiosk/payment?service=package&shoe=${encodeURIComponent(result.shoeType)}`)
    }
  }

  const handleCancel = () => {
    // Replace current history entry so browser Back won't return to classify page.
    router.replace('/kiosk/mode')
  }

  const isValidShoeType = result && VALID_SHOE_TYPES.includes(result.shoeType as typeof VALID_SHOE_TYPES[number])
  const canProceed = isValidShoeType && result?.condition !== 'too_dirty'

  // ── Non-success states: centered icon card ──────────────────────────────────
  const renderStatusCard = () => (
    <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl p-8 max-w-md w-full text-center">
      <div className="mb-6 flex justify-center">
        {state === 'connecting' && (
          <div className="w-32 h-32 rounded-full bg-gray-100 flex items-center justify-center">
            <Loader2 className="w-16 h-16 text-gray-400 animate-spin" />
          </div>
        )}
        {state === 'syncing' && (
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center animate-pulse">
            <WifiOff className="w-16 h-16 text-white" />
          </div>
        )}
        {state === 'classifying' && (
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center animate-pulse">
            <Camera className="w-16 h-16 text-white" />
          </div>
        )}
        {state === 'error' && (
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center">
            <AlertCircle className="w-16 h-16 text-white" />
          </div>
        )}
      </div>

      <div className="mb-6">
        {state === 'connecting' && (
          <>
            <h2 className="text-2xl font-bold text-gray-700 mb-2">Connecting...</h2>
            <p className="text-gray-500">Setting up camera connection</p>
          </>
        )}
        {state === 'syncing' && (
          <>
            <h2 className="text-2xl font-bold text-amber-600 mb-2">Camera Not Synced</h2>
            <p className="text-gray-500">Waiting for camera module to connect...</p>
            <div className="mt-4 flex justify-center gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-3 h-3 rounded-full bg-amber-500 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
            <p className="mt-4 text-sm text-gray-400">
              The camera module is syncing via ESP-NOW. This usually takes a few seconds.
            </p>
          </>
        )}
        {state === 'classifying' && (
          <>
            <h2 className="text-2xl font-bold text-gray-700 mb-2">Analyzing Shoe...</h2>
            <p className="text-gray-500">Please wait while we identify your shoe type</p>
            <div className="mt-4 flex justify-center gap-1">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="w-3 h-3 rounded-full bg-cyan-500 animate-bounce"
                  style={{ animationDelay: `${i * 0.1}s` }}
                />
              ))}
            </div>
          </>
        )}
        {state === 'error' && (
          <>
            <h2 className="text-2xl font-bold text-red-600 mb-2">Classification Failed</h2>
            <p className="text-gray-500">{error}</p>
          </>
        )}
      </div>

      <div className="flex gap-4 justify-center">
        <Button onClick={handleCancel} variant="outline" className="px-6 py-3">
          Cancel
        </Button>
        {state === 'error' && (
          <Button
            onClick={handleRetry}
            className="px-6 py-3 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white"
          >
            Try Again
          </Button>
        )}
      </div>
    </div>
  )

  // ── Success state: snapshot + result card ───────────────────────────────────
  const renderSuccessCard = () => {
    if (!result) return null

    if (showPicker) {
      return (
        <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl p-8 max-w-md w-full text-center">
          <h2 className="text-2xl font-bold text-gray-700 mb-2">Select Shoe Type</h2>
          <p className="text-gray-500 mb-4">Choose the material of your shoe:</p>
          <div className="flex flex-col gap-3 w-full">
            {(['mesh', 'canvas', 'rubber'] as const).map((type) => (
              <button
                key={type}
                onClick={() => handleManualSelect(type)}
                className="w-full py-4 rounded-2xl border-2 border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-all text-xl font-semibold text-gray-700 capitalize"
              >
                {type}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowPicker(false)}
            className="mt-4 text-sm text-gray-400 hover:text-gray-600 underline"
          >
            Back
          </button>
        </div>
      )
    }

    const accentColor =
      isValidShoeType && result.condition !== 'too_dirty'
        ? 'from-green-500 to-emerald-500'
        : result.shoeType === 'no_shoe'
        ? 'from-gray-400 to-gray-500'
        : 'from-amber-400 to-orange-500'

    return (
      <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl overflow-hidden max-w-3xl w-full flex flex-row">
        {/* LEFT — clean image, no overlays */}
        <div className="relative aspect-[4/3] w-[55%] flex-shrink-0 bg-gray-900">
          {result.snapshotDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={result.snapshotDataUrl}
              alt="Shoe snapshot"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-600">
              <ImageOff className="w-12 h-12" />
              <span className="text-sm">No snapshot</span>
            </div>
          )}
        </div>

        {/* RIGHT — three zones: status / info (centered) / actions */}
        <div className="flex flex-col flex-1 px-7 py-5">

          {/* Zone 1 — status + confidence */}
          <div className="flex items-center justify-between pb-4 border-b border-gray-100">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r ${accentColor} shadow-sm`}>
              {isValidShoeType
                ? <CheckCircle className="w-4 h-4 text-white" />
                : <AlertCircle className="w-4 h-4 text-white" />
              }
              <span className="text-white text-sm font-semibold">
                {isValidShoeType ? 'Shoe Detected' : result.shoeType === 'no_shoe' ? 'No Shoe' : 'Unsupported'}
              </span>
            </div>
            {result.confidence >= 0 && (
              <span className="text-sm font-semibold text-gray-400">
                {(result.confidence * 100).toFixed(0)}% match
              </span>
            )}
          </div>

          {/* Zone 2 — main info, vertically centered */}
          <div className="flex-1 flex flex-col justify-center gap-2 py-3">
            {isValidShoeType && (
              <>
                <p className="text-5xl font-bold text-gray-800 capitalize leading-tight">{result.shoeType}</p>
                {result.subCategory && (
                  <p className="text-lg text-gray-400">{result.subCategory}</p>
                )}
                <div className="mt-1">
                  {result.condition === 'too_dirty' ? (
                    <>
                      <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-red-100 text-red-700 font-semibold text-sm">
                        <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                        Too Dirty to Clean
                      </span>
                      <p className="mt-2 text-sm text-red-500">
                        Too heavily soiled. Remove excessive mud or dirt and try again.
                      </p>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-100 text-green-700 font-semibold text-sm">
                      <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                      Normal Condition
                    </span>
                  )}
                </div>
              </>
            )}

            {result.shoeType === 'no_shoe' && (
              <>
                <p className="text-3xl font-bold text-amber-600">No Shoe Detected</p>
                <p className="text-gray-400 text-sm">Place your shoe in the chamber and try again.</p>
              </>
            )}

            {result.shoeType === 'invalid' && (
              <>
                <p className="text-3xl font-bold text-amber-600">Unsupported Shoe</p>
                {result.subCategory && (
                  <p className="text-lg font-semibold text-gray-700">{result.subCategory}</p>
                )}
                <p className="text-gray-400 text-sm">We clean mesh, canvas, and rubber shoes only.</p>
              </>
            )}
          </div>

          {/* Zone 3 — actions */}
          <div className="flex items-center gap-3 pt-4 border-t border-gray-100">
            <Button onClick={handleCancel} variant="outline" className="flex-1 py-3">
              Cancel
            </Button>
            <Button
              onClick={handleRetry}
              variant={canProceed ? 'outline' : 'default'}
              className={canProceed
                ? 'flex-1 py-3'
                : 'flex-1 py-3 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white'}
            >
              Retry
            </Button>
            {canProceed && (
              <Button
                onClick={handleProceedToPayment}
                className="flex-1 py-3 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white"
              >
                Proceed
              </Button>
            )}
          </div>

        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-8">
      <StepIndicator steps={AUTO_STEPS} currentStep={1} />

      <h1 className="text-5xl font-bold text-center mb-8 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        Shoe Classification
      </h1>

      {state === 'success' ? renderSuccessCard() : renderStatusCard()}

      {/* Instructions below card */}
      {(state === 'connecting' || state === 'classifying') && (
        <p className="mt-8 text-gray-500 text-center max-w-md">
          Please ensure your shoe is placed in the scanning area and the camera has a clear view.
        </p>
      )}
      {state === 'syncing' && (
        <div className="mt-8 text-center max-w-md">
          <p className="text-amber-600 font-medium mb-2">
            Please wait while the camera syncs...
          </p>
          <p className="text-gray-400 text-sm">
            Classification will start automatically once the camera is ready.
          </p>
        </div>
      )}
    </div>
  )
}
