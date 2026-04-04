"use client"

import { motion } from "motion/react"
import { Settings } from "lucide-react"
import PageLoader from "@/components/ui/PageLoader"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useDeviceFilter } from "@/contexts/DeviceFilterContext"
import { useDashboardWebSocket } from "@/contexts/DashboardWebSocketContext"
import { DevicePairingCard } from "@/components/settings/DevicePairingCard"
import { ServicePricingCard } from "@/components/settings/ServicePricingCard"
import { ServiceDurationCard } from "@/components/settings/ServiceDurationCard"
import { useDevicePairing } from "@/hooks/useDevicePairing"
import { useServicePricing } from "@/hooks/useServicePricing"
import { useServiceDuration } from "@/hooks/useServiceDuration"

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

export default function SettingsPage() {
  const { selectedDevice } = useDeviceFilter()
  const { isConnected } = useDashboardWebSocket()
  const pairing = useDevicePairing()
  const pricing = useServicePricing(selectedDevice)
  const duration = useServiceDuration(selectedDevice)

  if (pricing.isLoading || duration.isLoading) {
    return (
      <div className="flex flex-1 flex-col w-full">
        <PageLoader label="Loading settings" />
      </div>
    )
  }

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={containerVariants}
      className="w-full space-y-8 pb-12"
    >
      <motion.div variants={itemVariants} className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Client <span className="text-primary">Settings</span></h1>
        </div>
        <p className="text-muted-foreground">Manage your devices, pricing, and service durations.</p>
      </motion.div>

      <motion.div variants={itemVariants}>
        <DevicePairingCard
          devices={pairing.devices}
          isPairing={pairing.isPairing}
          pairingDialogOpen={pairing.pairingDialogOpen}
          pairingDeviceId={pairing.pairingDeviceId}
          pairingCode={pairing.pairingCode}
          editingDeviceId={pairing.editingDeviceId}
          editingDeviceName={pairing.editingDeviceName}
          restartingDeviceId={pairing.restartingDeviceId}
          unpairConfirmId={pairing.unpairConfirmId}
          onPairingDialogOpenChange={pairing.setPairingDialogOpen}
          onPairingDeviceIdChange={pairing.setPairingDeviceId}
          onPairingCodeChange={pairing.setPairingCode}
          onPairDevice={pairing.handlePairDevice}
          onUnpairDevice={pairing.handleUnpairDevice}
          onRestartDevice={pairing.handleRestartDevice}
          onEditingDeviceIdChange={pairing.setEditingDeviceId}
          onEditingDeviceNameChange={pairing.setEditingDeviceName}
          onSaveDeviceName={pairing.handleSaveDeviceName}
          onUnpairConfirmIdChange={pairing.setUnpairConfirmId}
          formatLastSeen={pairing.formatLastSeen}
        />
      </motion.div>

      <motion.div variants={itemVariants}>
        <ServicePricingCard
          pricing={pricing.pricing}
          editedPrices={pricing.editedPrices}
          isSaving={pricing.isSaving}
          selectedDevice={selectedDevice}
          onPriceChange={pricing.handlePriceChange}
          onSave={pricing.handleSave}
          hasChanges={pricing.hasChanges}
        />
      </motion.div>

      <motion.div variants={itemVariants}>
        <ServiceDurationCard
          durations={duration.durations}
          editedDurations={duration.editedDurations}
          isSavingDuration={duration.isSaving}
          selectedDevice={selectedDevice}
          onDurationChange={duration.handleDurationChange}
          hasDurationChanges={duration.hasDurationChanges}
          onSaveDuration={duration.handleSaveDuration}
        />
      </motion.div>
    </motion.div>
  )
}
