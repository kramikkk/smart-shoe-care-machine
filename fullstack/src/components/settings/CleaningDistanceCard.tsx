'use client'

import { Save, Loader2, Ruler } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

const CARE_TYPES = ['gentle', 'normal', 'strong'] as const
const COLOR = 'var(--chart-1)'

const FIRMWARE_DEFAULTS: Record<string, number> = {
  gentle: 90,
  normal: 95,
  strong: 100,
}

const CARE_LABELS = { gentle: 'Gentle', normal: 'Normal', strong: 'Strong' }

type CleaningDistanceCardProps = {
  distances: Record<string, number>
  editedDistances: Record<string, number>
  isSaving: boolean
  selectedDevice: string | null
  onDistanceChange: (careType: string, value: string) => void
  hasDistanceChanges: (careType: string) => boolean
  onSaveDistance: (careType: string) => void
}

export function CleaningDistanceCard({
  distances,
  editedDistances,
  isSaving,
  selectedDevice,
  onDistanceChange,
  hasDistanceChanges,
  onSaveDistance,
}: CleaningDistanceCardProps) {
  return (
    <Card className="glass-card border-none">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Ruler className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">Cleaning Brush Distance</CardTitle>
        </div>
        <CardDescription>
          Configure how far the side brush extends during cleaning for {selectedDevice}. Max 100mm.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-5">
          {CARE_TYPES.map((careType) => {
            const edited = editedDistances[careType] ?? FIRMWARE_DEFAULTS[careType]
            const changed = hasDistanceChanges(careType)
            const pct = Math.min(100, Math.max(0, Math.round((edited / 100) * 100)))

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

                {/* Progress bar */}
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
                      min="1"
                      max="100"
                      value={edited || ''}
                      onChange={(e) => onDistanceChange(careType, e.target.value)}
                      className="pr-10 h-9"
                      disabled={isSaving}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">mm</span>
                  </div>
                  <Button
                    size="icon"
                    className="shrink-0 h-9 w-9"
                    disabled={!changed || isSaving}
                    onClick={() => onSaveDistance(careType)}
                  >
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Default: {FIRMWARE_DEFAULTS[careType]}mm
                  {changed && (
                    <span className="text-amber-600 dark:text-amber-400 ml-2 font-medium">→ {edited}mm</span>
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
