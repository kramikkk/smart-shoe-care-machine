'use client'

import { motion } from "motion/react"
import AreaChartCard from "@/components/dashboard/AreaChartCard"
import { PieChartCard } from "@/components/dashboard/PieChartCard"
import StatsCard from "@/components/dashboard/StatsCard"
import RecentTransactionTable from "@/components/dashboard/RecentTransactionTable"
import SystemAlertCard from "@/components/monitoring/SystemAlertCard"
import SensorCard from "@/components/monitoring/SensorCard"
import { DashboardWebSocketProvider } from "@/contexts/DashboardWebSocketContext"
import { TimeRangeProvider, useTimeRange, type TimeRange } from "@/contexts/TimeRangeContext"
import { useSession } from "@/lib/auth-client"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"

const containerVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
        opacity: 1,
        y: 0,
        transition: {
            duration: 0.6,
            staggerChildren: 0.1
        }
    }
}

const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 }
}

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
    { value: 'today', label: 'Today' },
    { value: 'week', label: 'This Week' },
    { value: 'month', label: 'This Month' },
    { value: 'year', label: 'This Year' },
]

function DashboardInner() {
    const { data: session } = useSession()
    const userName = session?.user?.name || "User"
    const { timeRange, setTimeRange } = useTimeRange()

    return (
        <motion.div
            initial="hidden"
            animate="visible"
            variants={containerVariants}
            className="flex flex-col gap-6 w-full overflow-x-hidden overflow-y-auto pb-8"
        >
            {/* Header */}
            <motion.div variants={itemVariants} className="flex items-start justify-between gap-4 mb-2">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                        Welcome Back, <span className="text-primary">{userName}!</span>
                    </h1>
                    <p className="text-sm sm:text-base text-muted-foreground">Monitor your shoe care systems in real-time.</p>
                </div>
                <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
                    <SelectTrigger className="h-9 w-fit rounded-lg shrink-0 text-xs sm:text-sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                        {TIME_RANGE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </motion.div>

            {/* Stats and Sensor Cards */}
            <motion.div variants={itemVariants} className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                <StatsCard id="totalRevenue" />
                <StatsCard id="totalTransactions" />
                <div className="sm:col-span-2 xl:col-span-1">
                    <SensorCard id="systemStatus" />
                </div>
            </motion.div>

            {/* Charts Section */}
            <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 items-stretch">
                <div className="lg:col-span-1 xl:col-span-2 h-full">
                    <AreaChartCard />
                </div>
                <div className="lg:col-span-1 xl:col-span-1 h-full">
                    <PieChartCard />
                </div>
            </motion.div>

            {/* Transactions and Alerts Section */}
            <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 items-stretch">
                <div className="lg:col-span-1 xl:col-span-2 h-full">
                    <RecentTransactionTable />
                </div>
                <div className="lg:col-span-1 xl:col-span-1 h-full">
                    <SystemAlertCard className="flex flex-col h-full" />
                </div>
            </motion.div>
        </motion.div>
    )
}

export default function DashboardPage() {
    return (
        <DashboardWebSocketProvider>
            <TimeRangeProvider>
                <DashboardInner />
            </TimeRangeProvider>
        </DashboardWebSocketProvider>
    )
}
