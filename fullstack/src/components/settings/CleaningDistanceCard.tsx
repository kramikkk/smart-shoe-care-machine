'use client'

import { Sparkles, Save, Loader2, Ruler } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

const CARE_TYPES = ['gentle', 'normal', 'strong'] as const
const COLOR = 'var(--chart-1)' // same as cleaning

// Matches firmware cleaningSideTargetSteps (mm): gentle 90, normal 95, strong 100
const FIRMWARE_DEFAULTS: Record<string, number> = {
  gentle: 90,
  normal: 95,
  strong: 100,
}

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
        <div
          className="border rounded-lg p-4 space-y-4 transition-colors"
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = COLOR }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = '' }}
        >
          <div className="flex items-center gap-3">
            <div
              className="p-2 rounded-lg"
              style={{
                backgroundColor: `color-mix(in srgb, ${COLOR} 15%, transparent)`,
                color: COLOR,
              }}
            >
              <Sparkles className="h-5 w-5" />
            </div>
            <h3 className="font-semibold">Cleaning</h3>
          </div>

          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            {CARE_TYPES.map((careType) => {
              const edited  = editedDistances[careType] ?? FIRMWARE_DEFAULTS[careType]
              const changed = hasDistanceChanges(careType)
              return (
                <div key={careType} className="space-y-1.5">
                  <Label className="text-xs capitalize text-muted-foreground">{careType}</Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        type="number"
                        min="1"
                        max="100"
                        value={edited || ''}
                        onChange={(e) => onDistanceChange(careType, e.target.value)}
                        className="pr-10"
                        disabled={isSaving}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">mm</span>
                    </div>
                    <Button
                      size="icon"
                      className="shrink-0"
                      disabled={!changed || isSaving}
                      onClick={() => onSaveDistance(careType)}
                    >
                      {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Default: {FIRMWARE_DEFAULTS[careType]}mm
                    {changed && <span className="text-amber-600 dark:text-amber-400 ml-2">→ {edited}mm</span>}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
