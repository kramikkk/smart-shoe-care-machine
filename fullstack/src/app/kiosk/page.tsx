'use client'

import { useRouter } from 'next/navigation'
import Image from 'next/image'
import React from 'react'
import { motion } from 'motion/react'

const KioskHomePage = () => {
  const router = useRouter()

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center cursor-pointer select-none"
      onClick={() => router.push('/kiosk/mode')}
    >
      <motion.div
        className="mx-auto mb-8"
        animate={{ y: [0, -14, 0] }}
        transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
      >
        <Image
          src="/SSCMlogoTrans.webp"
          alt="Smart Shoe Care Machine Logo"
          width={300}
          height={300}
          priority
          style={{ width: 'auto', height: 'auto' }}
        />
      </motion.div>

      <h1 className="text-5xl font-bold text-center mb-4 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        Smart Shoe Care Machine
      </h1>
      <p className="text-center text-2xl text-gray-700 mb-12">
        Keep your shoes fresh, clean, and ready to wear.
      </p>

      <p className="text-center text-xl text-gray-500 animate-pulse">
        Touch anywhere to proceed
      </p>
    </div>
  )
}

export default KioskHomePage
