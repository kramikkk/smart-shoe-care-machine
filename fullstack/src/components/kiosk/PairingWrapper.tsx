'use client'

import { useKioskWebSocket } from '@/contexts/KioskWebSocketContext'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Tablet } from 'lucide-react'
import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

const DEVICE_ID_KEY = 'kiosk_device_id'

interface PairingWrapperProps {
  children: React.ReactNode
}

export default function PairingWrapper({ children }: PairingWrapperProps) {
  const { isPaired, pairingCode, deviceId } = useKioskWebSocket()
  const [setupInput, setSetupInput] = useState('')
  const [setupError, setSetupError] = useState('')

  const handleSaveDeviceId = () => {
    const trimmed = setupInput.trim().toUpperCase()
    if (!/^SSCM-[A-F0-9]{6}$/.test(trimmed)) {
      setSetupError('Format must be SSCM-XXXXXX (e.g. SSCM-XXXXXX)')
      return
    }
    localStorage.setItem(DEVICE_ID_KEY, trimmed)
    window.location.reload()
  }

  // Show loading state
  if (isPaired === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-green-200 via-cyan-200 to-blue-400">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-900 text-lg font-semibold bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
            Checking device status...
          </p>
        </div>
      </div>
    )
  }

  // No device configured — show first-time setup form
  if (deviceId === 'No device configured') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-green-200 via-cyan-200 to-blue-400 p-4">
        <Card className="w-full max-w-md bg-white/90 border-gray-200 backdrop-blur-sm shadow-2xl">
          <CardHeader className="text-center pb-4">
            <div className="flex justify-center mb-4">
              <div className="bg-blue-500/10 p-8 rounded-full border-2 border-blue-500/30">
                <Tablet className="h-16 w-16 text-blue-500" />
              </div>
            </div>
            <CardTitle className="text-3xl font-bold bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
              Kiosk Setup
            </CardTitle>
            <CardDescription className="text-base text-gray-600 mt-1">
              Enter the Device ID printed on your ESP32 unit to link this tablet to it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-gray-500 text-center">Device ID</p>
              <Input
                placeholder="SSCM-XXXXXX"
                value={setupInput}
                onChange={(e) => {
                  setSetupInput(e.target.value)
                  setSetupError('')
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveDeviceId()}
                className="text-center font-mono text-lg tracking-widest text-gray-900"
              />
              {setupError && (
                <p className="text-xs text-red-500 text-center">{setupError}</p>
              )}
            </div>
            <Button
              className="w-full bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 text-white"
              onClick={handleSaveDeviceId}
              disabled={!setupInput.trim()}
            >
              Link Tablet to Device
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Device is configured but not paired — show pairing screen with QR code
  if (isPaired === false) {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const qrUrl = pairingCode
      ? `${origin}/client/dashboard/settings?pair=${deviceId}&code=${pairingCode}`
      : ''

    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-green-200 via-cyan-200 to-blue-400 p-6">
        <Card className="w-full max-w-2xl bg-white/90 border-gray-200 backdrop-blur-sm shadow-2xl overflow-hidden">
          <CardContent className="p-8">
            <div className="flex gap-8 items-center">
              {/* Left: title + info */}
              <div className="flex flex-col justify-center gap-5 flex-1 min-w-0">
                <span className="text-3xl font-bold bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
                  Device Not Paired
                </span>
                <p className="text-sm text-gray-600">
                  Scan the QR code with your phone → log in as admin → confirm pairing
                </p>

                {/* Pairing Code */}
                <div className="bg-gradient-to-r from-blue-50 to-cyan-50 border-2 border-blue-200 rounded-lg p-3">
                  <p className="text-center text-sm text-gray-600 mb-2">Pairing Code</p>
                  {pairingCode ? (
                    <div className="flex justify-center items-center gap-2">
                      {pairingCode.split('').map((digit, index) => (
                        <div
                          key={index}
                          className="w-10 h-12 flex items-center justify-center bg-white border-2 border-blue-300 rounded-lg shadow-sm"
                        >
                          <span className="text-xl font-bold bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
                            {digit}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center text-sm text-gray-500">Waiting for code...</p>
                  )}
                </div>

                {/* Device ID */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <p className="text-sm text-gray-500 text-center mb-1">Device ID</p>
                  <p className="text-base font-mono text-center text-gray-700">{deviceId}</p>
                </div>
              </div>

              {/* Right: QR code */}
              <div className="flex flex-col items-center gap-2 shrink-0">
                {qrUrl ? (
                  <div className="bg-white p-4 rounded-xl border-2 border-blue-200 shadow-sm">
                    <QRCodeSVG value={qrUrl} size={200} />
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">Generating QR code...</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Device is paired - show normal kiosk UI
  return <>{children}</>
}
