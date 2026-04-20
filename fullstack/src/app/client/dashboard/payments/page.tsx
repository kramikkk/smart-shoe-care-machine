"use client"

import { motion } from "motion/react"
import { QrCode } from "lucide-react"
import { PaymentProviderCard } from "@/components/settings/PaymentProviderCard"

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

export default function PaymentsPage() {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={containerVariants}
      className="w-full space-y-8 pb-12"
    >
      <motion.div variants={itemVariants} className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <QrCode className="h-6 w-6 text-primary" />
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            QR <span className="text-primary">Payment</span>
          </h1>
        </div>
        <p className="text-muted-foreground">
          Manage online QR payment credentials, status, and controls.
        </p>
      </motion.div>

      <motion.div variants={itemVariants}>
        <PaymentProviderCard />
      </motion.div>
    </motion.div>
  )
}
