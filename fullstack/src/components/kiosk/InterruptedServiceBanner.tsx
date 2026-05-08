'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
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
}

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min > 0) return `${min} min ${sec} sec`
  return `${sec} sec`
}

export function InterruptedServiceBanner() {
  const { onMessage, sendMessage, deviceId } = useKioskWebSocket()
  const [interrupted, setInterrupted] = useState<InterruptedState | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isDeclinePending, setIsDeclinePending] = useState(false)

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
        setInterrupted({
          deviceId: message.deviceId as string,
          transactionId: message.transactionId as string,
          checkpoint: message.checkpoint as InterruptedCheckpoint,
          remainingMs: Number(message.remainingMs) || 0,
        })
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

  if (!interrupted) return null

  const { checkpoint, remainingMs, transactionId } = interrupted
  const targetDeviceId = interrupted.deviceId || deviceId

  const handleResume = () => {
    if (isPending || isDeclinePending) return
    setIsPending(true)
    sendMessage({ type: 'resume-confirmed', deviceId: targetDeviceId, transactionId })
  }

  const handleStartNew = () => {
    if (isPending || isDeclinePending) return
    setIsDeclinePending(true)
    sendMessage({ type: 'resume-declined', deviceId: targetDeviceId, transactionId })
    // Banner is cleared by the skip-resume message from the backend, same as handleResume.
    // This prevents the checkpoint from being stuck if the WS send fails.
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-sm rounded-2xl bg-white/10 border border-white/20 backdrop-blur-xl p-6 shadow-2xl text-white">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-500/20 border border-orange-500/30">
            <AlertTriangle className="h-5 w-5 text-orange-400" />
          </div>
          <div>
            <h2 className="font-bold text-lg leading-tight">Service Interrupted</h2>
            <p className="text-xs text-white/60">Power was cut during your service</p>
          </div>
        </div>

        <div className="mb-5 rounded-xl bg-white/5 border border-white/10 p-4 space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-white/50">Service</span>
            <span className="font-medium capitalize">{checkpoint.serviceType}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Shoe</span>
            <span className="font-medium capitalize">{checkpoint.shoeType}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Care</span>
            <span className="font-medium capitalize">{checkpoint.careType}</span>
          </div>
          <div className="flex justify-between border-t border-white/10 pt-1.5 mt-1.5">
            <span className="text-white/50">Remaining</span>
            <span className="font-semibold text-orange-300">{formatTime(remainingMs)}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <button
            onClick={handleResume}
            disabled={isPending || isDeclinePending}
            className="w-full rounded-xl bg-green-500 hover:bg-green-400 active:bg-green-600 disabled:opacity-60 disabled:cursor-not-allowed py-3 font-bold text-sm transition-colors"
          >
            {isPending ? 'Resuming...' : 'Resume Service'}
          </button>
          <button
            onClick={handleStartNew}
            disabled={isDeclinePending || isPending}
            className="w-full rounded-xl bg-white/10 hover:bg-white/15 active:bg-white/20 border border-white/10 py-3 font-semibold text-sm transition-colors text-white/80 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isDeclinePending ? 'Declining...' : 'Start New Service'}
          </button>
        </div>
      </div>
    </div>
  )
}
