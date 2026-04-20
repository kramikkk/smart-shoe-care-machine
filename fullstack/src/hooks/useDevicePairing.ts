"use client"

import { useState, useEffect, useRef } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { toast } from "sonner"

type Device = {
  id: string; deviceId: string; name: string | null; pairingCode: string | null
  paired: boolean; pairedAt: string | null; pairedBy: string | null; lastSeen: string
  createdAt: string; camSynced: boolean; camDeviceId: string | null
  online?: boolean
  pairedByUser?: { name: string; email: string }
}

export type DeviceWithStatus = Device & { status: 'connected' | 'disconnected' | 'pairing' }

function withStatus(devices: Device[]): DeviceWithStatus[] {
  return devices.filter(d => d.paired).map(d => ({
    ...d,
    // Prefer authoritative in-memory WS liveness from backend; fallback to lastSeen
    // only if older API payloads do not include `online`.
    status: d.online !== undefined
      ? (d.online ? 'connected' : 'disconnected')
      : (d.lastSeen && (Date.now() - new Date(d.lastSeen).getTime()) / 1000 < 12 ? 'connected' : 'disconnected'),
  }))
}

export function useDevicePairing() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [devices, setDevices] = useState<DeviceWithStatus[]>([])
  const [isPairing, setIsPairing] = useState(false)
  const [pairingDialogOpen, setPairingDialogOpen] = useState(false)
  const [pairingDeviceId, setPairingDeviceId] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [editingDeviceName, setEditingDeviceName] = useState('')
  const [restartingDeviceId, setRestartingDeviceId] = useState<string | null>(null)
  const [unpairConfirmId, setUnpairConfirmId] = useState<string | null>(null)
  const autoOpenedRef = useRef(false)

  const refreshDevices = async () => {
    try {
      const res = await fetch('/api/device/list')
      const data = await res.json()
      if (data.success) setDevices(withStatus(data.devices))
    } catch (error) {
      console.error('[DevicePairing] Failed to refresh devices:', error)
    }
  }

  useEffect(() => {
    if (autoOpenedRef.current) return
    const pair = searchParams.get('pair')
    const code = searchParams.get('code')
    if (pair && code) {
      autoOpenedRef.current = true
      setPairingDeviceId(pair); setPairingCode(code); setPairingDialogOpen(true)
    }
  }, [searchParams])

  useEffect(() => {
    refreshDevices()
    const interval = setInterval(refreshDevices, 10000)
    return () => clearInterval(interval)
  }, [])

  const handlePairDevice = async () => {
    if (!pairingDeviceId || !pairingCode) { toast.error('Please enter both device ID and pairing code'); return }
    if (pairingCode.length !== 6) { toast.error('Pairing code must be 6 digits'); return }
    setIsPairing(true)
    try {
      const res = await fetch(`/api/device/${pairingDeviceId}/pair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success('Device paired successfully!')
        setPairingDialogOpen(false); setPairingDeviceId(''); setPairingCode('')
        router.replace('/client/dashboard/pairing')
        await refreshDevices()
      } else { toast.error(data.error || 'Failed to pair device') }
    } catch (error) { console.error('[DevicePairing] Pair failed:', error); toast.error('Failed to pair device') }
    finally { setIsPairing(false) }
  }

  const handleUnpairDevice = async (deviceId: string) => {
    try {
      const res = await fetch(`/api/device/${deviceId}/pair`, { method: 'DELETE' })
      const data = await res.json()
      if (data.success) { toast.success('Device unpaired successfully'); await refreshDevices() }
      else toast.error(data.error || 'Failed to unpair device')
    } catch (error) { console.error('[DevicePairing] Unpair failed:', error); toast.error('Failed to unpair device') }
  }

  const handleRestartDevice = async (deviceId: string) => {
    setRestartingDeviceId(deviceId)
    try {
      const res = await fetch(`/api/device/${deviceId}/restart`, { method: 'POST' })
      const data = await res.json()
      if (data.success) toast.success('Restart command sent')
      else toast.error(data.error || 'Failed to send restart command')
    } catch (error) { console.error('[DevicePairing] Restart failed:', error); toast.error('Failed to restart device') }
    finally { setRestartingDeviceId(null) }
  }

  const handleSaveDeviceName = async (deviceId: string, name: string) => {
    try {
      const res = await fetch(`/api/device/${deviceId}/name`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (data.success) {
        setDevices(prev => prev.map(d => d.deviceId === deviceId ? { ...d, name } : d))
        setEditingDeviceId(null)
        toast.success('Device name updated')
      } else toast.error(data.error || 'Failed to update name')
    } catch (error) { console.error('[DevicePairing] Name update failed:', error); toast.error('Failed to update name') }
  }

  const formatLastSeen = (dateString: string) => {
    const diffMins = Math.floor((Date.now() - new Date(dateString).getTime()) / 60000)
    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins} min ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
    const diffDays = Math.floor(diffHours / 24)
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`
  }

  return {
    devices, isPairing, pairingDialogOpen, pairingDeviceId, pairingCode,
    editingDeviceId, editingDeviceName, restartingDeviceId, unpairConfirmId,
    setPairingDialogOpen, setPairingDeviceId, setPairingCode,
    setEditingDeviceId, setEditingDeviceName, setUnpairConfirmId,
    handlePairDevice, handleUnpairDevice, handleRestartDevice, handleSaveDeviceName, formatLastSeen,
  }
}
