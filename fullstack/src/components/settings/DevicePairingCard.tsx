'use client'

import { Smartphone, Wifi, WifiOff, Check, X, Pencil, Camera, Clock, CalendarDays, User, Loader2, Plus } from "lucide-react"
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
  onPairingDialogOpenChange: (open: boolean) => void
  onPairingDeviceIdChange: (value: string) => void
  onPairingCodeChange: (value: string) => void
  onPairDevice: () => void
  onEditingDeviceIdChange: (id: string | null) => void
  onEditingDeviceNameChange: (name: string) => void
  onSaveDeviceName: (deviceId: string, name: string) => Promise<void>
}

export function DevicePairingCard({
  devices: initialDevices,
  isPairing,
  pairingDialogOpen,
  pairingDeviceId,
  pairingCode,
  editingDeviceId,
  editingDeviceName,
  onPairingDialogOpenChange,
  onPairingDeviceIdChange,
  onPairingCodeChange,
  onPairDevice,
  onEditingDeviceIdChange,
  onEditingDeviceNameChange,
  onSaveDeviceName,
}: DevicePairingCardProps) {
  const { isConnected } = useDashboardWebSocket()
  const { selectedDevice } = useDeviceFilter()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const formatLiveLastSeen = (date: Date | string | null): string => {
    if (!date) return 'Never'
    const d = date instanceof Date ? date : new Date(date)
    if (isNaN(d.getTime())) return 'Never'
    const diffSecs = Math.max(0, Math.floor((now - d.getTime()) / 1000))
    if (diffSecs < 60) return diffSecs <= 1 ? 'Just now' : `${diffSecs}s ago`
    const diffMins = Math.floor(diffSecs / 60)
    if (diffMins < 60) return diffMins === 1 ? '1 min ago' : `${diffMins} mins ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return diffHours === 1 ? '1 hr ago' : `${diffHours} hrs ago`
    const diffDays = Math.floor(diffHours / 24)
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`
  }

  return (
    <>
      <Card className="glass-card border-none">
        <CardHeader>
          {/* Always a single row — button stays in the header, icon-only on small screens */}
          <div className="flex items-start justify-between gap-3">
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
                <Button className="shrink-0 gap-2">
                  <Plus className="h-4 w-4" />
                  <span className="hidden sm:inline">Pair New Device</span>
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
              <div className="flex flex-col items-center justify-center py-14 rounded-xl border-2 border-dashed border-border/40">
                <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
                  <Smartphone className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="font-semibold text-sm">No devices paired yet</p>
                <p className="text-sm text-muted-foreground mt-1">Click the + button above to get started</p>
              </div>
            ) : (
              initialDevices.map((device) => {
                const isCurrentActive = device.deviceId === selectedDevice
                const isActuallyConnected = isCurrentActive ? isConnected : (device.status === 'connected')
                const isActuallyPairing = device.status === 'pairing'

                const statusColor = isActuallyConnected ? '#22c55e' : isActuallyPairing ? '#f59e0b' : '#6b7280'
                const iconBg = isActuallyConnected
                  ? 'bg-green-500/10 text-green-500 shadow-[0_0_15px_-5px_rgba(34,197,94,0.3)]'
                  : isActuallyPairing
                  ? 'bg-amber-500/10 text-amber-500'
                  : 'bg-gray-500/10 text-gray-500'
                const badgeClass = isActuallyConnected
                  ? 'bg-green-500/10 text-green-400 border-green-500/20 shadow-[0_0_10px_-2px_rgba(34,197,94,0.2)]'
                  : isActuallyPairing
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  : 'bg-gray-500/10 text-gray-400 border-gray-500/20'

                const lastSeenText = isActuallyConnected ? 'Active' : formatLiveLastSeen(device.lastSeen)

                return (
                  <div
                    key={device.id}
                    className={`rounded-xl border border-white/5 p-4 transition-all hover:brightness-110 ${isCurrentActive && isActuallyConnected ? 'shadow-[inset_0_1px_1px_rgba(255,255,255,0.05),0_10px_30px_-15px_rgba(0,0,0,0.5)]' : ''}`}
                    style={{
                      borderLeft: `3px solid ${statusColor}`,
                      background: `color-mix(in srgb, ${statusColor} 6%, transparent)`,
                    }}
                  >
                    <div className="flex items-start gap-3">
                      {/* Status icon */}
                      <div className={`p-2.5 rounded-lg shrink-0 transition-all duration-500 ${iconBg}`}>
                        {isActuallyConnected ? <Wifi className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
                      </div>

                      {/* Main content */}
                      <div className="flex-1 min-w-0">
                        {/* Name + status badge row */}
                        <div className="flex items-start justify-between gap-2 mb-0.5">
                          <div className="min-w-0 flex-1">
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
                                <span className="font-semibold text-sm leading-tight truncate">
                                  {device.name || 'Smart Shoe Care Machine'}
                                </span>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-5 w-5 shrink-0 opacity-30 hover:opacity-80 transition-opacity"
                                  onClick={() => {
                                    onEditingDeviceIdChange(device.deviceId)
                                    onEditingDeviceNameChange(device.name || 'Smart Shoe Care Machine')
                                  }}
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                              </div>
                            )}
                            <p className="text-xs font-mono text-muted-foreground/50 mt-0.5 leading-none">
                              {device.deviceId}
                            </p>
                          </div>

                          {/* Status badge — anchored top-right, adjacent to name */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            {isActuallyConnected && (
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500 shadow-[0_0_8px_rgba(34,197,94,1)]" />
                              </span>
                            )}
                            <Badge variant="outline" className={`text-[10px] h-5 px-2 font-medium transition-colors duration-500 ${badgeClass}`}>
                              {isActuallyConnected ? 'Online' : isActuallyPairing ? 'Pairing' : 'Offline'}
                            </Badge>
                          </div>
                        </div>

                        {/* Metadata — flex-wrap row with · separators visible on sm+ */}
                        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-y-1 sm:gap-x-0 pt-2.5 mt-2 border-t border-white/5 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1.5 min-w-0 sm:pr-3">
                            <Camera className="h-3 w-3 shrink-0 opacity-50" />
                            <span className="opacity-50 shrink-0">Camera</span>
                            <span className="font-mono text-foreground/70 truncate">{device.camDeviceId || '—'}</span>
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

                          <span className="hidden sm:inline opacity-20 select-none pr-3">·</span>

                          <div className="flex items-center gap-1.5 sm:pr-3">
                            <Clock className="h-3 w-3 shrink-0 opacity-50" />
                            <span className="opacity-50 shrink-0">Last seen</span>
                            <span className={`tabular-nums ${isCurrentActive && isActuallyConnected ? 'text-green-400/80' : 'text-foreground/70'}`}>
                              {lastSeenText}
                            </span>
                          </div>

                          {device.pairedAt && (
                            <>
                              <span className="hidden sm:inline opacity-20 select-none pr-3">·</span>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <CalendarDays className="h-3 w-3 shrink-0 opacity-50" />
                                <span className="opacity-50 shrink-0">Paired</span>
                                <span className="text-foreground/70">{new Date(device.pairedAt).toLocaleDateString()}</span>
                                {device.pairedByUser && (
                                  <>
                                    <User className="h-3 w-3 shrink-0 opacity-50" />
                                    <span className="opacity-50 shrink-0">by</span>
                                    <span className="text-foreground/70">{device.pairedByUser.name}</span>
                                  </>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
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
