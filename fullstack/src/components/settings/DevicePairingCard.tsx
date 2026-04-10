'use client'

import { Smartphone, Wifi, WifiOff, Check, X, Pencil, Loader2, RotateCcw, Camera, Clock, CalendarDays, User } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useDashboardWebSocket } from "@/contexts/DashboardWebSocketContext"
import { useDeviceFilter } from "@/contexts/DeviceFilterContext"
import { useState, useEffect } from "react"

type Device = {
  id: string
  deviceId: string
  name: string | null
  pairingCode: string | null
  paired: boolean
  pairedAt: string | null
  pairedBy: string | null
  lastSeen: string
  createdAt: string
  camSynced: boolean
  camDeviceId: string | null
  pairedByUser?: {
    name: string
    email: string
  }
}

type DeviceWithStatus = Device & {
  status: 'connected' | 'disconnected' | 'pairing'
}

type DevicePairingCardProps = {
  devices: DeviceWithStatus[]
  isPairing: boolean
  pairingDialogOpen: boolean
  pairingDeviceId: string
  pairingCode: string
  editingDeviceId: string | null
  editingDeviceName: string
  restartingDeviceId: string | null
  unpairConfirmId: string | null
  onPairingDialogOpenChange: (open: boolean) => void
  onPairingDeviceIdChange: (value: string) => void
  onPairingCodeChange: (value: string) => void
  onPairDevice: () => void
  onUnpairDevice: (deviceId: string) => void
  onRestartDevice: (deviceId: string) => void
  onEditingDeviceIdChange: (id: string | null) => void
  onEditingDeviceNameChange: (name: string) => void
  onSaveDeviceName: (deviceId: string, name: string) => Promise<void>
  onUnpairConfirmIdChange: (id: string | null) => void
  formatLastSeen: (dateString: string) => string
}

