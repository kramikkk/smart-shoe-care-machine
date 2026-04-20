"use client"

import { motion } from "motion/react"
import { Smartphone } from "lucide-react"
import { DevicePairingCard } from "@/components/settings/DevicePairingCard"
import { useDevicePairing } from "@/hooks/useDevicePairing"

const containerVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      staggerChildren: 0.1,
    },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
}

export default function PairingPage() {
  const pairing = useDevicePairing()

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={containerVariants}
      className="w-full space-y-8 pb-12"
    >
      <motion.div variants={itemVariants} className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Smartphone className="h-6 w-6 text-primary" />
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Device <span className="text-primary">Pairing</span>
          </h1>
        </div>
        <p className="text-muted-foreground">
          Pair, manage, and monitor your kiosk devices from one place.
        </p>
      </motion.div>

      <motion.div variants={itemVariants} className="grid gap-6 xl:grid-cols-[2fr_1fr]">
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

        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
          <h3 className="text-base font-semibold">How to pair a device</h3>
          <ol className="mt-3 list-decimal space-y-3 pl-4 text-sm text-muted-foreground">
            <li>
              On the kiosk screen, see <span className="font-medium text-foreground"> Device Pairing</span>. You must have the following:
              <span className="block mt-1">
                • <span className="font-medium text-foreground">Device ID</span> (example: <span className="font-mono">SSCM-XXXXXX</span>)
              </span>
              <span className="block">
                • <span className="font-medium text-foreground">6-digit Pairing Code</span>
              </span>
              <span className="block">
                • <span className="font-medium text-foreground">QR Code</span>
              </span>
            </li>
            <li>
              In dashboard, click <span className="font-medium text-foreground">Pair New Device</span>.
            </li>
            <li>
              Choose one method:
              <span className="block mt-1">
                • <span className="font-medium text-foreground">Manual entry:</span> type Device ID and Pairing Code exactly as shown on kiosk.
              </span>
              <span className="block">
                • <span className="font-medium text-foreground">QR auto-fill:</span> scan the kiosk pairing QR to open this page with fields pre-filled.
              </span>
            </li>
            <li>
              Click <span className="font-medium text-foreground">Pair Device</span> and wait for success confirmation.
            </li>
            <li>
              After pairing, the device appears in the list and shows live <span className="font-medium text-foreground">Online/Offline</span> status.
            </li>
          </ol>

          <div className="mt-4 rounded-lg bg-primary/10 p-3 text-xs text-primary">
            Tip: If Device ID input is required, enter the SSCM device ID first to proceed with pairing.
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
