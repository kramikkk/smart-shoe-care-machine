'use client'

import { Sparkles, Wind, ShieldCheck, Save, Loader2, Timer } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

type DurationMap = Record<string, Record<string, number>>

type ServiceDurationCardProps = {
  durations: DurationMap
  editedDurations: DurationMap
  isSavingDuration: boolean
  selectedDevice: string | null
  onDurationChange: (serviceType: string, careType: string, value: string) => void
  hasDurationChanges: (serviceType: string, careType: string) => boolean
  onSaveDuration: (serviceType: string, careType: string) => void
}

// Default seconds per care tier (aligned with /api/duration seed values)
const FIRMWARE_DEFAULTS: Record<string, Record<string, number>> = {
  cleaning: { gentle: 60, normal: 180, strong: 300 },
  drying: { gentle: 60, normal: 180, strong: 300 },
  sterilizing: { gentle: 60, normal: 180, strong: 300 },
}

const SERVICE_CONFIG = [
  { key: 'cleaning',    label: 'Cleaning',    icon: <Sparkles className="h-5 w-5" />, color: 'var(--chart-1)', careTypes: ['gentle', 'normal', 'strong'] as const },
  { key: 'drying',      label: 'Drying',      icon: <Wind     className="h-5 w-5" />, color: 'var(--chart-2)', careTypes: ['gentle', 'normal', 'strong'] as const },
  { key: 'sterilizing', label: 'Sterilizing', icon: <ShieldCheck className="h-5 w-5" />, color: 'var(--chart-3)', careTypes: ['gentle', 'normal', 'strong'] as const },
]

export function ServiceDurationCard({
  durations,
  editedDurations,
  isSavingDuration,
  selectedDevice,
  onDurationChange,
  hasDurationChanges,
  onSaveDuration,
}: ServiceDurationCardProps) {
  return (
    <Card className="glass-card border-none">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Timer className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">Service Durations</CardTitle>
        </div>
        <CardDescription>
          Configure how long each service runs per care intensity for {selectedDevice}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6">
          {SERVICE_CONFIG.map(({ key, label, icon, color, careTypes }) => (
            <div
              key={key}
              className="border rounded-lg p-4 space-y-4 transition-colors"
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = color }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = '' }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="p-2 rounded-lg"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
                    color,
                  }}
                >
                  {icon}
                </div>
                <h3 className="font-semibold">{label}</h3>
              </div>

              <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
                {careTypes.map((careType) => {
                  const edited  = editedDurations[key]?.[careType] ?? 0
                  const changed = hasDurationChanges(key, careType)
                  return (
                    <div key={careType} className="space-y-1.5">
                      <Label className="text-xs capitalize text-muted-foreground">{careType}</Label>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <Input
                            type="number"
                            min="1"
                            value={edited || ''}
                            onChange={(e) => onDurationChange(key, careType, e.target.value)}
                            className="pr-7"
                            disabled={isSavingDuration}
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">s</span>
                        </div>
                        <Button
                          size="icon"
                          className="shrink-0"
                          disabled={!changed || isSavingDuration}
                          onClick={() => onSaveDuration(key, careType)}
                        >
                          {isSavingDuration ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Default: {FIRMWARE_DEFAULTS[key]?.[careType] ?? '—'}s
                        {changed && <span className="text-amber-600 dark:text-amber-400 ml-2">→ {edited}s</span>}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
