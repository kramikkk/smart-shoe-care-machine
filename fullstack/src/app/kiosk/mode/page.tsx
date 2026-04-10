'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Item, ItemContent } from '@/components/ui/item'
import Image from 'next/image'
import { BackButton } from '@/components/kiosk/BackButton'
import { StepIndicator } from '@/components/kiosk/StepIndicator'
import { CUSTOM_STEPS, AUTO_STEPS } from '@/lib/kiosk-constants'

const modes = [
  {
    id: 'auto',
    label: 'Auto Mode',
    image: '/Automatic3D.webp',
    descriptions: ['Automatic Shoe Type Detection', 'Automated Service Package', 'Automated Care Type Selection'],
    href: '/kiosk/mode/auto/classify',
  },
  {
    id: 'custom',
    label: 'Custom Mode',
    image: '/Custom3D.webp',
    descriptions: ['Manual Shoe Type Selection', 'Choose Service Type', 'Choose Care Type'],
    href: '/kiosk/mode/custom',
  },
]

const ModePage = () => {
  const [selected, setSelected] = useState<string | null>(null)
  const router = useRouter()

  const currentSteps = selected === 'auto' ? AUTO_STEPS : CUSTOM_STEPS

  const handleProceed = () => {
    const mode = modes.find(m => m.id === selected)
    if (mode) router.push(mode.href)
  }

  return (
    <div className="relative">
      <BackButton href="/kiosk" />

      <StepIndicator steps={currentSteps} currentStep={0} />

      <h1 className="text-5xl font-bold text-center mb-10 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        Select Mode
      </h1>

      <div className='flex gap-8 justify-center mb-8'>
        {modes.map((mode) => (
          <Item
            key={mode.id}
            onClick={() => setSelected(mode.id)}
            className={`text-center p-8 rounded-lg shadow-lg w-100 flex flex-col items-center cursor-pointer transition-all duration-200 select-none
              ${selected === mode.id
                ? 'bg-white/90 ring-4 ring-blue-500 shadow-2xl scale-[1.03]'
                : 'bg-white/50 hover:bg-white/70 hover:shadow-xl'
              }`}
          >
            <Image src={mode.image} alt={mode.label} width={128} height={128} className="w-32 h-32" />
            <ItemContent>
              <h2 className="text-2xl font-bold mb-4">{mode.label}</h2>
              {mode.descriptions.map((desc, i) => (
                <p key={i} className="text-xl text-gray-600">{desc}</p>
              ))}
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

export default ModePage
