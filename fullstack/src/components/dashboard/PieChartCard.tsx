"use client"

import * as React from "react"
import { Label, Pie, PieChart, Sector } from "recharts"
import { Loader2, PieChart as PieChartIcon } from "lucide-react"
import { PieSectorDataItem } from "recharts/types/polar/Pie"
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
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type ServiceData = {
  type: string
  service: number
  revenue: number
  fill: string
}

type DistributionType = 'service' | 'shoe' | 'care'

const chartConfig = {
  service: {
    label: "Service",
  },
  cleaning: {
    label: "Cleaning",
    color: "var(--chart-1)",
  },
  drying: {
    label: "Drying",
    color: "var(--chart-2)",
  },
  sterilizing: {
    label: "Sterilizing",
    color: "var(--chart-3)",
  },
  package: {
    label: "Package",
    color: "var(--chart-4)",
  },
  canvas: {
    label: "Canvas",
    color: "var(--chart-1)",
  },
  rubber: {
    label: "Rubber",
    color: "var(--chart-2)",
  },
  mesh: {
    label: "Mesh",
    color: "var(--chart-3)",
  },
  gentle: {
    label: "Gentle",
    color: "var(--chart-1)",
  },
  normal: {
    label: "Normal",
    color: "var(--chart-2)",
  },
  strong: {
    label: "Strong",
    color: "var(--chart-3)",
  },
  auto: {
    label: "Auto",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig

const PHT_OFFSET_MS = 8 * 60 * 60 * 1000

function getPHTCurrentPeriodStart(timeRange: string): Date {
  const now = new Date()
  const nowPHT = new Date(now.getTime() + PHT_OFFSET_MS)
  const todayMidnightUTC = new Date(
    Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth(), nowPHT.getUTCDate()) - PHT_OFFSET_MS
  )
  switch (timeRange) {
    case 'week': {
      const dow = nowPHT.getUTCDay()
      const daysFromMonday = dow === 0 ? 6 : dow - 1
      return new Date(todayMidnightUTC.getTime() - daysFromMonday * 24 * 60 * 60 * 1000)
    }
    case 'month':
      return new Date(Date.UTC(nowPHT.getUTCFullYear(), nowPHT.getUTCMonth(), 1) - PHT_OFFSET_MS)
    case 'year':
      return new Date(Date.UTC(nowPHT.getUTCFullYear(), 0, 1) - PHT_OFFSET_MS)
    case 'today':
    default:
      return todayMidnightUTC
  }
}

export function PieChartCard() {
  const { selectedDevice } = useDeviceFilter()
  const { timeRange } = useTimeRange()
  const id = "pie-interactive"
  const [serviceData, setServiceData] = React.useState<ServiceData[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [activeService, setActiveService] = React.useState("")
  const [distributionType, setDistributionType] = React.useState<DistributionType>('service')

  // Fetch distribution data
  React.useEffect(() => {
    const fetchDistribution = async () => {
      setIsLoading(true)
      try {
        const startDate = getPHTCurrentPeriodStart(timeRange).toISOString()
        const endDate = new Date().toISOString()
        const response = await fetch(
          `/api/transaction/distribution?deviceId=${selectedDevice}&type=${distributionType}&startDate=${startDate}&endDate=${endDate}`
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        const data = await response.json()

        if (data.success) {
          if (data.serviceData.length > 0) {
            setServiceData(data.serviceData)
            setActiveService(data.serviceData[0].type)
          } else {
            // No transactions yet - this is normal for a fresh database
            setServiceData([])
          }
        } else {
          console.error('Failed to fetch distribution:', data.error || 'Unknown error')
        }
      } catch (error) {
        console.error('Error fetching distribution:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchDistribution()
  }, [selectedDevice, distributionType, timeRange])

  const activeIndex = React.useMemo(
    () => serviceData.findIndex((item: ServiceData) => item.type === activeService),
    [activeService, serviceData]
  )
  const services = React.useMemo(() => serviceData.map((item: ServiceData) => item.type), [serviceData])

  const totalServices = React.useMemo(
    () => serviceData.reduce((acc: number, curr: ServiceData) => acc + curr.service, 0),
    [serviceData]
  )

  const getTitle = () => {
    switch (distributionType) {
      case 'service': return 'Service Type Distribution'
      case 'shoe': return 'Shoe Type Distribution'
      case 'care': return 'Care Type Distribution'
    }
  }

  const headerContent = (
    <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
      <div className="flex items-center gap-2">
        <PieChartIcon className="size-5 text-orange-500 shrink-0" />
        <CardTitle className="text-sm sm:text-base lg:text-lg">{getTitle()}</CardTitle>
      </div>
      <Select value={distributionType} onValueChange={(value) => setDistributionType(value as DistributionType)}>
        <SelectTrigger className="h-7 w-fit rounded-lg">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="service">Service</SelectItem>
          <SelectItem value="shoe">Shoe</SelectItem>
          <SelectItem value="care">Care</SelectItem>
        </SelectContent>
      </Select>
    </CardHeader>
  )

  if (isLoading) {
    return (
      <Card className="flex flex-col h-full min-h-[280px] sm:min-h-[400px] glass-card border-none">
        {headerContent}
        <CardContent className="flex flex-1 justify-center items-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (serviceData.length === 0) {
    return (
      <Card className="flex flex-col h-full min-h-[280px] sm:min-h-[400px] glass-card border-none">
        {headerContent}
        <CardContent className="flex flex-1 justify-center items-center">
          <div className="text-muted-foreground">No data available</div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-chart={id} className="flex flex-col h-full min-h-[280px] sm:min-h-[400px] glass-card border-none">
      <ChartStyle id={id} config={chartConfig} />
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-0">
        <div className="flex items-center gap-2">
          <PieChartIcon className="size-5 text-muted-foreground shrink-0" />
          <CardTitle className="text-sm sm:text-base lg:text-lg">{getTitle()}</CardTitle>
        </div>
        <div className="flex flex-row gap-2">
          <Select value={distributionType} onValueChange={(value) => setDistributionType(value as DistributionType)}>
            <SelectTrigger className="h-7 w-fit rounded-lg">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="service">Service</SelectItem>
              <SelectItem value="shoe">Shoe</SelectItem>
              <SelectItem value="care">Care</SelectItem>
            </SelectContent>
          </Select>
          <Select value={activeService} onValueChange={setActiveService}>
            <SelectTrigger
              className="h-7 w-fit rounded-lg"
              aria-label="Select a value"
            >
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent align="end" className="rounded-xl">
              {services.map((key: string) => {
                const config = chartConfig[key as keyof typeof chartConfig]

                if (!config) {
                  return null
                }

                return (
                  <SelectItem
                    key={key}
                    value={key}
                    className="rounded-lg [&_span]:flex"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className="flex h-3 w-3 shrink-0 rounded-xs"
                        style={{
                          backgroundColor: `var(--color-${key})`,
                        }}
                      />
                      {config?.label}
                    </div>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 justify-center items-center pb-4">
        <ChartContainer
          id={id}
          config={chartConfig}
          className="mx-auto aspect-square w-full max-w-[400px]"
        >
          <PieChart>
            <ChartTooltip
              cursor={false}
              content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null
                const data = payload[0].payload
                const percentage = ((data.service / totalServices) * 100).toFixed(1)
                const formattedRevenue = new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "PHP",
                }).format(data.revenue)
                
                return (
                  <div className="rounded-lg border bg-background p-2 shadow-sm">
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: data.fill }}
                          />
                          <span className="text-sm font-medium capitalize">
                            {chartConfig[data.type as keyof typeof chartConfig]?.label}
                          </span>
                        </div>
                      </div>
                      <div className="grid gap-1">
                        <div className="flex items-center justify-between gap-8">
                          <span className="text-xs text-muted-foreground">Services:</span>
                          <span className="text-sm font-bold">{data.service}</span>
                        </div>
                        <div className="flex items-center justify-between gap-8">
                          <span className="text-xs text-muted-foreground">Percentage:</span>
                          <span className="text-sm font-bold">{percentage}%</span>
                        </div>
                        <div className="flex items-center justify-between gap-8">
                          <span className="text-xs text-muted-foreground">Revenue:</span>
                          <span className="text-sm font-bold">{formattedRevenue}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              }}
            />
            <Pie
              data={serviceData}
              dataKey="service"
              nameKey="type"
              innerRadius={60}
              strokeWidth={5}
              activeIndex={activeIndex}
              activeShape={({
                outerRadius = 0,
                ...props
              }: PieSectorDataItem) => (
                <g>
                  <Sector {...props} outerRadius={outerRadius + 10} />
                  <Sector
                    {...props}
                    outerRadius={outerRadius + 25}
                    innerRadius={outerRadius + 12}
                  />
                </g>
              )}
            >
              <Label
                content={({ viewBox }) => {
                  if (activeIndex < 0 || !serviceData[activeIndex]) return null
                  if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                    return (
                      <text
                        x={viewBox.cx}
                        y={viewBox.cy}
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        <tspan
                          x={viewBox.cx}
                          y={viewBox.cy}
                          className="fill-foreground text-3xl font-bold"
                        >
                          {serviceData[activeIndex].service.toLocaleString()}
                        </tspan>
                        <tspan
                          x={viewBox.cx}
                          y={(viewBox.cy || 0) + 24}
                          className="fill-muted-foreground"
                        >
                          Bought
                        </tspan>
                      </text>
                    )
                  }
                }}
              />
            </Pie>
            <ChartLegend 
                content={<ChartLegendContent nameKey="type"/>}
                />
          </PieChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
