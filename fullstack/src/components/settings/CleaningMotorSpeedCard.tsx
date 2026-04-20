'use client'

import { Save, Loader2, Gauge } from 'lucide-react'
import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

const CARE_TYPES = ['gentle', 'normal', 'strong'] as const
const COLOR = 'var(--chart-1)'

const FIRMWARE_DEFAULTS: Record<string, number> = {
  gentle: 230,
  normal: 242,
  strong: 255,
}

const CARE_LABELS = { gentle: 'Gentle', normal: 'Normal', strong: 'Strong' }

type CleaningMotorSpeedCardProps = {
  speeds: Record<string, number>
  editedSpeeds: Record<string, number>
  isSaving: boolean
  selectedDevice: string | null
  onSpeedChange: (careType: string, value: string) => void
  hasSpeedChanges: (careType: string) => boolean
  onSaveSpeed: (careType: string) => void
}

export function CleaningMotorSpeedCard({
  speeds,
  editedSpeeds,
  isSaving,
  selectedDevice,
  onSpeedChange,
  hasSpeedChanges,
  onSaveSpeed,
}: CleaningMotorSpeedCardProps) {
  const [inputValues, setInputValues] = useState<Record<string, string>>({})

  useEffect(() => {
    const next: Record<string, string> = {}
    CARE_TYPES.forEach(ct => {
      next[ct] = String(editedSpeeds[ct] ?? FIRMWARE_DEFAULTS[ct])
    })
    setInputValues(next)
  }, [editedSpeeds])

  const handleBlur = (careType: string) => {
    const raw = inputValues[careType]
    const num = parseInt(raw)
    if (isNaN(num) || num < 0 || num > 255) {
      setInputValues(prev => ({ ...prev, [careType]: String(editedSpeeds[careType] ?? FIRMWARE_DEFAULTS[careType]) }))
    } else {
      onSpeedChange(careType, String(num))
    }
  }

  return (
    <Card className="glass-card border-none">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">Cleaning Motor Speed</CardTitle>
        </div>
        <CardDescription>
          Configure brush motor speed (PWM 0–255) for each care type on {selectedDevice}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-5">
          {CARE_TYPES.map((careType) => {
            const edited = editedSpeeds[careType] ?? FIRMWARE_DEFAULTS[careType]
            const changed = hasSpeedChanges(careType)
            const pct = Math.min(100, Math.max(0, Math.round((edited / 255) * 100)))

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
                    {pct}%
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
                      min="0"
                      max="255"
                      value={inputValues[careType] ?? ''}
                      onChange={(e) => setInputValues(prev => ({ ...prev, [careType]: e.target.value }))}
                      onBlur={() => handleBlur(careType)}
                      className="pr-12 h-9"
                      disabled={isSaving}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">PWM</span>
                  </div>
                  <Button
                    size="icon"
                    className="shrink-0 h-9 w-9"
                    disabled={!changed || isSaving}
                    onClick={() => onSaveSpeed(careType)}
                  >
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Default: {FIRMWARE_DEFAULTS[careType]} ({Math.round((FIRMWARE_DEFAULTS[careType] / 255) * 100)}%)
                  {changed && (
                    <span className="text-amber-600 dark:text-amber-400 ml-2 font-medium">
                      → {edited} ({pct}%)
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
