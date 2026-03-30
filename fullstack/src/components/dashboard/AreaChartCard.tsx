"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Loader2 } from "lucide-react"
import { useDeviceFilter } from "@/contexts/DeviceFilterContext"
import { useTimeRange } from "@/contexts/TimeRangeContext"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type ChartDataPoint = {
  date: string
  revenue: number
  transactions: number
}

const chartConfig = {
  visitors: {
    label: "Visitors",
  },
  revenue: {
    label: "Revenue",
    color: "var(--chart-1)",
  },
  transactions: {
    label: "Transactions",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

// Maps global time range → API granularity
const GRANULARITY: Record<string, string> = {
  today: 'hour',
  week: 'day',
  month: 'day',
  year: 'month',
}

// Days param only used for 'day' granularity
const DAYS: Record<string, number> = {
  week: 7,
  month: 30,
}

const PERIOD_DESCRIPTION: Record<string, string> = {
  today: 'Hourly — today',
  week: 'Daily — this week',
  month: 'Daily — this month',
  year: 'Monthly — this year',
}

function formatXTick(value: string, granularity: string): string {
  if (granularity === 'hour') {
    // value: "2024-03-30T08"
    const hour = parseInt(value.split('T')[1])
    if (hour === 0) return '12 AM'
    if (hour < 12) return `${hour} AM`
    if (hour === 12) return '12 PM'
    return `${hour - 12} PM`
  }
  if (granularity === 'month') {
    // value: "2024-03"
    const [y, m] = value.split('-')
    return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString('en-US', { month: 'short' })
  }
  // day: "2024-03-30"
  const date = new Date(value + 'T12:00:00Z')
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatTooltipLabel(value: string, granularity: string): string {
  if (granularity === 'hour') {
    const hour = parseInt(value.split('T')[1])
    const label = hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`
    return `Today at ${label}`
  }
  if (granularity === 'month') {
    const [y, m] = value.split('-')
    return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }
  return new Date(value + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatYTick(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(0)}K`
  return String(value)
}

export default function AreaChartCard() {
  const { selectedDevice } = useDeviceFilter()
  const { timeRange } = useTimeRange()
  const [dataView, setDataView] = React.useState("all")
  const [chartData, setChartData] = React.useState<ChartDataPoint[]>([])
  const [isLoading, setIsLoading] = React.useState(true)

  const granularity = GRANULARITY[timeRange] ?? 'day'

  React.useEffect(() => {
    const controller = new AbortController()
    setIsLoading(true)
    const fetchChartData = async () => {
      try {
        const days = DAYS[timeRange]
        const params = new URLSearchParams({
          granularity,
          deviceId: selectedDevice,
          ...(days !== undefined ? { days: String(days) } : {}),
        })
        const response = await fetch(`/api/transaction/chart?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        const data = await response.json()
        if (data.success) setChartData(data.chartData)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
      } finally {
        setIsLoading(false)
      }
    }

    fetchChartData()
    return () => controller.abort()
  }, [timeRange, selectedDevice])

  return (
    <Card className="pt-0 h-full flex flex-col glass-card border-none overflow-hidden">
      <CardHeader className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:gap-2 sm:space-y-0 shrink-0">
        <div className="grid flex-1 gap-1">
          <CardTitle>Transaction + Revenue Chart</CardTitle>
          <CardDescription>{PERIOD_DESCRIPTION[timeRange] ?? 'Daily trends'}</CardDescription>
        </div>
        <Select value={dataView} onValueChange={setDataView}>
          <SelectTrigger
            className="w-[100px] rounded-lg text-xs sm:text-sm sm:w-[130px]"
            aria-label="Select data view"
          >
            <SelectValue placeholder="Show all" />
          </SelectTrigger>
          <SelectContent className="rounded-xl">
            <SelectItem value="all" className="rounded-lg">All</SelectItem>
            <SelectItem value="revenue" className="rounded-lg">Revenue</SelectItem>
            <SelectItem value="transactions" className="rounded-lg">Transactions</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6 pb-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-[280px] sm:h-[320px] xl:h-[420px] w-full">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center h-[280px] sm:h-[320px] xl:h-[420px] w-full">
            <div className="text-muted-foreground">No data available</div>
          </div>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-[280px] sm:h-[320px] xl:h-[420px] w-full"
          >
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-revenue)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-revenue)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillTransactions" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-transactions)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-transactions)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={granularity === 'month' ? 0 : granularity === 'hour' ? 40 : 32}
                tickFormatter={(v) => formatXTick(v, granularity)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                width={48}
                tickFormatter={formatYTick}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatTooltipLabel(value, granularity)}
                    indicator="dot"
                  />
                }
              />
              {(dataView === "revenue" || dataView === "all") && (
                <Area
                  dataKey="revenue"
                  type="monotone"
                  fill="url(#fillRevenue)"
                  stroke="var(--color-revenue)"
                  fillOpacity={0.6}
                />
              )}
              {(dataView === "transactions" || dataView === "all") && (
                <Area
                  dataKey="transactions"
                  type="monotone"
                  fill="url(#fillTransactions)"
                  stroke="var(--color-transactions)"
                  fillOpacity={0.6}
                />
              )}
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
