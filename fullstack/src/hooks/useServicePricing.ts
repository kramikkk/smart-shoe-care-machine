import { useState, useEffect } from "react"
import { toast } from "sonner"

export type ServicePricing = {
  id: string
  serviceType: string
  careType: string
  price: number
  createdAt: string
  updatedAt: string
}

const SERVICE_NAMES: Record<string, string> = {
  cleaning: 'Cleaning', drying: 'Drying', sterilizing: 'Sterilizing', package: 'Package',
}
const CARE_NAMES: Record<string, string> = {
  gentle: 'Gentle', normal: 'Normal', strong: 'Strong', auto: 'Auto',
}

export const CARE_TYPES_BY_SERVICE: Record<string, string[]> = {
  cleaning:    ['gentle', 'normal', 'strong'],
  drying:      ['gentle', 'normal', 'strong'],
  sterilizing: ['gentle', 'normal', 'strong'],
  package:     ['auto'],
}

// Composite key: "serviceType:careType"
function key(serviceType: string, careType: string) {
  return `${serviceType}:${careType}`
}

export function useServicePricing(selectedDevice: string | null) {
  const [pricing, setPricing] = useState<ServicePricing[]>([])
  const [editedPrices, setEditedPrices] = useState<Record<string, number | string>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!selectedDevice) { setIsLoading(false); return }
    setIsLoading(true)
    fetch(`/api/pricing?deviceId=${selectedDevice}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setPricing(data.pricing)
          const initial: Record<string, number> = {}
          data.pricing.forEach((item: ServicePricing) => {
            initial[key(item.serviceType, item.careType)] = item.price
          })
          setEditedPrices(initial)
        } else {
          toast.error(data.error || "Failed to fetch pricing")
        }
      })
      .catch(() => toast.error("Failed to load pricing"))
      .finally(() => setIsLoading(false))
  }, [selectedDevice])

  const handlePriceChange = (serviceType: string, careType: string, value: string) => {
    const k = key(serviceType, careType)
    if (value === '') { setEditedPrices(prev => ({ ...prev, [k]: '' })); return }
    const num = parseFloat(value)
    if (!isNaN(num) && num >= 0) setEditedPrices(prev => ({ ...prev, [k]: num }))
  }

  const hasChanges = (serviceType: string, careType: string) => {
    const k = key(serviceType, careType)
    return pricing.find(p => p.serviceType === serviceType && p.careType === careType)?.price !== editedPrices[k]
  }

  const handleSave = async (serviceType: string, careType: string) => {
    const k = key(serviceType, careType)
    const price = editedPrices[k]
    if (price === '' || price === undefined) { toast.error('Please enter a valid price'); return }
    const numPrice = Number(price)
    if (isNaN(numPrice) || numPrice < 0) { toast.error('Please enter a valid positive number'); return }
    setIsSaving(true)
    try {
      const res = await fetch('/api/pricing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceType, careType, price: numPrice, deviceId: selectedDevice }),
      })
      const data = await res.json()
      if (data.success) {
        setPricing(prev => prev.map(item =>
          item.serviceType === serviceType && item.careType === careType
            ? { ...item, price: numPrice }
            : item
        ))
        toast.success(`${SERVICE_NAMES[serviceType] ?? serviceType} / ${CARE_NAMES[careType] ?? careType} price updated`)
      } else {
        toast.error(data.error || "Failed to update pricing")
      }
    } catch { toast.error("Failed to save pricing") }
    finally { setIsSaving(false) }
  }

  return { pricing, editedPrices, isLoading, isSaving, handlePriceChange, hasChanges, handleSave }
}
