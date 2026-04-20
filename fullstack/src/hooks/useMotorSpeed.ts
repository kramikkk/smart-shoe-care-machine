import { useState, useEffect } from 'react'
import { toast } from 'sonner'

type MotorSpeedEntry = { careType: string; speedPwm: number }
type SpeedMap = Record<string, number>

const FIRMWARE_DEFAULTS: SpeedMap = { gentle: 230, normal: 242, strong: 255 }

export function useMotorSpeed(selectedDevice: string | null) {
  const [speeds, setSpeeds]           = useState<SpeedMap>({})
  const [editedSpeeds, setEditedSpeeds] = useState<SpeedMap>({})
  const [isLoading, setIsLoading]     = useState(true)
  const [isSaving, setIsSaving]       = useState(false)

  useEffect(() => {
    if (!selectedDevice) { setIsLoading(false); return }
    setIsLoading(true)
    fetch(`/api/motor-speed?deviceId=${selectedDevice}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          const map: SpeedMap = {}
          data.speeds.forEach((item: MotorSpeedEntry) => {
            map[item.careType] = item.speedPwm
          })
          setSpeeds(map)
          setEditedSpeeds({ ...map })
        }
      })
      .catch(() => toast.error('Failed to load motor speeds'))
      .finally(() => setIsLoading(false))
  }, [selectedDevice])

  const handleSpeedChange = (careType: string, value: string) => {
    const num = parseInt(value)
    if (!isNaN(num) && num >= 0 && num <= 255) {
      setEditedSpeeds(prev => ({ ...prev, [careType]: num }))
    }
  }

  const hasSpeedChanges = (careType: string) =>
    speeds[careType] !== editedSpeeds[careType]

  const handleSaveSpeed = async (careType: string) => {
    const speedPwm = editedSpeeds[careType]
    if (speedPwm === undefined || speedPwm < 0) { toast.error('Speed must be 0 or greater'); return }
    setIsSaving(true)
    try {
      const res = await fetch('/api/motor-speed', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ careType, speedPwm, deviceId: selectedDevice }),
      })
      const data = await res.json()
      if (data.success) {
        setSpeeds(prev => ({ ...prev, [careType]: speedPwm }))
        toast.success(`Motor speed (${careType}) updated to ${speedPwm} PWM`)
      } else {
        toast.error(data.error || 'Failed to update motor speed')
      }
    } catch { toast.error('Failed to save motor speed') }
    finally { setIsSaving(false) }
  }

  return {
    speeds,
    editedSpeeds,
    isLoading,
    isSaving,
    handleSpeedChange,
    hasSpeedChanges,
    handleSaveSpeed,
    FIRMWARE_DEFAULTS,
  }
}
