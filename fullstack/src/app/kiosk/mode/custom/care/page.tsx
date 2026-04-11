'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Item, ItemContent } from '@/components/ui/item'
import Image from 'next/image'
import { Suspense } from 'react'
import { BackButton } from '@/components/kiosk/BackButton'
import { StepIndicator } from '@/components/kiosk/StepIndicator'
import { CUSTOM_STEPS } from '@/lib/kiosk-constants'
import { useDurations } from '@/hooks/useDurations'

const careTypes = [
  { id: 'gentle', name: 'Gentle', image: '/Gentle3D.webp' },
  { id: 'normal', name: 'Normal', image: '/Normal3D.webp' },
  { id: 'strong', name: 'Strong', image: '/Strong3D.webp' },
]

function formatDurationBadge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m === 0) return `${s} sec`
  if (s === 0) return m === 1 ? '1 min' : `${m} min`
  return `${m} min ${s} sec`
}

function CareContent() {
  const searchParams = useSearchParams()
  const service = (searchParams.get('service') || 'cleaning').toLowerCase()
  const shoe = searchParams.get('shoe') || 'mesh'
  const router = useRouter()
  const { durations } = useDurations()

  const [selected, setSelected] = useState<string | null>(null)

  const getDescription = (careId: string) => {
    const descriptions: Record<string, Record<string, string>> = {
      cleaning: {
        gentle: 'For delicate materials',
        normal: 'Suitable for most shoes',
        strong: 'For heavily soiled shoes'
      },
      drying: {
        gentle: 'Mild dry',
        normal: 'Standard dry',
        strong: 'Extended dry'
      },
      sterilizing: {
        gentle: 'Mild UV treatment',
        normal: 'Standard UV treatment',
        strong: 'Maximum UV treatment'
      },
      package: {
        gentle: 'Ideal for delicate shoes',
        normal: 'Suitable for most shoes',
        strong: 'For heavily soiled shoes'
      }
    }
    return descriptions[service]?.[careId] || descriptions.cleaning[careId]
  }

  const getBadge = (careId: string) => {
    const sec = durations[service]?.[careId]
    if (sec == null || !Number.isFinite(sec)) return '—'
    return formatDurationBadge(sec)
  }

  const handleProceed = () => {
    if (selected) router.push(`/kiosk/payment?shoe=${shoe}&service=${service}&care=${selected}`)
  }

  return (
    <div className="relative">
      <BackButton />

      <StepIndicator steps={CUSTOM_STEPS} currentStep={3} />

      <h1 className="text-5xl font-bold text-center mb-10 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        Choose Care Type
      </h1>

      <div className='flex gap-8 justify-center mb-8'>
        {careTypes.map((care) => (
          <Item
            key={care.id}
            onClick={() => setSelected(care.id)}
            className={`text-center p-8 rounded-lg shadow-lg w-80 flex flex-col items-center cursor-pointer transition-all duration-200 select-none
              ${selected === care.id
                ? 'bg-white/90 ring-4 ring-blue-500 shadow-2xl scale-[1.03]'
                : 'bg-white/50 hover:bg-white/70 hover:shadow-xl'
              }`}
          >
            <Image src={care.image} alt={care.name} width={128} height={128} className="w-32 h-32" />
            <ItemContent className="flex flex-col items-center">
              <h2 className="text-2xl font-bold mb-2">{care.name}</h2>
              <p className="text-xl text-gray-700 mb-3 px-2">{getDescription(care.id)}</p>
              <span className="inline-block w-fit self-center px-4 py-1 bg-gradient-to-r from-green-100 to-emerald-100 rounded-full text-base font-bold text-green-800 shadow-sm">
                {getBadge(care.id)}
              </span>
            </ItemContent>
          </Item>
        ))}
      </div>

      <div className="flex justify-center">
        <Button
          onClick={handleProceed}
          disabled={!selected}
          className="px-12 py-6 text-xl font-bold bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 hover:from-blue-700 hover:via-cyan-700 hover:to-green-700 text-white rounded-full shadow-lg transition-all duration-200 transform hover:scale-105 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
        >
          Proceed
        </Button>
      </div>
    </div>
  )
}

const Care = () => {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CareContent />
    </Suspense>
  )
}

export default Care
