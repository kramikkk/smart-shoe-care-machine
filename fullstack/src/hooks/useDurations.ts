'use client'

import { useState, useEffect } from 'react'

type DurationMap = Record<string, Record<string, number>>

const DEFAULT_DURATIONS: DurationMap = {
  cleaning: { gentle: 60, normal: 180, strong: 300 },
  drying: { gentle: 60, normal: 180, strong: 300 },
  sterilizing: { gentle: 60, normal: 180, strong: 300 },
}

export function useDurations() {
  const [durations, setDurations] = useState<DurationMap>(DEFAULT_DURATIONS)
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    const fetchDurations = async () => {
      try {
        const deviceId = localStorage.getItem('kiosk_device_id')
        const deviceParam = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''
        const response = await fetch(`/api/duration${deviceParam}`)
        const data = await response.json()
        if (data.success && Array.isArray(data.durations)) {
          const map: DurationMap = {}
          for (const item of data.durations) {
            if (!map[item.serviceType]) map[item.serviceType] = {}
            map[item.serviceType][item.careType] = item.duration
          }
          setDurations(map)
        }
      } catch {
        // fall back to defaults silently
      } finally {
        setIsLoaded(true)
      }
    }
    fetchDurations()
  }, [])

  return { durations, isLoaded }
}
