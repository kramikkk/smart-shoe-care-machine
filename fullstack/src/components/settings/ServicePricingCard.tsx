'use client'

import { Sparkles, Wind, ShieldCheck, Package, Save, Loader2, Tag } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import type { ServicePricing } from "@/hooks/useServicePricing"
import { CARE_TYPES_BY_SERVICE } from "@/hooks/useServicePricing"

const SERVICE_TYPES = ['cleaning', 'drying', 'sterilizing', 'package'] as const

const serviceIcons = {
  cleaning:    { icon: <Sparkles className="h-5 w-5" />,    color: 'var(--chart-1)' },
  drying:      { icon: <Wind className="h-5 w-5" />,        color: 'var(--chart-2)' },
  sterilizing: { icon: <ShieldCheck className="h-5 w-5" />, color: 'var(--chart-3)' },
  package:     { icon: <Package className="h-5 w-5" />,     color: 'var(--chart-4)' },
}

const serviceNames: Record<string, string> = {
  cleaning: 'Cleaning', drying: 'Drying', sterilizing: 'Sterilizing', package: 'Package',
}

const careLabels: Record<string, string> = {
  gentle: 'Gentle', normal: 'Normal', strong: 'Strong', auto: 'Package Price',
}

const PRICE_DEFAULTS: Record<string, Record<string, number>> = {
  cleaning:    { gentle: 40, normal: 45, strong: 50 },
  drying:      { gentle: 20, normal: 25, strong: 30 },
  sterilizing: { gentle: 20, normal: 25, strong: 30 },
  package:     { auto: 100 },
}

type ServicePricingCardProps = {
  pricing: ServicePricing[]
  editedPrices: Record<string, number | string>
  isSaving: boolean
  selectedDevice: string | null
  onPriceChange: (serviceType: string, careType: string, value: string) => void
  onSave: (serviceType: string, careType: string) => void
  hasChanges: (serviceType: string, careType: string) => boolean
}

export function ServicePricingCard({
  pricing,
  editedPrices,
  isSaving,
  selectedDevice,
  onPriceChange,
  onSave,
  hasChanges,
}: ServicePricingCardProps) {
  return (
    <Card className="glass-card border-none">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Tag className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">Service Pricing</CardTitle>
        </div>
        <CardDescription>
          Set prices per care type for {selectedDevice}. These prices apply only to this machine.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {SERVICE_TYPES.map((serviceType) => {
            const meta = serviceIcons[serviceType]
            const careTypes = CARE_TYPES_BY_SERVICE[serviceType]
            const anyUnsaved = careTypes.some(ct => hasChanges(serviceType, ct))
            const isPackage = serviceType === 'package'

            return (
              <div
                key={serviceType}
                className="border rounded-lg p-4 space-y-4 transition-colors"
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = meta.color }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '' }}
              >
                {/* Service header */}
                <div className="flex items-center gap-3">
                  <div
                    className="p-2 rounded-lg"
                    style={{
                      backgroundColor: `color-mix(in srgb, ${meta.color} 15%, transparent)`,
                      color: meta.color,
                    }}
                  >
                    {meta.icon}
                  </div>
                  <div>
                    <h3 className="font-semibold">{serviceNames[serviceType]}</h3>
                    {isPackage && (
                      <p className="text-xs text-muted-foreground">Cleaning + Drying + Sterilizing</p>
                    )}
                    {anyUnsaved && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</p>
                    )}
                  </div>
                </div>

                {/* Price inputs */}
                <div className="space-y-3">
                  {careTypes.map((careType) => {
                    const compositeKey = `${serviceType}:${careType}`
                    const changed = hasChanges(serviceType, careType)

                    return (
                      <div key={careType} className="space-y-1">
                        <div className="flex items-center justify-between">
                          <Label
                            htmlFor={`price-${serviceType}-${careType}`}
                            className="text-sm font-medium"
                          >
                            {careLabels[careType]}
                          </Label>
                          <span className="text-xs text-muted-foreground">
                            Default: ₱{(PRICE_DEFAULTS[serviceType][careType] ?? 0).toFixed(2)}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                              ₱
                            </span>
                            <Input
                              id={`price-${serviceType}-${careType}`}
                              type="number"
                              min="0"
                              step="0.01"
                              value={editedPrices[compositeKey] ?? ''}
                              onChange={(e) => onPriceChange(serviceType, careType, e.target.value)}
                              className="pl-7 h-8 text-sm"
                              disabled={isSaving}
                            />
                          </div>
                          <Button
                            onClick={() => onSave(serviceType, careType)}
                            disabled={!changed || isSaving}
                            size="icon"
                            className="shrink-0 h-8 w-8"
                          >
                            {isSaving ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Save className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
