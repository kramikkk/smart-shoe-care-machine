'use client'

import { useRef, useEffect, useState } from 'react'
import { motion, useScroll, useTransform, type MotionValue } from 'motion/react'
import Image from 'next/image'
import { Info } from 'lucide-react'

const shoeTypes = [
  {
    type: 'Rubber',
    title: 'Rubber & Synthetics',
    description: 'Specialized deep cleaning and gentle heating algorithms designed for sneakers, running shoes, and synthetic materials to remove tough stains.',
    image: '/RubberShoes.webp',
    color: 'from-blue-600/20 to-cyan-600/20',
  },
  {
    type: 'Canvas',
    title: 'Canvas & Textiles',
    description: 'Precision brushing paired with low-temperature drying to preserve fabric integrity, prevent shrinking, and revive original colors.',
    image: '/CanvasShoes.webp',
    color: 'from-purple-600/20 to-pink-600/20',
  },
  {
    type: 'Mesh',
    title: 'Mesh & Knit',
    description: 'Delicate water flow and UV sterilization penetrate deep into porous mesh layers to eliminate deep-seated odors and bacteria.',
    image: '/MeshShoes.webp',
    color: 'from-orange-600/20 to-yellow-600/20',
  }
]

// How much each back card scales down
const STACK_SCALE_STEP = 0.07

export default function ShoeTypes() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollRange, setScrollRange] = useState([0, 1])
  const [stackOffset, setStackOffset] = useState(64)
  const { scrollY } = useScroll()

  useEffect(() => {
    const update = () => {
      setStackOffset(window.innerWidth < 768 ? 32 : 64)
      const el = containerRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top + window.scrollY
      const height = el.offsetHeight
      setScrollRange([top, top + height - window.innerHeight])
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const scrollYProgress = useTransform(scrollY, scrollRange, [0, 1], { clamp: true })

  return (
    <section
      ref={containerRef}
      id="shoe-types"
      className="relative bg-background z-20"
      style={{ height: '300vh' }}
    >
      {/* Sticky viewport — stays fixed while the section scrolls */}
      <div className="sticky top-0 h-screen flex flex-col overflow-hidden">
        {/* Header */}
        <div className="relative container mx-auto px-6 max-w-7xl pt-8 pb-3 md:pt-16 md:pb-6 flex-shrink-0 text-center">
          <motion.span
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-primary font-mono text-sm uppercase tracking-[0.3em] mb-4 block"
          >
            Supported Materials
          </motion.span>
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold tracking-tighter"
          >
            Tailored Care for Every Pair
          </motion.h2>
        </div>

        {/* Card stage — cards are absolutely stacked here */}
        <div className="relative flex-1 container mx-auto px-6 max-w-7xl">
          {shoeTypes.map((shoe, index) => (
            <ShoeCard
              key={index}
              shoe={shoe}
              index={index}
              total={shoeTypes.length}
              progress={scrollYProgress}
              stackOffset={stackOffset}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function ShoeCard({
  shoe,
  index,
  total,
  progress,
  stackOffset,
}: {
  shoe: (typeof shoeTypes)[number]
  index: number
  total: number
  progress: MotionValue<number>
  stackOffset: number
}) {
  const isFirst = index === 0

  // Progress range when this card slides into its resting position
  // Card 0 is visible from the start; cards 1+ slide in later
  const enterStart = isFirst ? 0 : (index / total) * 0.85
  const enterEnd   = isFirst ? 0 : Math.min(1, enterStart + 0.2)

  // Final resting state for this card in the stack
  // The front card (last index) sits at y=0; back cards peek above it
  const finalY     = -(total - 1 - index) * stackOffset
  const finalScale = 1 - (total - 1 - index) * STACK_SCALE_STEP

  // y: slide in from below then settle into stack position
  const y = useTransform(
    progress,
    isFirst
      ? [0, 1]
      : [0, enterStart, enterEnd, 1],
    isFirst
      ? [0, finalY]
      : [700, 700, 0, finalY],
  )

  // scale: reaches 1 when entering, then shrinks to finalScale
  const scale = useTransform(
    progress,
    isFirst
      ? [0, 1]
      : [enterEnd, 1],
    isFirst
      ? [1, finalScale]
      : [1, finalScale],
  )

  return (
    <motion.div
      className="absolute inset-0 flex items-center"
      style={{ y, scale, zIndex: index + 1 }}
    >
      <div className="w-full h-[60vh] min-h-[360px] max-h-[520px] rounded-[2rem] md:rounded-[2.5rem] overflow-hidden border border-white/10 flex flex-col md:flex-row relative bg-zinc-950 shadow-2xl items-center">
        {/* Background gradient */}
        <div className={`absolute inset-0 bg-gradient-to-br opacity-50 ${shoe.color}`} />

        {/* Decorative blobs */}
        <div className="absolute top-0 left-0 w-64 h-64 bg-white/5 blur-[100px] rounded-full pointer-events-none" />
        <div className="absolute bottom-0 right-0 w-64 h-64 bg-primary/10 blur-[100px] rounded-full pointer-events-none" />

        {/* Text side */}
        <div className="md:w-1/2 p-5 md:p-16 z-10 flex flex-col justify-center flex-shrink-0 md:h-full gap-2 md:gap-6">
          <div className="flex items-center gap-2 text-primary font-mono text-xs sm:text-sm md:text-base uppercase tracking-wider backdrop-blur-md bg-white/5 w-fit px-3 py-1.5 md:px-4 md:py-2 rounded-full border border-white/10 shadow-inner">
            <Info className="w-3 h-3 md:w-4 md:h-4 lg:w-5 lg:h-5" /> Material Type
          </div>
          <h3 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-white tracking-tight drop-shadow-sm">
            {shoe.title}
          </h3>
          <p className="text-base sm:text-lg md:text-xl text-white/70 leading-relaxed max-w-md font-light line-clamp-2 md:line-clamp-none">
            {shoe.description}
          </p>
        </div>

        {/* Image side */}
        <div className="md:w-1/2 relative flex-1 md:h-full w-full flex items-center justify-center p-4 md:p-8 z-10 overflow-hidden group min-h-0">
          <div className="absolute inset-0 m-auto w-3/4 h-3/4 bg-white/5 rounded-full blur-[80px] group-hover:scale-110 transition-transform duration-700" />
          <div className="relative w-full aspect-square max-h-[90%] md:max-h-[80%] flex items-center justify-center">
            <Image
              src={shoe.image}
              alt={shoe.title}
              fill
              sizes="(max-width: 768px) 100vw, 50vw"
              className="object-contain drop-shadow-2xl group-hover:scale-105 group-hover:rotate-[-2deg] transition-all duration-700 ease-out"
            />
          </div>
        </div>
      </div>
    </motion.div>
  )
}
