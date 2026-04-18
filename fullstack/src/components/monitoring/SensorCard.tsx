'use client'

import { Thermometer, Droplets, Zap, Gauge } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { useDashboardWebSocket } from "@/contexts/DashboardWebSocketContext"

const SensorData = {
  temperature: {
    name: "Temperature",
    icon: Thermometer,
    color: "text-orange-600",
    range: "30-40°C normal",
    status: "Normal",
  },
  foamLevel: {
    name: "Foam Level",
    icon: Droplets,
    color: "text-blue-600",
    range: "0-5.3L",
    status: "Normal",
  },
  atomizerLevel: {
    name: "Atomizer Level",
    icon: Gauge,
    color: "text-cyan-600",
    range: "0-5.3L",
    status: "Normal",
  },
  humidity: {
    name: "Humidity",
    icon: Droplets,
    color: "text-teal-600",
    range: "60-70% normal",
    status: "Normal",
  },
  systemStatus: {
    name: "System Status",
    icon: Zap,
    color: "text-yellow-600",
    range: "Timer: 00:00",
    status: "Idle",
  },
} as const

const SensorCard = ({ id }: { id: keyof typeof SensorData }) => {
  const sensor = SensorData[id]

  const { sensorData, isConnected, isLoadingData } = useDashboardWebSocket()

  const Icon = sensor.icon

  // Calculate real-time values based on sensor type
  let displayValue: string = "0"
  let displayPercentage: number = 0
  let displayStatus: string = sensor.status
  let displayRange: string = sensor.range

  if (!isConnected) {
    displayValue = '—'
    displayStatus = 'Offline'
  } else if (isLoadingData) {
    displayValue = '···'
  }

  if (id === 'temperature' && isConnected && sensorData.temperature > 0) {
    displayValue = `${sensorData.temperature.toFixed(1)}°C`
    // Calculate percentage (0-50°C range)
    displayPercentage = Math.min(100, (sensorData.temperature / 50) * 100)
    // Status: Low (<30°C), Normal (30-40°C), High (>40°C)
    if (sensorData.temperature > 40) {
      displayStatus = 'High'
    } else if (sensorData.temperature >= 30) {
      displayStatus = 'Normal'
    } else {
      displayStatus = 'Low'
    }
  }

  if (id === 'humidity' && isConnected && sensorData.humidity > 0) {
    displayValue = `${sensorData.humidity.toFixed(1)}%`
    displayPercentage = Math.min(100, sensorData.humidity)
    // Status: Low (<60%), Normal (60-70%), High (>70%)
    if (sensorData.humidity > 70) {
      displayStatus = 'High'
    } else if (sensorData.humidity >= 60) {
      displayStatus = 'Normal'
    } else {
      displayStatus = 'Low'
    }
  }

  if (id === 'atomizerLevel' && isConnected) {
    if (sensorData.atomizerDistance === -1 || sensorData.atomizerDistance > 21) {
      displayValue = 'Invalid'
      displayStatus = 'Invalid'
      displayPercentage = 0
    } else {
      const MIN_DIST = 8   // cm — container full (5.0L)
      const MAX_DIST = 21  // cm — container empty
      const TANK_L = 5.0
      const liters = Math.round(((MAX_DIST - Math.min(Math.max(sensorData.atomizerDistance, MIN_DIST), MAX_DIST)) / (MAX_DIST - MIN_DIST)) * TANK_L * 10) / 10
      displayValue = `${liters.toFixed(1)}L`
      displayPercentage = (liters / TANK_L) * 100
      if (displayPercentage < 20) {
        displayStatus = 'Critical'
      } else if (displayPercentage < 40) {
        displayStatus = 'Warning'
      } else {
        displayStatus = 'Normal'
      }
    }
  }

  if (id === 'foamLevel' && isConnected) {
    if (sensorData.foamDistance === -1 || sensorData.foamDistance > 21) {
      displayValue = 'Invalid'
      displayStatus = 'Invalid'
      displayPercentage = 0
    } else {
      const MIN_DIST = 8   // cm — container full (5.0L)
      const MAX_DIST = 21  // cm — container empty
      const TANK_L = 5.0
      const liters = Math.round(((MAX_DIST - Math.min(Math.max(sensorData.foamDistance, MIN_DIST), MAX_DIST)) / (MAX_DIST - MIN_DIST)) * TANK_L * 10) / 10
      displayValue = `${liters.toFixed(1)}L`
      displayPercentage = (liters / TANK_L) * 100
      if (displayPercentage < 20) {
        displayStatus = 'Critical'
      } else if (displayPercentage < 40) {
        displayStatus = 'Warning'
      } else {
        displayStatus = 'Normal'
      }
    }
  }

  if (id === 'systemStatus') {
    if (!isConnected) {
      displayValue = 'Device Offline'
      displayStatus = 'Offline'
      displayPercentage = 0
    } else if (isLoadingData) {
      displayValue = 'Connecting···'
      displayStatus = 'Waiting'
      displayPercentage = 0
    } else if (sensorData.serviceActive) {
      displayValue = `${sensorData.serviceType.charAt(0).toUpperCase() + sensorData.serviceType.slice(1)}`
      displayPercentage = sensorData.serviceProgress
      displayStatus = 'Active'
      if (sensorData.serviceTimeRemaining === null) {
        displayRange = 'Timer: --:--'
      } else {
        const rem = sensorData.serviceTimeRemaining
        const mins = Math.floor(rem / 60)
        const secs = rem % 60
        displayRange = `Timer: ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
      }
    } else {
      displayValue = 'Idle'
      displayStatus = 'Normal'
      displayPercentage = 0
      displayRange = 'Timer: 00:00'
    }
  }

  const getBadgeClass = (status: string) => {
    switch (status.toLowerCase()) {
      case "normal":
        return "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800"
      case "active":
        return "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-800"
      case "warning":
        return "bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-400 dark:border-yellow-800"
      case "critical":
        return "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800"
      case "low":
        return "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800"
      case "high":
        return "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800"
      case "invalid":
        return "bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800/40 dark:text-gray-400 dark:border-gray-700"
      case "waiting":
        return "bg-blue-100 text-blue-400 border-blue-200 dark:bg-blue-900/20 dark:text-blue-500 dark:border-blue-800"
      case "offline":
        return "bg-gray-100 text-gray-400 border-gray-200 dark:bg-gray-800/40 dark:text-gray-500 dark:border-gray-700"
      default:
        return ""
    }
  }

  return (
    <Card className="glass-card border-none">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div className="flex items-center gap-2">
          <Icon className={`h-5 w-5 ${sensor.color}`} />
          <CardTitle className="text-sm">{sensor.name}</CardTitle>
        </div>
        <Badge variant="outline" className={getBadgeClass(displayStatus)}>{displayStatus}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-between items-center">
          <span className="text-2xl font-bold">{displayValue}</span>
          <span className="text-xs text-muted-foreground">{displayRange}</span>
        </div>
        <Progress value={displayPercentage} className="h-3" />
      </CardContent>
    </Card>
  )
}

export default SensorCard
