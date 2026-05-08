'use client'

import { useEffect, useState, useRef } from 'react'
import { AlertTriangle, Clock } from 'lucide-react'
import { useKioskWebSocket } from '@/contexts/KioskWebSocketContext'

interface InterruptedCheckpoint {
  serviceType: string
  shoeType: string
  careType: string
  remainingMs: number
  cyclesCompleted: number
  transactionId: string
}

interface InterruptedState {
  deviceId: string
  transactionId: string
  checkpoint: InterruptedCheckpoint
  remainingMs: number
  guardExpiresAtMs: number
}

function formatServiceTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min > 0) return `${min} min ${sec} sec`
  return `${sec} sec`
}

function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function InterruptedServiceBanner() {
  const { onMessage, sendMessage, deviceId } = useKioskWebSocket()
  const [interrupted, setInterrupted] = useState<InterruptedState | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isDeclinePending, setIsDeclinePending] = useState(false)
  const [decisionSecondsLeft, setDecisionSecondsLeft] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Safety net: if the backend never responds after tapping a button (e.g. WS dead),
  // reset pending state after 15 s so the customer is not permanently locked out.
  useEffect(() => {
    if (!isPending && !isDeclinePending) return
    const timer = setTimeout(() => {
      setIsPending(false)
      setIsDeclinePending(false)
    }, 15_000)
    return () => clearTimeout(timer)
  }, [isPending, isDeclinePending])

  useEffect(() => {
    const cleanup = onMessage((message) => {
      if (message.type === 'service-interrupted' && message.transactionId && message.checkpoint) {
        const expiresAt = Number(message.guardExpiresAtMs) || Date.now() + 30 * 60 * 1000
        setInterrupted({
          deviceId: message.deviceId as string,
          transactionId: message.transactionId as string,
          checkpoint: message.checkpoint as InterruptedCheckpoint,
          remainingMs: Number(message.remainingMs) || 0,
          guardExpiresAtMs: expiresAt,
        })
        setDecisionSecondsLeft(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)))
        setIsPending(false)
        setIsDeclinePending(false)
      }
      // Dismiss when the device confirms a running service or the backend skips resume
      if (message.type === 'service-status' || message.type === 'skip-resume') {
        setInterrupted(null)
        setIsPending(false)
        setIsDeclinePending(false)
      }
    })
    return cleanup
  }, [onMessage])

  // Live countdown of the decision window
  useEffect(() => {
    if (!interrupted) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }
    intervalRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.floor((interrupted.guardExpiresAtMs - Date.now()) / 1000))
      setDecisionSecondsLeft(remaining)
    }, 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [interrupted])

  if (!interrupted) return null

  const { checkpoint, remainingMs, transactionId } = interrupted
  const targetDeviceId = interrupted.deviceId || deviceId
  const isExpiring = decisionSecondsLeft <= 60

  const handleResume = () => {
    if (isPending || isDeclinePending) return
    setIsPending(true)
    sendMessage({ type: 'resume-confirmed', deviceId: targetDeviceId, transactionId })
  }

  const handleStartNew = () => {
    if (isPending || isDeclinePending) return
    setIsDeclinePending(true)
    sendMessage({ type: 'resume-declined', deviceId: targetDeviceId, transactionId })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-lg rounded-3xl bg-white/90 px-10 py-8 shadow-2xl backdrop-blur-md">

        {/* Icon */}
        <div className="mb-4 flex justify-center">
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 shadow-xl">
            <AlertTriangle className="h-12 w-12 text-white" strokeWidth={2.5} />
          </div>
        </div>

        {/* Title */}
        <h1 className="mb-1 text-center text-3xl font-bold bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 bg-clip-text text-transparent">
          Service Interrupted
        </h1>
        <p className="mb-5 text-center text-base text-gray-500">
          Power was cut during your service
        </p>

        {/* Badges */}
        <div className="mb-4 flex flex-wrap justify-center gap-2">
          <span className="inline-block rounded-full bg-gradient-to-r from-purple-100 to-pink-100 px-4 py-1.5 text-sm font-semibold text-purple-800 shadow-sm">
            {capitalize(checkpoint.shoeType)} Type
          </span>
          <span className="inline-block rounded-full bg-gradient-to-r from-blue-100 to-cyan-100 px-4 py-1.5 text-sm font-semibold text-blue-800 shadow-sm">
            {capitalize(checkpoint.serviceType)}
          </span>
          <span className="inline-block rounded-full bg-gradient-to-r from-green-100 to-emerald-100 px-4 py-1.5 text-sm font-semibold text-green-800 shadow-sm">
            {capitalize(checkpoint.careType)} Care
          </span>
        </div>

        {/* Service time remaining */}
        <div className="mb-3 rounded-xl bg-gradient-to-r from-orange-50 to-amber-50 px-5 py-4 text-center border border-orange-100">
          <p className="text-sm text-gray-500 mb-1">Time remaining when interrupted</p>
          <p className="text-3xl font-bold bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 bg-clip-text text-transparent">
            {formatServiceTime(remainingMs)}
          </p>
        </div>

        {/* Decision window countdown */}
        <div className={`mb-6 rounded-xl px-5 py-3 text-center border flex items-center justify-center gap-2 transition-colors duration-300 ${
          isExpiring
            ? 'bg-red-50 border-red-200'
            : 'bg-gradient-to-r from-blue-50 to-cyan-50 border-blue-100'
        }`}>
          <Clock className={`h-4 w-4 shrink-0 ${isExpiring ? 'text-red-500' : 'text-blue-400'}`} />
          <p className={`text-sm ${isExpiring ? 'text-red-600' : 'text-gray-500'}`}>
            Resume offer expires in
          </p>
          <p className={`text-lg font-bold tabular-nums ${
            isExpiring
              ? 'text-red-600'
              : 'bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent'
          }`}>
            {formatCountdown(decisionSecondsLeft)}
          </p>
        </div>

        {/* Buttons */}
        <div className="flex flex-col gap-3">
          <button
            onClick={handleResume}
            disabled={isPending || isDeclinePending}
            className="w-full rounded-full bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 py-5 text-lg font-bold text-white shadow-lg transition-all duration-200 hover:from-blue-700 hover:via-cyan-700 hover:to-green-700 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {isPending ? 'Resuming…' : 'Resume Service'}
          </button>
          <button
            onClick={handleStartNew}
            disabled={isDeclinePending || isPending}
            className="w-full rounded-full border-2 border-gray-300 bg-white py-5 text-lg font-bold text-gray-700 shadow-sm transition-all duration-200 hover:bg-gray-50 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {isDeclinePending ? 'Declining…' : 'Start New Service'}
          </button>
        </div>

      </div>
    </div>
  )
}
