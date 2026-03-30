'use client'

import React from 'react'
import Image from 'next/image'
import { motion } from 'motion/react'

export function LoginVisualSide() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-black flex items-center justify-center">
      {/* Background Gradients & Noise */}
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-black to-black opacity-60" />
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[120px] rounded-full animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] bg-primary/10 blur-[100px] rounded-full" />
      </div>

      {/* Noise Overlay */}
      <div className="absolute inset-0 z-1 opacity-20 pointer-events-none noise-overlay" />

      {/* Main Visual */}
      <motion.div
        initial={{ opacity: 0, scale: 1.05 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 2, ease: [0.16, 1, 0.3, 1] }}
        className="absolute inset-0 z-0"
      >
        <Image
          src="/SSCMHero.png"
          alt="SSCM Machine"
          fill
          className="object-cover opacity-60 mix-blend-luminosity grayscale hover:grayscale-0 hover:opacity-100 hover:scale-105 transition-all duration-[2s] ease-out"
          priority
        />
        {/* Cinematic gradient overlay over image */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/60 to-transparent" />
      </motion.div>

      <div className="relative z-10 w-full h-full flex flex-col items-start justify-end p-12 md:p-24 pb-32">
        <div className="text-left shrink-0 max-w-xl">
          <motion.span
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.5, duration: 0.8 }}
            className="editorial-caps text-primary block mb-4"
          >
            05 / SMART SHOE CARE SYSTEM
          </motion.span>
          <motion.h2
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7, duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
            className="text-5xl md:text-7xl font-black tracking-tighter text-white uppercase italic leading-[0.85]"
          >
            SSCM <br /> <span className="text-primary text-outline">DASHBOARD</span>
          </motion.h2>
        </div>
      </div>

      {/* Footer Decoration */}
      <div className="absolute bottom-12 left-12 right-12 z-20 flex justify-between items-end opacity-30">
        <div className="flex flex-col gap-1">
          <div className="h-px w-24 bg-white/20" />
          <span className="text-[10px] font-mono tracking-widest text-white uppercase">System Status: Ready</span>
        </div>
        <div className="text-[10px] font-mono tracking-widest text-white uppercase text-right">
          v{process.env.NEXT_PUBLIC_APP_VERSION} / SSCM_CORE
        </div>
      </div>
    </div>
  )
}
