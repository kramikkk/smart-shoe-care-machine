'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { OctagonAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WebSocketMessage } from '@/contexts/KioskWebSocketContext'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

type KioskEmergencyStopButtonProps = {
  deviceId: string | null | undefined
  sendMessage: (msg: WebSocketMessage) => void
  /** Where to send the user after confirming (e.g. `/kiosk/stopped?...` then auto-redirect home). */
  exitHref: string
  /** Call before navigating so parent can skip redundant `stop-service` on unmount. */
  onEmergencyInitiated?: () => void
}

export function KioskEmergencyStopButton({
  deviceId,
  sendMessage,
  exitHref,
  onEmergencyInitiated,
}: KioskEmergencyStopButtonProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const handleConfirm = () => {
    onEmergencyInitiated?.()
    if (deviceId) {
      sendMessage({ type: 'stop-service', deviceId })
    }
    setOpen(false)
    router.push(exitHref)
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          size="lg"
          className="w-auto shrink-0 gap-2 px-8 font-semibold shadow-md"
          disabled={!deviceId}
          aria-label="Emergency stop"
        >
          <OctagonAlert className="size-5 shrink-0" />
          Emergency stop
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        overlayClassName="bg-slate-900/30"
        className="max-w-[min(22rem,calc(100%-2rem))] gap-5 border-0 bg-white p-8 text-gray-900 shadow-2xl outline-none ring-0 ring-offset-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:outline-none sm:max-w-md [&_[data-slot=alert-dialog-header]]:text-left [&_[data-slot=alert-dialog-header]]:sm:text-left"
      >
        <AlertDialogHeader className="gap-2">
          <AlertDialogTitle className="text-2xl font-bold text-red-600">
            Emergency stop
          </AlertDialogTitle>
          <AlertDialogDescription className="text-base leading-relaxed text-gray-600">
            Stop the machine now? You will see a short summary, then return to the home screen.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-3 sm:justify-stretch sm:space-x-0">
          <AlertDialogCancel className="mt-0 flex-1 border-gray-300 bg-white text-gray-800 hover:bg-gray-50">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="flex-1 font-semibold"
            onClick={handleConfirm}
          >
            Stop
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
