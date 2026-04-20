'use client'

import { TrendingDown, TrendingUp, Minus, ShoppingCart, Coins, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardHeader,
  CardTitle,
  CardContent
} from "@/components/ui/card"
import { useEffect, useState } from "react"
import { useDeviceFilter } from "@/contexts/DeviceFilterContext"
import { useTimeRange } from "@/contexts/TimeRangeContext"

type StatsType = 'totalRevenue' | 'totalTransactions'

interface Stats {
  totalRevenue: {
    value: number
    formatted: string
    trend: number | null
    isPositive: boolean | null
    previousValue: number | null
    previousFormatted: string | null
  }
  totalTransactions: {
    value: number
    trend: number | null
    isPositive: boolean | null
    previousValue: number | null
  }
}

const PERIOD_LABEL: Record<string, string> = {
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
  year: 'This Year',
  all: 'All Time',
}

const PREVIOUS_LABEL: Record<string, string> = {
  today: 'Yesterday',
  week: 'Last Week',
  month: 'Last Month',
  year: 'Last Year',
}

const StatsCard = ({ id }: { id: StatsType }) => {
  const { selectedDevice } = useDeviceFilter()
  const { timeRange } = useTimeRange()
  const [stats, setStats] = useState<Stats | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchStats = async () => {
      setIsLoading(true)
      try {
        const response = await fetch(
          `/api/transaction/stats?deviceId=${selectedDevice}&timeRange=${timeRange}`
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        const data = await response.json()
        if (data.success) setStats(data.stats)
      } catch (error) {
        console.error('Error fetching stats:', error)
      } finally {
        setIsLoading(false)
      }
    }
    fetchStats()
  }, [selectedDevice, timeRange])

  if (isLoading || !stats) {
    return (
      <Card className="@container/card glass-card border-none">
        <CardContent className="flex items-center justify-center h-24">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  const stat = stats[id]
  const isAllTime = timeRange === 'all'
  const isPositive = stat.isPositive
  const isNeutral = stat.trend === 0 || stat.trend === null
  const TrendIcon = isNeutral ? Minus : isPositive ? TrendingUp : TrendingDown
  const periodLabel = PERIOD_LABEL[timeRange] ?? 'Today'
  const previousLabel = PREVIOUS_LABEL[timeRange] ?? 'Yesterday'

  const phpFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'PHP' })

  const config = {
    totalRevenue: {
      title: 'Total Revenue',
      icon: Coins,
      iconColor: 'text-yellow-500',
      value: stats.totalRevenue.formatted,
      currentLabel: periodLabel,
      footer: isAllTime
        ? 'All time cumulative revenue'
        : `vs ${previousLabel}: ${stats.totalRevenue.previousFormatted}`,
    },
    totalTransactions: {
      title: 'Total Transactions',
      icon: ShoppingCart,
      iconColor: 'text-blue-500',
      value: stats.totalTransactions.value.toString(),
      currentLabel: periodLabel,
      footer: isAllTime
        ? 'All time cumulative transactions'
        : `vs ${previousLabel}: ${stats.totalTransactions.previousValue} txn`,
    },
  }

  const currentConfig = config[id]
  const Icon = currentConfig.icon

  return (
    <Card className="@container/card glass-card border-none">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className={`size-5 ${currentConfig.iconColor}`} />
          <CardTitle className="text-md">{currentConfig.title}</CardTitle>
        </div>
        {!isAllTime && (
          <CardAction>
            <Badge
              variant="outline"
              className={`flex items-center gap-1 ${
                isNeutral ? "text-muted-foreground" : isPositive ? "text-green-400" : "text-red-400"
              }`}
            >
              <TrendIcon className="size-4" />
              {!isNeutral && isPositive ? "+" : ""}
              {stat.trend}%
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <div className="text-xs text-muted-foreground mb-0.5">{currentConfig.currentLabel}</div>
        <CardTitle className="text-2xl font-bold tabular-nums @[250px]/card:text-3xl pb-1">
          {currentConfig.value}
        </CardTitle>
        <div className="text-sm text-muted-foreground">
          {currentConfig.footer}
        </div>
      </CardContent>
    </Card>
  )
}

export default StatsCard