export function DevicePairingCard({
  devices: initialDevices,
  isPairing,
  pairingDialogOpen,
  pairingDeviceId,
  pairingCode,
  editingDeviceId,
  editingDeviceName,
  restartingDeviceId,
  unpairConfirmId,
  onPairingDialogOpenChange,
  onPairingDeviceIdChange,
  onPairingCodeChange,
  onPairDevice,
  onUnpairDevice,
  onRestartDevice,
  onEditingDeviceIdChange,
  onEditingDeviceNameChange,
  onSaveDeviceName,
  onUnpairConfirmIdChange,
  formatLastSeen,
}: DevicePairingCardProps) {
  const { isConnected, sensorData } = useDashboardWebSocket()
  const { selectedDevice } = useDeviceFilter()
  const [now, setNow] = useState(Date.now())

  // Keep the relative time ticking every second for the "Live" experience
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const formatLiveLastSeen = (lastUpdate: Date | null) => {
    if (!lastUpdate) return 'Just now'
    const diffSecs = Math.floor((now - lastUpdate.getTime()) / 1000)
    if (diffSecs < 1) return 'Just now'
    if (diffSecs < 60) return `${diffSecs} sec${diffSecs > 1 ? 's' : ''} ago`
    const diffMins = Math.floor(diffSecs / 60)
    return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`
  }

  return (
    <>
      {/* Unpair Confirm Dialog */}
      <Dialog open={!!unpairConfirmId} onOpenChange={(open) => { if (!open) onUnpairConfirmIdChange(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unpair Device</DialogTitle>
            <DialogDescription>
              Are you sure you want to unpair this device? The machine will need to be re-paired to reconnect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onUnpairConfirmIdChange(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (unpairConfirmId) onUnpairDevice(unpairConfirmId)
                onUnpairConfirmIdChange(null)
              }}
            >
              Unpair
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="glass-card border-none">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Smartphone className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">Device Pairing</CardTitle>
              </div>
              <CardDescription className="mt-1">
                Manage connected shoe care machines. Pair devices using device ID and pairing code from kiosk.
              </CardDescription>
            </div>
            <Dialog open={pairingDialogOpen} onOpenChange={onPairingDialogOpenChange}>
              <DialogTrigger asChild>
                <Button className="gap-2 w-full sm:w-auto sm:shrink-0">
                  <Smartphone className="h-4 w-4" />
                  Pair New Device
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Pair New Device</DialogTitle>
                  <DialogDescription>
                    Enter the device ID and 6-digit pairing code displayed on the kiosk screen.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="deviceId">Device ID</Label>
                    <Input
                      id="deviceId"
                      placeholder="e.g., SSCM-XXXXXX"
                      value={pairingDeviceId}
                      onChange={(e) => onPairingDeviceIdChange(e.target.value.toUpperCase())}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pairingCode">Pairing Code</Label>
                    <Input
                      id="pairingCode"
                      placeholder="6-digit code"
                      maxLength={6}
                      value={pairingCode}
                      onChange={(e) => onPairingCodeChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      onPairingDialogOpenChange(false)
                      onPairingDeviceIdChange('')
                      onPairingCodeChange('')
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={onPairDevice}
                    disabled={isPairing || !pairingDeviceId || pairingCode.length !== 6}
                  >
                    {isPairing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Pairing...
                      </>
                    ) : (
                      'Pair Device'
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>

        <CardContent>
          <div className="space-y-3">
            {initialDevices.length === 0 ? (
              <div className="text-center py-12 border-2 border-dashed rounded-xl">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-muted mb-3">
                  <Smartphone className="h-7 w-7 text-muted-foreground" />
                </div>
                <p className="font-medium text-muted-foreground">No devices paired yet</p>
                <p className="text-sm text-muted-foreground mt-1">Click &quot;Pair New Device&quot; to get started</p>
              </div>
            ) : (
              initialDevices.map((device) => {
                // Real-time override for the active (selected) device
                const isCurrentActive = device.deviceId === selectedDevice
                const isActuallyConnected = isCurrentActive ? isConnected : (device.status === 'connected')
                const isActuallyPairing = device.status === 'pairing'
                
                const accentColor = isActuallyConnected ? 'border-l-green-500' : isActuallyPairing ? 'border-l-amber-500' : 'border-l-gray-500'
                const iconBg = isActuallyConnected ? 'bg-green-500/10 text-green-500 shadow-[0_0_15px_-5px_rgba(34,197,94,0.3)]' : isActuallyPairing ? 'bg-amber-500/10 text-amber-500' : 'bg-gray-500/10 text-gray-500'
                const badgeClass = isActuallyConnected
                  ? 'bg-green-500/10 text-green-400 border-green-500/20 shadow-[0_0_10px_-2px_rgba(34,197,94,0.2)]'
                  : isActuallyPairing
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  : 'bg-gray-500/10 text-gray-400 border-gray-500/20'

                const lastSeenText = (isCurrentActive && isActuallyConnected)
                  ? formatLiveLastSeen(sensorData.lastUpdate)
                  : formatLastSeen(device.lastSeen)

                return (
                  <div
                    key={device.id}
                    className={`rounded-xl border border-white/5 border-l-2 ${accentColor} bg-white/[0.02] p-4 transition-all hover:bg-white/[0.04] ${isCurrentActive && isActuallyConnected ? 'shadow-[inset_0_1px_1px_rgba(255,255,255,0.05),0_10px_30px_-15px_rgba(0,0,0,0.5)]' : ''}`}
                  >
                    {/* Top row: icon + name/status | actions icon-only on mobile, labeled on sm+ */}
                    <div className="flex items-start gap-2 mb-3">
                      <div className={`p-2.5 rounded-lg shrink-0 transition-all duration-500 ${iconBg}`}>
                        {isActuallyConnected ? <Wifi className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
                      </div>

                      <div className="flex-1 min-w-0">
                        {editingDeviceId === device.deviceId ? (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Input
                              value={editingDeviceName}
                              onChange={(e) => onEditingDeviceNameChange(e.target.value)}
                              className="h-7 w-full max-w-[200px] text-sm"
                              autoFocus
                              onKeyDown={async (e) => {
                                if (e.key === 'Enter') await onSaveDeviceName(device.deviceId, editingDeviceName)
                                else if (e.key === 'Escape') onEditingDeviceIdChange(null)
                              }}
                            />
                            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => onSaveDeviceName(device.deviceId, editingDeviceName)}>
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => onEditingDeviceIdChange(null)}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-semibold text-sm leading-tight break-words">
                              {device.name || 'Smart Shoe Care Machine'}
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-5 w-5 shrink-0 opacity-40 hover:opacity-100"
                              onClick={() => {
                                onEditingDeviceIdChange(device.deviceId)
                                onEditingDeviceNameChange(device.name || 'Smart Shoe Care Machine')
                              }}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                          </div>
                        )}

                        <div className="flex items-center gap-1.5 mt-0.5">
                          {isActuallyConnected && (
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500 shadow-[0_0_8px_rgba(34,197,94,1)]" />
                            </span>
                          )}
                          <Badge variant="outline" className={`text-[10px] h-4 px-1.5 transition-colors duration-500 ${badgeClass}`}>
                            {isActuallyConnected ? 'Online' : isActuallyPairing ? 'Pairing' : 'Offline'}
                          </Badge>
                        </div>
                      </div>

                      {/* Actions: icon-only on mobile, labeled on sm+ */}
                      {device.paired && (
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onRestartDevice(device.deviceId)}
                            disabled={restartingDeviceId === device.deviceId}
                            className="h-7 w-7 sm:w-auto sm:px-2.5 text-xs text-amber-500 hover:text-amber-400 hover:bg-amber-500/10 gap-1"
                          >
                            {restartingDeviceId === device.deviceId ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3 w-3" />
                            )}
                            <span className="hidden sm:inline">Restart</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onUnpairConfirmIdChange(device.deviceId)}
                            className="h-7 w-7 sm:w-auto sm:px-2.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1"
                          >
                            <X className="h-3 w-3" />
                            <span className="hidden sm:inline">Unpair</span>
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Metadata grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 mt-1 pl-0 sm:pl-[52px]">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                        <Smartphone className="h-3 w-3 shrink-0 opacity-60" />
                        <span className="opacity-60 shrink-0">Device ID</span>
                        <span className="font-mono text-foreground/80 truncate">{device.deviceId}</span>
                      </div>

                      <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                        <Camera className="h-3 w-3 shrink-0 opacity-60" />
                        <span className="opacity-60 shrink-0">Camera</span>
                        <span className="font-mono text-foreground/80 truncate flex-1">{device.camDeviceId || '—'}</span>
                        <Badge
                          variant="outline"
                          className={`text-[10px] h-4 px-1.5 shrink-0 ${
                            device.camSynced
                              ? 'bg-green-500/10 text-green-400 border-green-500/20'
                              : 'bg-gray-500/10 text-gray-400 border-gray-500/20'
                          }`}
                        >
                          {device.camSynced ? 'Synced' : 'Not Synced'}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3 shrink-0 opacity-60" />
                        <span className="opacity-60 shrink-0">Last seen</span>
                        <span className={`text-foreground/80 tabular-nums ${isCurrentActive && isActuallyConnected ? 'text-green-400/90' : ''}`}>
                          {lastSeenText}
                        </span>
                      </div>

                      {device.pairedAt && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                          <CalendarDays className="h-3 w-3 shrink-0 opacity-60" />
                          <span className="opacity-60 shrink-0">Paired</span>
                          <span className="text-foreground/80">{new Date(device.pairedAt).toLocaleDateString()}</span>
                          {device.pairedByUser && (
                            <>
                              <User className="h-3 w-3 shrink-0 opacity-60" />
                              <span className="opacity-60 shrink-0">by</span>
                              <span className="text-foreground/80">{device.pairedByUser.name}</span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </CardContent>
      </Card>
    </>
  )
}
