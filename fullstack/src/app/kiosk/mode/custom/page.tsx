'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Item, ItemContent } from '@/components/ui/item'
import Image from 'next/image'
import { BackButton } from '@/components/kiosk/BackButton'
import { StepIndicator } from '@/components/kiosk/StepIndicator'
import { CUSTOM_STEPS } from '@/lib/kiosk-constants'

const shoeTypes = [
  { id: 'mesh',   label: 'Mesh',   image: '/MeshShoes.webp',   desc: 'Mesh-like material' },
  { id: 'canvas', label: 'Canvas', image: '/CanvasShoes.webp', desc: 'Fabric-like material' },
  { id: 'rubber', label: 'Rubber', image: '/RubberShoes.webp', desc: 'Rubber-like material' },
]

const ShoeTypePage = () => {
  const [selected, setSelected] = useState<string | null>(null)
  const router = useRouter()

  const handleProceed = () => {
    if (selected) router.push(`/kiosk/mode/custom/service?shoe=${selected}`)
  }

  return (
    <div className="relative">
      <BackButton />

      <StepIndicator steps={CUSTOM_STEPS} currentStep={1} />

      <h1 className="text-5xl font-bold text-center mb-10 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        Choose Shoe Type
      </h1>

      <div className='flex gap-8 justify-center mb-8'>
        {shoeTypes.map((shoe) => (
          <Item
            key={shoe.id}
            onClick={() => setSelected(shoe.id)}
            className={`text-center p-8 rounded-lg shadow-lg flex flex-col items-center cursor-pointer transition-all duration-200 select-none
              ${selected === shoe.id
                ? 'bg-white/90 ring-4 ring-blue-500 shadow-2xl scale-[1.03]'
                : 'bg-white/50 hover:bg-white/70 hover:shadow-xl'
              }`}
          >
            <Image src={shoe.image} alt={shoe.label} width={128} height={128} className="w-32 h-32" />
            <ItemContent>
              <h2 className="text-2xl font-bold mb-2">{shoe.label}</h2>
              <p className="text-xl text-gray-600">{shoe.desc}</p>
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

export default ShoeTypePage
