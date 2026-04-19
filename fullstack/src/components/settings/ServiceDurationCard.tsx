'use client'

import { Sparkles, Wind, ShieldCheck, Save, Loader2, Timer } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

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

const FIRMWARE_DEFAULTS: Record<string, Record<string, number>> = {
  cleaning:    { gentle: 180, normal: 360, strong: 540 },
  drying:      { gentle: 180, normal: 360, strong: 540 },
  sterilizing: { gentle: 180, normal: 360, strong: 540 },
}

const SERVICE_CONFIG = [
  { key: 'cleaning',    label: 'Cleaning',    icon: <Sparkles className="h-4 w-4" />,    color: 'var(--chart-1)', careTypes: ['gentle', 'normal', 'strong'] as const },
  { key: 'drying',      label: 'Drying',      icon: <Wind className="h-4 w-4" />,        color: 'var(--chart-2)', careTypes: ['gentle', 'normal', 'strong'] as const },
  { key: 'sterilizing', label: 'Sterilizing', icon: <ShieldCheck className="h-4 w-4" />, color: 'var(--chart-3)', careTypes: ['gentle', 'normal', 'strong'] as const },
]

const CARE_LABELS = { gentle: 'Gentle', normal: 'Normal', strong: 'Strong' }

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
        {/* ── Mobile layout ── */}
        <div className="space-y-3 md:hidden">
          {SERVICE_CONFIG.map(({ key, label, icon, color, careTypes }) => {
            const anyUnsaved = careTypes.some(ct => hasDurationChanges(key, ct))
            return (
              <div
                key={key}
                className="rounded-xl p-4 space-y-3"
                style={{ background: `color-mix(in srgb, ${color} 5%, transparent)` }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className="p-1.5 rounded-md shrink-0"
                      style={{
                        background: `color-mix(in srgb, ${color} 15%, transparent)`,
                        color,
                      }}
                    >
                      {icon}
                    </div>
                    <span className="text-sm font-semibold">{label}</span>
                  </div>
                  {anyUnsaved && (
                    <span className="text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">
                      Unsaved
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {careTypes.map((careType) => {
                    const edited = editedDurations[key]?.[careType] ?? 0
                    const changed = hasDurationChanges(key, careType)
                    const defaultVal = FIRMWARE_DEFAULTS[key]?.[careType]
                    return (
                      <div key={careType} className="space-y-1.5">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground text-center">
                          {CARE_LABELS[careType]}
                        </div>
                        <div className="relative">
                          <Input
                            type="number"
                            min="1"
                            value={edited || ''}
                            onChange={(e) => onDurationChange(key, careType, e.target.value)}
                            className="pr-6 h-8 text-sm"
                            disabled={isSavingDuration}
                          />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">s</span>
                        </div>
                        <Button
                          size="sm"
                          className="w-full h-7"
                          disabled={!changed || isSavingDuration}
                          onClick={() => onSaveDuration(key, careType)}
                        >
                          {isSavingDuration ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        </Button>
                        <p className="text-xs text-center">
                          {changed ? (
                            <span className="text-amber-600 dark:text-amber-400 font-medium">{edited}s</span>
                          ) : (
                            <span className="text-muted-foreground">{defaultVal}s</span>
                          )}
                        </p>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        {/* ── Desktop layout (table-style grid) ── */}
        <div className="hidden md:block">
          <div className="grid grid-cols-[160px_1fr_1fr_1fr] gap-3 pb-2.5 mb-2 border-b border-border/50">
            <div />
            {(['gentle', 'normal', 'strong'] as const).map(ct => (
              <div key={ct} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-center">
                {CARE_LABELS[ct]}
              </div>
            ))}
          </div>

          <div className="space-y-1">
            {SERVICE_CONFIG.map(({ key, label, icon, color, careTypes }) => {
              const anyUnsaved = careTypes.some(ct => hasDurationChanges(key, ct))
              return (
                <div
                  key={key}
                  className="grid grid-cols-[160px_1fr_1fr_1fr] gap-3 py-3 rounded-lg px-2"
                  style={{ background: `color-mix(in srgb, ${color} 5%, transparent)` }}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="p-1.5 rounded-md shrink-0"
                      style={{
                        background: `color-mix(in srgb, ${color} 15%, transparent)`,
                        color,
                      }}
                    >
                      {icon}
                    </div>
                    <div>
                      <div className="text-sm font-medium leading-none">{label}</div>
                      {anyUnsaved && (
                        <div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Unsaved</div>
                      )}
                    </div>
                  </div>

                  {careTypes.map((careType) => {
                    const edited = editedDurations[key]?.[careType] ?? 0
                    const changed = hasDurationChanges(key, careType)
                    const defaultVal = FIRMWARE_DEFAULTS[key]?.[careType]
                    return (
                      <div key={careType} className="space-y-1">
                        <div className="flex gap-1.5">
                          <div className="relative flex-1">
                            <Input
                              type="number"
                              min="1"
                              value={edited || ''}
                              onChange={(e) => onDurationChange(key, careType, e.target.value)}
                              className="pr-6 h-8 text-sm"
                              disabled={isSavingDuration}
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">s</span>
                          </div>
                          <Button
                            size="icon"
                            className="shrink-0 h-8 w-8"
                            disabled={!changed || isSavingDuration}
                            onClick={() => onSaveDuration(key, careType)}
                          >
                            {isSavingDuration ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                        <p className="text-xs text-center">
                          {changed ? (
                            <span className="text-amber-600 dark:text-amber-400 font-medium">{edited}s</span>
                          ) : (
                            <span className="text-muted-foreground">{defaultVal}s</span>
                          )}
                        </p>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
