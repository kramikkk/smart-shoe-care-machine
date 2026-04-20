import { useState, useEffect } from 'react'
import { toast } from 'sonner'

type DryingTempEntry = { careType: string; tempC: number }
type TempMap = Record<string, number>

const FIRMWARE_DEFAULTS: TempMap = { gentle: 35, normal: 40, strong: 45 }

export function useDryingTemp(selectedDevice: string | null) {
  const [temps, setTemps]             = useState<TempMap>({})
  const [editedTemps, setEditedTemps] = useState<TempMap>({})
  const [isLoading, setIsLoading]     = useState(true)
  const [isSaving, setIsSaving]       = useState(false)

  useEffect(() => {
    if (!selectedDevice) { setIsLoading(false); return }
    setIsLoading(true)
    fetch(`/api/drying-temp?deviceId=${selectedDevice}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          const map: TempMap = {}
          data.temps.forEach((item: DryingTempEntry) => {
            map[item.careType] = item.tempC
          })
          setTemps(map)
          setEditedTemps({ ...map })
        }
      })
      .catch(() => toast.error('Failed to load drying temperatures'))
      .finally(() => setIsLoading(false))
  }, [selectedDevice])

  const handleTempChange = (careType: string, value: string) => {
    const num = parseFloat(value)
    if (!isNaN(num) && num >= 30 && num <= 50) {
      setEditedTemps(prev => ({ ...prev, [careType]: num }))
    }
  }

  const hasTempChanges = (careType: string) =>
    temps[careType] !== editedTemps[careType]

  const handleSaveTemp = async (careType: string) => {
    const tempC = editedTemps[careType]
    if (tempC === undefined || tempC < 30 || tempC > 50) {
      toast.error('Temperature must be between 30°C and 50°C')
      return
    }
    setIsSaving(true)
    try {
      const res = await fetch('/api/drying-temp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ careType, tempC, deviceId: selectedDevice }),
      })
      const data = await res.json()
      if (data.success) {
        setTemps(prev => ({ ...prev, [careType]: tempC }))
        toast.success(`Drying temp (${careType}) updated to ${tempC}°C`)
      } else {
        toast.error(data.error || 'Failed to update drying temperature')
      }
    } catch { toast.error('Failed to save drying temperature') }
    finally { setIsSaving(false) }
  }

  return {
    temps,
    editedTemps,
    isLoading,
    isSaving,
    handleTempChange,
    hasTempChanges,
    handleSaveTemp,
    FIRMWARE_DEFAULTS,
  }
}
