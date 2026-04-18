"use client"

import { motion } from "motion/react"
import PageLoader from "@/components/ui/PageLoader"
import { useDeviceFilter } from "@/contexts/DeviceFilterContext"
import { DevicePairingCard } from "@/components/settings/DevicePairingCard"
import { ServicePricingCard } from "@/components/settings/ServicePricingCard"
import { ServiceDurationCard } from "@/components/settings/ServiceDurationCard"
import { CleaningDistanceCard } from "@/components/settings/CleaningDistanceCard"
import { CleaningMotorSpeedCard } from "@/components/settings/CleaningMotorSpeedCard"
import { useDevicePairing } from "@/hooks/useDevicePairing"
import { useServicePricing } from "@/hooks/useServicePricing"
import { useServiceDuration } from "@/hooks/useServiceDuration"
import { useCleaningDistance } from "@/hooks/useCleaningDistance"
import { useMotorSpeed } from "@/hooks/useMotorSpeed"

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
  const pairing = useDevicePairing()
  const pricing = useServicePricing(selectedDevice)
  const duration = useServiceDuration(selectedDevice)
  const cleaningDist = useCleaningDistance(selectedDevice)
  const motorSpeed = useMotorSpeed(selectedDevice)

  if (pricing.isLoading || duration.isLoading || cleaningDist.isLoading || motorSpeed.isLoading) {
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
          onPairingDialogOpenChange={pairing.setPairingDialogOpen}
          onPairingDeviceIdChange={pairing.setPairingDeviceId}
          onPairingCodeChange={pairing.setPairingCode}
          onPairDevice={pairing.handlePairDevice}
          onEditingDeviceIdChange={pairing.setEditingDeviceId}
          onEditingDeviceNameChange={pairing.setEditingDeviceName}
          onSaveDeviceName={pairing.handleSaveDeviceName}
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

      <motion.div variants={itemVariants}>
        <CleaningDistanceCard
          distances={cleaningDist.distances}
          editedDistances={cleaningDist.editedDistances}
          isSaving={cleaningDist.isSaving}
          selectedDevice={selectedDevice}
          onDistanceChange={cleaningDist.handleDistanceChange}
          hasDistanceChanges={cleaningDist.hasDistanceChanges}
          onSaveDistance={cleaningDist.handleSaveDistance}
        />
      </motion.div>

      <motion.div variants={itemVariants}>
        <CleaningMotorSpeedCard
          speeds={motorSpeed.speeds}
          editedSpeeds={motorSpeed.editedSpeeds}
          isSaving={motorSpeed.isSaving}
          selectedDevice={selectedDevice}
          onSpeedChange={motorSpeed.handleSpeedChange}
          hasSpeedChanges={motorSpeed.hasSpeedChanges}
          onSaveSpeed={motorSpeed.handleSaveSpeed}
        />
      </motion.div>
    </motion.div>
  )
}
