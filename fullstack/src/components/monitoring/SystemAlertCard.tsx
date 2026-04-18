'use client'

import { useEffect, useState, useCallback } from 'react'
import { format } from 'date-fns'
import { AlertCircle, AlertTriangle, Bell, Check, CheckCheck, CheckCircle2, Info, Loader2, Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useDeviceFilter } from '@/contexts/DeviceFilterContext'
import { useDashboardWebSocket, deriveAlerts } from '@/contexts/DashboardWebSocketContext'
import { toast } from 'sonner'

type StoredAlert = {
  id: string
  alertKey: string
  severity: string
  title: string
  description: string
  createdAt: string
  readAt: string | null
  resolvedAt: string | null
}

type TabType = 'current' | 'resolved'

const severityConfig = {
  critical: {
    icon: AlertCircle,
    badgeClass: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800',
    rowClass: 'border-red-900/30 bg-red-900/10',
    iconClass: 'text-red-500',
    label: 'Critical',
  },
  warning: {
    icon: AlertTriangle,
    badgeClass: 'bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-400 dark:border-yellow-800',
    rowClass: 'border-yellow-900/30 bg-yellow-900/10',
    iconClass: 'text-yellow-500',
    label: 'Warning',
  },
  info: {
    icon: Info,
    badgeClass: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800',
    rowClass: 'border-blue-900/30 bg-blue-900/10',
    iconClass: 'text-blue-500',
    label: 'Info',
  },
}

function getSeverityConfig(severity: string) {
  return severityConfig[severity as keyof typeof severityConfig] ?? severityConfig.info
}

function formatDateTime(iso: string) {
  return format(new Date(iso), 'MMM d, yyyy · h:mm a')
}

