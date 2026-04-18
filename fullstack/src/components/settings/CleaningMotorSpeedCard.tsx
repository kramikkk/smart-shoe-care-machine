'use client'

import { Sparkles, Save, Loader2, Gauge } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

const CARE_TYPES = ['gentle', 'normal', 'strong'] as const
const COLOR = 'var(--chart-1)'

// PWM defaults matching firmware brush motor speed per care type (0–255)
const FIRMWARE_DEFAULTS: Record<string, number> = {
  gentle: 230, // 90% of 255
  normal: 242, // 95% of 255
  strong: 255, // 100%
}

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
              const edited  = editedSpeeds[careType] ?? FIRMWARE_DEFAULTS[careType]
              const changed = hasSpeedChanges(careType)
              const pct     = Math.round((edited / 255) * 100)
              return (
                <div key={careType} className="space-y-1.5">
                  <Label className="text-xs capitalize text-muted-foreground">{careType}</Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        type="number"
                        min="0"
                        max="255"
                        value={edited === undefined ? '' : edited}
                        onChange={(e) => onSpeedChange(careType, e.target.value)}
                        className="pr-12"
                        disabled={isSaving}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">PWM</span>
                    </div>
                    <Button
                      size="icon"
                      className="shrink-0"
                      disabled={!changed || isSaving}
                      onClick={() => onSaveSpeed(careType)}
                    >
                      {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Default: {FIRMWARE_DEFAULTS[careType]} ({Math.round((FIRMWARE_DEFAULTS[careType] / 255) * 100)}%)
                    {changed && (
                      <span className="text-amber-600 dark:text-amber-400 ml-2">
                        → {edited} ({pct}%)
                      </span>
                    )}
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
