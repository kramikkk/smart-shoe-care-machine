"use client"

import { motion } from "motion/react"
import SensCard from "@/components/monitoring/SensorCard"
import SystemAlertCard from "@/components/monitoring/SystemAlertCard"

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

export default function SystemPage() {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={containerVariants}
      className="flex flex-col space-y-6 h-full pb-8"
    >
      <motion.div variants={itemVariants}>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">System <span className="text-primary">Monitoring</span></h1>
        <p className="text-sm sm:text-base text-muted-foreground">Real-time status of all device sensors and alerts.</p>
      </motion.div>

      <motion.div variants={itemVariants}>
        <SensCard id="systemStatus"/>
      </motion.div>

      <motion.div variants={itemVariants} className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
        <SensCard id="temperature"/>
        <SensCard id="humidity"/>
        <SensCard id="foamLevel"/>
        <SensCard id="atomizerLevel"/>
      </motion.div>

      <motion.div variants={itemVariants}>
        <SystemAlertCard />
      </motion.div>
    </motion.div>
  )
}