const SystemAlertCard = ({ className }: { className?: string }) => {
  const { selectedDevice } = useDeviceFilter()
  const { sensorData, isConnected, alertRefreshSignal } = useDashboardWebSocket()

  const [activeTab, setActiveTab] = useState<TabType>('current')
  const [currentAlerts, setCurrentAlerts] = useState<StoredAlert[]>([])
  const [resolvedAlerts, setResolvedAlerts] = useState<StoredAlert[]>([])
  const [fetching, setFetching] = useState(true)
  const [markingId, setMarkingId] = useState<string | null>(null)
  const [markingAll, setMarkingAll] = useState(false)
  const [clearingHistory, setClearingHistory] = useState(false)

  const fetchAlerts = useCallback(async () => {
    if (!selectedDevice) return
    try {
      const [currRes, resRes] = await Promise.all([
        fetch(`/api/device/${selectedDevice}/alerts`),
        fetch(`/api/device/${selectedDevice}/alerts?resolved=true`),
      ])
      if (currRes.ok) setCurrentAlerts(await currRes.json())
      if (resRes.ok) setResolvedAlerts(await resRes.json())
    } catch {
      // silently ignore
    } finally {
      setFetching(false)
    }
  }, [selectedDevice])

  // Fetch on mount, every 30s, and immediately when a new alert is created
  useEffect(() => {
    setFetching(true)
    fetchAlerts()
    const interval = setInterval(fetchAlerts, 30_000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAlerts, alertRefreshSignal])

  const handleMarkSolved = async (alert: StoredAlert) => {
    if (!selectedDevice) return

    // Re-evaluate current sensor state to block resolving an ongoing issue
    const activeConditions = deriveAlerts(sensorData, isConnected)
    const isStillActive = activeConditions.some(a => a.id === alert.alertKey)

    if (isStillActive) {
      toast.error('Issue still active', {
        description: `"${alert.title}" is still being detected. Address the underlying issue first.`,
      })
      return
    }

    setMarkingId(alert.id)
    try {
      const res = await fetch(`/api/device/${selectedDevice}/alerts/resolve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertKeys: [alert.alertKey] }),
      })
      if (res.ok) {
        const now = new Date().toISOString()
        const resolvedAlert: StoredAlert = { ...alert, resolvedAt: now }
        setCurrentAlerts(prev => prev.filter(a => a.id !== alert.id))
        setResolvedAlerts(prev => [resolvedAlert, ...prev])
        toast.success('Alert resolved', {
          description: `"${alert.title}" has been marked as solved.`,
        })
      } else {
        toast.error('Could not resolve alert. Please try again.')
      }
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setMarkingId(null)
    }
  }

  const handleMarkAllSolved = async () => {
    if (!selectedDevice || markingAll) return

    // Separate alerts into resolvable vs. still-active
    const activeConditions = deriveAlerts(sensorData, isConnected)
    const activeKeys = new Set(activeConditions.map(a => a.id))

    const toResolve = currentAlerts.filter(a => !activeKeys.has(a.alertKey))
    const skipped = currentAlerts.filter(a => activeKeys.has(a.alertKey))

    if (toResolve.length === 0) {
      toast.error('All issues still active', {
        description: 'Address the underlying issues before marking them as solved.',
      })
      return
    }

    setMarkingAll(true)
    try {
      const res = await fetch(`/api/device/${selectedDevice}/alerts/resolve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertKeys: toResolve.map(a => a.alertKey) }),
      })
      if (res.ok) {
        const now = new Date().toISOString()
        const resolvedNow = toResolve.map(a => ({ ...a, resolvedAt: now }))
        setCurrentAlerts(skipped)
        setResolvedAlerts(prev => [...resolvedNow, ...prev])
        if (skipped.length > 0) {
          toast.success(`${toResolve.length} alert${toResolve.length > 1 ? 's' : ''} resolved`, {
            description: `${skipped.length} alert${skipped.length > 1 ? 's' : ''} skipped — condition still active.`,
          })
        } else {
          toast.success(`All ${toResolve.length} alert${toResolve.length > 1 ? 's' : ''} resolved`)
        }
      } else {
        toast.error('Could not resolve alerts. Please try again.')
      }
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setMarkingAll(false)
    }
  }

  const handleClearHistory = async () => {
    if (!selectedDevice || clearingHistory) return
    setClearingHistory(true)
    try {
      const res = await fetch(`/api/device/${selectedDevice}/alerts`, { method: 'DELETE' })
      if (res.ok) {
        const { deleted } = await res.json()
        setResolvedAlerts([])
        toast.success(`Cleared ${deleted} resolved alert${deleted !== 1 ? 's' : ''}`)
      } else {
        toast.error('Could not clear history. Please try again.')
      }
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setClearingHistory(false)
    }
  }

  const displayedAlerts = activeTab === 'current' ? currentAlerts : resolvedAlerts
  const criticalCount = currentAlerts.filter(a => a.severity === 'critical').length

  return (
    <Card className={`glass-card border-none${className ? ` ${className}` : ''}`}>
      <CardHeader className="pb-2">
        {/* Title row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle
              className={
                criticalCount > 0
                  ? 'text-red-500'
                  : currentAlerts.length > 0
                    ? 'text-yellow-500'
                    : 'text-muted-foreground'
              }
            />
            <CardTitle>System Alerts</CardTitle>
            {currentAlerts.length > 0 && (
              <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-red-500/20 text-red-400 text-[10px] font-black">
                {currentAlerts.length}
              </span>
            )}
          </div>
          {activeTab === 'current' && currentAlerts.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={markingAll}
              onClick={handleMarkAllSolved}
              className="h-7 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-green-400 hover:bg-green-500/10 gap-1"
            >
              {markingAll
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <CheckCheck className="h-3 w-3" />}
              Mark All Solved
            </Button>
          )}
          {activeTab === 'resolved' && resolvedAlerts.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={clearingHistory}
              onClick={handleClearHistory}
              className="h-7 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-red-400 hover:bg-red-500/10 gap-1"
            >
              {clearingHistory
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <Trash2 className="h-3 w-3" />}
              Clear History
            </Button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-3">
          {(['current', 'resolved'] as TabType[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-widest transition-colors ${activeTab === tab
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
                }`}
            >
              {tab === 'current' ? 'Current' : 'Resolved'}
              {tab === 'current' && currentAlerts.length > 0 && (
                <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-red-500/30 text-red-400 text-[9px] font-black">
                  {currentAlerts.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="max-h-96 overflow-y-auto">
        {fetching ? (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading</span>
          </div>
        ) : displayedAlerts.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Empty className="p-4">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {activeTab === 'current' ? <Bell /> : <CheckCircle2 />}
                </EmptyMedia>
                <EmptyTitle>
                  {activeTab === 'current' ? 'No Active Alerts' : 'No Resolved Alerts'}
                </EmptyTitle>
                <EmptyDescription>
                  {activeTab === 'current'
                    ? 'All systems are running smoothly.'
                    : 'No alerts have been resolved yet.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <div className="space-y-2">
            {displayedAlerts.map(alert => {
              const config = getSeverityConfig(alert.severity)
              const Icon = config.icon
              return (
                <div
                  key={alert.id}
                  className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${config.rowClass}`}
                >
                  <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${config.iconClass}`} />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm">{alert.title}</p>
                      <Badge variant="outline" className={`${config.badgeClass} text-[10px] h-4`}>
                        {config.label}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{alert.description}</p>

                    <p className="text-[10px] text-muted-foreground/50 mt-1.5 leading-relaxed">
                      {activeTab === 'current' ? (
                        <>Since {formatDateTime(alert.createdAt)}</>
                      ) : (
                        <>
                          <span className="text-green-500/70">Resolved {formatDateTime(alert.resolvedAt!)}</span>
                          <span className="mx-1">·</span>
                          Started {formatDateTime(alert.createdAt)}
                        </>
                      )}
                    </p>
                  </div>

                  {activeTab === 'current' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2.5 text-[10px] font-semibold shrink-0 text-muted-foreground hover:text-green-400 hover:bg-green-500/10 gap-1"
                      disabled={markingId === alert.id}
                      onClick={() => handleMarkSolved(alert)}
                      title="Mark as solved"
                    >
                      {markingId === alert.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                      Solved
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default SystemAlertCard
