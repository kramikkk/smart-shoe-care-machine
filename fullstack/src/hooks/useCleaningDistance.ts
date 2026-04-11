import { useState, useEffect } from 'react'
import { toast } from 'sonner'

type CleaningDistance = { careType: string; distanceMm: number }
type DistanceMap = Record<string, number>

const FIRMWARE_DEFAULTS: DistanceMap = { gentle: 90, normal: 95, strong: 100 }

export function useCleaningDistance(selectedDevice: string | null) {
  const [distances, setDistances]           = useState<DistanceMap>({})
  const [editedDistances, setEditedDistances] = useState<DistanceMap>({})
  const [isLoading, setIsLoading]           = useState(true)
  const [isSaving, setIsSaving]             = useState(false)

  useEffect(() => {
    if (!selectedDevice) { setIsLoading(false); return }
    setIsLoading(true)
    fetch(`/api/cleaning-distance?deviceId=${selectedDevice}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          const map: DistanceMap = {}
          data.distances.forEach((item: CleaningDistance) => {
            map[item.careType] = item.distanceMm
          })
          setDistances(map)
          setEditedDistances({ ...map })
        }
      })
      .catch(() => toast.error('Failed to load cleaning distances'))
      .finally(() => setIsLoading(false))
  }, [selectedDevice])

  const handleDistanceChange = (careType: string, value: string) => {
    const num = parseInt(value)
    setEditedDistances(prev => ({
      ...prev,
      [careType]: isNaN(num) || num < 0 ? 0 : Math.min(num, 100),
    }))
  }

  const hasDistanceChanges = (careType: string) =>
    distances[careType] !== editedDistances[careType]

  const handleSaveDistance = async (careType: string) => {
    const distanceMm = editedDistances[careType]
    if (!distanceMm || distanceMm <= 0) { toast.error('Distance must be greater than 0'); return }
    setIsSaving(true)
    try {
      const res = await fetch('/api/cleaning-distance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ careType, distanceMm, deviceId: selectedDevice }),
      })
      const data = await res.json()
      if (data.success) {
        setDistances(prev => ({ ...prev, [careType]: distanceMm }))
        toast.success(`Cleaning distance (${careType}) updated to ${distanceMm}mm`)
      } else {
        toast.error(data.error || 'Failed to update distance')
      }
    } catch { toast.error('Failed to save distance') }
    finally { setIsSaving(false) }
  }

  return {
    distances,
    editedDistances,
    isLoading,
    isSaving,
    handleDistanceChange,
    hasDistanceChanges,
    handleSaveDistance,
    FIRMWARE_DEFAULTS,
  }
}
