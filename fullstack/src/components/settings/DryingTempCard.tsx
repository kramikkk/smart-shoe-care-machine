'use client'

import { Save, Loader2, Thermometer } from 'lucide-react'
import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

const CARE_TYPES = ['gentle', 'normal', 'strong'] as const
const COLOR = 'oklch(0.627 0.194 149.214)'

const FIRMWARE_DEFAULTS: Record<string, number> = {
  gentle: 35,
  normal: 40,
  strong: 45,
}

const CARE_LABELS = { gentle: 'Gentle', normal: 'Normal', strong: 'Strong' }

const MIN_TEMP = 30
const MAX_TEMP = 50

type DryingTempCardProps = {
  temps: Record<string, number>
  editedTemps: Record<string, number>
  isSaving: boolean
  selectedDevice: string | null
  onTempChange: (careType: string, value: string) => void
  hasTempChanges: (careType: string) => boolean
  onSaveTemp: (careType: string) => void
}

export function DryingTempCard({
  temps,
  editedTemps,
  isSaving,
  selectedDevice,
  onTempChange,
  hasTempChanges,
  onSaveTemp,
}: DryingTempCardProps) {
  // Local string state lets users type freely; parent state is only updated on blur
  const [inputValues, setInputValues] = useState<Record<string, string>>({})

  useEffect(() => {
    const next: Record<string, string> = {}
    CARE_TYPES.forEach(ct => {
      next[ct] = String(editedTemps[ct] ?? FIRMWARE_DEFAULTS[ct])
    })
    setInputValues(next)
  }, [editedTemps])

  const handleBlur = (careType: string) => {
    const raw = inputValues[careType]
    const num = parseFloat(raw)
    if (isNaN(num) || num < MIN_TEMP || num > MAX_TEMP) {
      // Revert to the current committed value
      setInputValues(prev => ({ ...prev, [careType]: String(editedTemps[careType] ?? FIRMWARE_DEFAULTS[careType]) }))
    } else {
      onTempChange(careType, String(num))
    }
  }

  return (
    <Card className="glass-card border-none">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Thermometer className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">Drying Temperature Setpoint</CardTitle>
        </div>
        <CardDescription>
          Ideal drying temperature (°C) per care type for {selectedDevice}. The heater turns off above this value; exhaust activates to vent heat.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-5">
          {CARE_TYPES.map((careType) => {
            const edited = editedTemps[careType] ?? FIRMWARE_DEFAULTS[careType]
            const changed = hasTempChanges(careType)
            const pct = Math.min(100, Math.max(0, Math.round(((edited - MIN_TEMP) / (MAX_TEMP - MIN_TEMP)) * 100)))

            return (
              <div key={careType} className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-semibold capitalize">{CARE_LABELS[careType]}</Label>
                  <span
                    className="text-xs font-mono font-semibold px-1.5 py-0.5 rounded"
                    style={{
                      background: `color-mix(in srgb, ${COLOR} 12%, transparent)`,
                      color: COLOR,
                    }}
                  >
                    {edited}°C
                  </span>
                </div>

                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-200"
                    style={{ width: `${pct}%`, background: COLOR }}
                  />
                </div>

                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type="number"
                      min={MIN_TEMP}
                      max={MAX_TEMP}
                      step="0.5"
                      value={inputValues[careType] ?? ''}
                      onChange={(e) => setInputValues(prev => ({ ...prev, [careType]: e.target.value }))}
                      onBlur={() => handleBlur(careType)}
                      className="pr-7 h-9"
                      disabled={isSaving}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">°C</span>
                  </div>
                  <Button
                    size="icon"
                    className="shrink-0 h-9 w-9"
                    disabled={!changed || isSaving}
                    onClick={() => onSaveTemp(careType)}
                  >
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Default: {FIRMWARE_DEFAULTS[careType]}°C
                  {changed && (
                    <span className="text-amber-600 dark:text-amber-400 ml-2 font-medium">
                      → {edited}°C
                    </span>
                  )}
                </p>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
