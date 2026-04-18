'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Item, ItemContent, ItemHeader } from '@/components/ui/item'
import Image from 'next/image'
import { BackButton } from '@/components/kiosk/BackButton'
import { StepIndicator } from '@/components/kiosk/StepIndicator'
import { CUSTOM_STEPS, AUTO_STEPS, ServiceType } from '@/lib/kiosk-constants'
import { usePricing } from '@/hooks/usePricing'

const paymentMethods = [
  {
    id: 'offline',
    src: '/Cash3D.webp',
    alt: 'Cash Payment',
    title: 'Cash Payment',
    descriptions: ['Insert coins or bills into the machine', 'Accepts: ₱1, ₱5, ₱10, ₱20, ₱50, ₱100'],
  },
  {
    id: 'online',
    src: '/QR3D.webp',
    alt: 'Online Payment',
    title: 'Online Payment',
    descriptions: ['Scan QR code with your mobile device', 'Supports GCash, PayMaya, and GrabPay'],
  },
]

const Payment = () => {
  const searchParams = useSearchParams()
  const router = useRouter()
  const shoe = searchParams.get('shoe') || 'N/A'
  const service = searchParams.get('service')
  const care = searchParams.get('care')

  const [selected, setSelected] = useState<string | null>(null)
  const { getPrice } = usePricing()

  const effectiveCare = care || 'normal'
  const serviceLabel = service ? service.charAt(0).toUpperCase() + service.slice(1) : 'Package'
  const careLabel = !care ? (service === 'package' ? 'Auto' : 'N/A') : care.charAt(0).toUpperCase() + care.slice(1)
  const price = service ? getPrice(service, effectiveCare) : 0

  const summaryData = [
    { label: 'Shoe Type', value: shoe.charAt(0).toUpperCase() + shoe.slice(1) },
    { label: 'Service',   value: serviceLabel },
    { label: 'Care Type', value: careLabel },
    { label: 'Total',     value: `₱${price.toFixed(2)}` },
  ]

  const buildQueryString = () => {
    const params = []
    if (shoe)    params.push(`shoe=${shoe}`)
    if (service) params.push(`service=${service}`)
    if (care)    params.push(`care=${care}`)
    return params.length > 0 ? `?${params.join('&')}` : ''
  }

  const handleProceed = () => {
    if (selected) router.push(`/kiosk/payment/${selected}${buildQueryString()}`)
  }

  const isAutoMode = service === 'package' && !care

  return (
    <div className="min-h-screen px-10 py-4 relative flex flex-col items-center justify-center">
      <BackButton />

      <StepIndicator
        steps={isAutoMode ? AUTO_STEPS : CUSTOM_STEPS}
        currentStep={isAutoMode ? 2 : 4}
      />

      <h1 className="text-5xl font-bold text-center mb-6 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        Select Payment Method
      </h1>

      {/* Summary */}
      <div className="flex justify-center mb-6 max-w-3xl w-full">
        <Item className="bg-white/50 px-8 py-4 rounded-xl shadow-lg w-full">
          <div className="grid grid-cols-4 gap-6 w-full">
            {summaryData.map((item, index) => (
              <ItemContent key={index} className="flex flex-col items-center">
                <p className="text-base font-bold text-gray-500">{item.label}</p>
                <p className="text-2xl font-semibold text-gray-800">{item.value}</p>
              </ItemContent>
            ))}
          </div>
        </Item>
      </div>

      {/* Payment Method Cards */}
      <div className="grid grid-cols-2 gap-6 max-w-3xl mx-auto mb-12 w-full">
        {paymentMethods.map((method) => (
          <Item
            key={method.id}
            onClick={() => setSelected(method.id)}
            className={`text-center p-6 rounded-2xl shadow-lg flex flex-col items-center justify-center cursor-pointer transition-all duration-200 select-none
              ${selected === method.id
                ? 'bg-white/90 ring-4 ring-blue-500 shadow-2xl scale-[1.03]'
                : 'bg-white/50 hover:bg-white/70 hover:shadow-xl'
              }`}
          >
            <Image src={method.src} alt={method.alt} width={72} height={72} className="w-18 h-18 mb-3" />
            <ItemContent className="flex flex-col items-center space-y-1">
              <h2 className="text-xl font-bold">{method.title}</h2>
              <div className="space-y-1">
                {method.descriptions.map((desc, idx) => (
                  <p key={idx} className="text-base text-gray-600">{desc}</p>
                ))}
              </div>
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

export default Payment
