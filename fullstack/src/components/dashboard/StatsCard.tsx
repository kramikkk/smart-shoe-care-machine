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
    trend: number
    isPositive: boolean
    diff: number
    diffFormatted: string
  }
  totalTransactions: {
    value: number
    trend: number
    isPositive: boolean
    diff: number
  }
}

const PERIOD_LABEL: Record<string, string> = {
  today: 'today',
  week: 'this week',
  month: 'this month',
  year: 'this year',
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

        if (data.success) {
          setStats(data.stats)
        } else {
          console.error('Failed to fetch stats:', data.error)
        }
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
  const isPositive = stat.isPositive
  const isNeutral = stat.trend === 0
  const TrendIcon = isNeutral ? Minus : isPositive ? TrendingUp : TrendingDown
  const periodLabel = PERIOD_LABEL[timeRange] ?? 'today'

  const config = {
    totalRevenue: {
      title: 'Total Revenue',
      icon: Coins,
      iconColor: 'text-yellow-500',
      value: stats.totalRevenue.formatted,
      footerDescription: `+${stats.totalRevenue.diffFormatted} added ${periodLabel}`,
    },
    totalTransactions: {
      title: 'Total Transactions',
      icon: ShoppingCart,
      iconColor: 'text-blue-500',
      value: stats.totalTransactions.value.toString(),
      footerDescription: `+${stats.totalTransactions.diff} added ${periodLabel}`,
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
        <CardAction>
          <Badge
            variant="outline"
            className={`flex items-center gap-1 ${
              isNeutral ? "text-muted-foreground" : isPositive ? "text-green-400" : "text-red-400"
            }`}
          >
            <TrendIcon className="size-4" />
            {isPositive && !isNeutral ? "+" : ""}
            {stat.trend}%
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <CardTitle className="text-2xl font-bold tabular-nums @[250px]/card:text-3xl pb-1">
          {currentConfig.value}
        </CardTitle>
        <div
          className={`text-sm font-medium ${
            stat.diff === 0 ? "text-muted-foreground" : isPositive ? "text-green-400" : "text-red-400"
          }`}
        >
          {currentConfig.footerDescription}
        </div>
      </CardContent>
    </Card>
  )
}

export default StatsCard
