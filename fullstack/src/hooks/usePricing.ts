'use client'

import { useState, useEffect, useCallback } from 'react'

// Default fallback prices if API is unavailable
const PRICE_DEFAULTS: Record<string, Record<string, number>> = {
  cleaning:    { gentle: 40, normal: 45, strong: 50 },
  drying:      { gentle: 20, normal: 25, strong: 30 },
  sterilizing: { gentle: 20, normal: 25, strong: 30 },
  package:     { auto: 100 },
}

export function usePricing() {
  const [priceMatrix, setPriceMatrix] = useState<Record<string, Record<string, number>>>(PRICE_DEFAULTS)
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    const fetchPricing = async () => {
      try {
        const deviceId = localStorage.getItem('kiosk_device_id')
        const deviceParam = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''
        const response = await fetch(`/api/pricing${deviceParam}`)
        const data = await response.json()
        if (data.success && Array.isArray(data.pricing)) {
          const matrix: Record<string, Record<string, number>> = {}
          for (const item of data.pricing) {
            if (!matrix[item.serviceType]) matrix[item.serviceType] = {}
            matrix[item.serviceType][item.careType] = item.price
          }
          setPriceMatrix(matrix)
        }
      } catch {
        // fall back to defaults silently
      } finally {
        setIsLoaded(true)
      }
    }
    fetchPricing()
  }, [])

  const getPrice = useCallback((serviceType: string, careType: string): number => {
    // Package has a single 'auto' price regardless of the care type passed
    const resolvedCare = serviceType === 'package' ? 'auto' : careType
    return priceMatrix[serviceType]?.[resolvedCare]
      ?? PRICE_DEFAULTS[serviceType]?.[resolvedCare]
      ?? 0
  }, [priceMatrix])

  return { priceMatrix, getPrice, isLoaded }
}
