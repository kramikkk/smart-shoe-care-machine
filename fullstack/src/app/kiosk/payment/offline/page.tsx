'use client'

import { Button } from '@/components/ui/button'
import { debug } from '@/lib/debug'
import { Card, CardContent } from '@/components/ui/card'
import { Item, ItemContent } from '@/components/ui/item'
import React, { useState, useEffect, useRef } from 'react'
import { AlertTriangle, Loader2, ArrowLeft } from 'lucide-react'
import { useSearchParams, useRouter } from 'next/navigation'
import { ServiceType } from '@/lib/kiosk-constants'
import { usePricing } from '@/hooks/usePricing'
import { useKioskWebSocket } from '@/contexts/KioskWebSocketContext'

const Offline = () => {
  const searchParams = useSearchParams()
  const router = useRouter()
  const shoe = searchParams.get('shoe') || 'mesh'
  const service = searchParams.get('service') as ServiceType || 'package'
  const care = searchParams.get('care') || 'normal'

  const { getPrice } = usePricing()

  const amountDue = getPrice(service, care)
  const [amountInserted, setAmountInserted] = useState(0)
  const amountRemaining = Math.max(0, amountDue - amountInserted)
  const [isSaving, setIsSaving] = useState(false)

  // Check if payment is complete (amount inserted >= amount due OR amount due is 0)
  const isPaymentComplete = amountDue === 0 || amountInserted >= amountDue

  const [showExitWarning, setShowExitWarning] = useState(false)

  const { isConnected, sendMessage, onMessage } = useKioskWebSocket()

  // Stable refs for cleanup
  const sendMessageRef = useRef(sendMessage)
  const isConnectedRef = useRef(isConnected)
  useEffect(() => {
    sendMessageRef.current = sendMessage
    isConnectedRef.current = isConnected
  }, [sendMessage, isConnected])

  // Enable payment system when connected
  useEffect(() => {
    if (!isConnected) return
    const deviceId = localStorage.getItem('kiosk_device_id')
    if (!deviceId) return
    debug.log(`[Offline] Payment system enabled — device: ${deviceId}`)
    sendMessage({ type: 'enable-payment', deviceId })
  }, [isConnected, sendMessage])

  // Disable payment system on unmount
  useEffect(() => {
    return () => {
      const deviceId = localStorage.getItem('kiosk_device_id')
      if (isConnectedRef.current && deviceId) {
        sendMessageRef.current({ type: 'disable-payment', deviceId })
      }
    }
  }, [])

  // Receive coin/bill events
  useEffect(() => {
    const unsubscribe = onMessage((message) => {
      if (message.type === 'coin-inserted') {
        debug.log(`[Offline] Coin inserted: ₱${message.coinValue}`)
        setAmountInserted((prev) => prev + message.coinValue)
      } else if (message.type === 'bill-inserted') {
        debug.log(`[Offline] Bill inserted: ₱${message.billValue}`)
        setAmountInserted((prev) => prev + message.billValue)
      }
    })
    return unsubscribe
  }, [onMessage])

  // STEP 3A: Handle payment proceed - save transaction and redirect
  const handleProceed = async () => {
    // Don't allow proceeding if payment is not complete
    if (!isPaymentComplete) {
      return
    }

    setIsSaving(true)

    // Save transaction — non-fatal (machine already has the cash; always redirect after)
    const deviceId = localStorage.getItem('kiosk_device_id')
    const groupToken = localStorage.getItem('kiosk_group_token')

    if (deviceId && groupToken) {
      debug.log(`[Offline] Saving cash transaction — device: ${deviceId}, service: ${service}, shoe: ${shoe}`)
      try {
        const res = await fetch('/api/transaction/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Group-Token': groupToken,
          },
          body: JSON.stringify({
            paymentMethod: 'Cash',
            serviceType: service.charAt(0).toUpperCase() + service.slice(1),
            shoeType: shoe.charAt(0).toUpperCase() + shoe.slice(1),
            careType: service === 'package' ? 'Auto' : care.charAt(0).toUpperCase() + care.slice(1),
            deviceId,
            amountPaid: amountInserted,
          }),
        })
        const saveData = await res.json()
        if (saveData.success) {
          debug.log(`[Offline] Transaction saved — id: ${saveData.transaction?.id}`)
        } else {
          console.error(`[Offline] Transaction save failed (proceeding): ${saveData.error}`)
        }
      } catch (err) {
        // Always log at console.error so operators see it even in production
        console.error('[Offline] Transaction save error — no record created, proceeding anyway:', err)
      }
    } else {
      debug.warn(`[Offline] Skipping transaction save — missing deviceId or groupToken`)
    }

    setIsSaving(false)
    router.push(`/kiosk/success/payment?shoe=${shoe}&service=${service}&care=${care}`)
  }

  const handleBack = () => {
    if (amountInserted > 0) {
      setShowExitWarning(true)
    } else {
      router.back()
    }
  }

  return (
    <div className="px-8 py-4 relative">
      <Button
        onClick={handleBack}
        className="fixed top-8 left-8 z-50 gap-3 px-8 py-6 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 hover:from-blue-700 hover:via-cyan-700 hover:to-green-700 text-white rounded-full shadow-lg transition-all duration-200 transform hover:scale-105 active:scale-95"
      >
        <ArrowLeft className="w-7 h-7" />
        <span className="text-xl font-bold">Back</span>
      </Button>

      {/* Exit warning dialog */}
      {showExitWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <AlertTriangle className="w-10 h-10 text-red-600 flex-shrink-0" />
              <h2 className="text-2xl font-bold text-red-700">Payment in Progress</h2>
            </div>
            <p className="text-gray-700 text-base mb-2">
              You have already inserted <span className="font-bold text-green-600">₱{amountInserted.toFixed(2)}</span>.
            </p>
            <p className="text-gray-700 text-base mb-6">
              Leaving this page will <span className="font-bold text-red-600">not refund</span> any cash already inserted into the machine. Only leave if you have spoken with an operator.
            </p>
            <div className="flex gap-3">
              <Button
                onClick={() => setShowExitWarning(false)}
                className="flex-1 py-6 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-full font-bold text-base border border-gray-300"
                variant="ghost"
              >
                Stay
              </Button>
              <Button
                onClick={() => router.back()}
                className="flex-1 py-6 bg-red-600 hover:bg-red-700 text-white rounded-full font-bold text-base"
              >
                Leave Anyway
              </Button>
            </div>
          </div>
        </div>
      )}

      <h1 className="text-4xl font-bold text-center mb-6 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 bg-clip-text text-transparent">
        Cash Payment
      </h1>

      {/* Caution Message */}
      <div className="max-w-5xl mx-auto mb-4 space-y-2">
        <div className="bg-yellow-100 border-2 border-yellow-400 rounded-lg p-3 flex items-center gap-3">
          <AlertTriangle className="w-10 h-10 text-yellow-700 flex-shrink-0" />
          <div>
            <p className="text-base font-bold text-yellow-800">CAUTION: Insert Exact Amount Only</p>
            <p className="text-sm text-yellow-700">This machine does not provide change. Please insert the exact amount.</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-2">
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          <p className="text-xs text-gray-600">
            {isConnected ? 'Payment system ready' : 'Connecting...'}
          </p>
        </div>
      </div>

      <div className='grid grid-cols-2 gap-6 max-w-5xl mx-auto'>
        {/* Left Side - Payment Information */}
        <Item className='bg-white/50 p-6 rounded-lg shadow-lg flex flex-col w-100'>
          <ItemContent className="flex flex-col h-full w-full">
            <h2 className="text-2xl font-bold mb-4 text-center">Payment Details</h2>
            
            <div className="space-y-3 flex-1">
              <div className="bg-purple-50 p-3 rounded-lg border-2 border-purple-200">
                <p className="text-sm font-bold text-gray-700">Service</p>
                <p className="text-xl font-bold text-purple-600">{service.charAt(0).toUpperCase() + service.slice(1)}</p>
              </div>
              
              <div className="bg-blue-50 p-3 rounded-lg">
                <p className="text-sm font-bold text-gray-700">Amount Due</p>
                <p className="text-2xl font-bold text-blue-600">₱{amountDue.toFixed(2)}</p>
              </div>
              
              <div className="bg-green-50 p-3 rounded-lg">
                <p className="text-sm font-bold text-gray-700">Amount Inserted</p>
                <p className="text-2xl font-bold text-green-600">₱{amountInserted.toFixed(2)}</p>
              </div>
              
              <div className="bg-red-50 p-3 rounded-lg">
                <p className="text-sm font-bold text-gray-700">Amount Remaining</p>
                <p className="text-2xl font-bold text-red-600">₱{amountRemaining.toFixed(2)}</p>
              </div>
            </div>
            <Button
              onClick={handleProceed}
              disabled={!isPaymentComplete || isSaving}
              className="w-full mt-4 px-4 py-6 bg-gradient-to-r from-blue-600 via-cyan-600 to-green-600 hover:from-blue-700 hover:via-cyan-700 hover:to-green-700 text-white rounded-full shadow-md transition-all duration-200 transform hover:scale-105 active:scale-95 active:shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  <p className='text-base font-bold'>Processing...</p>
                </>
              ) : (
                <p className='text-base font-bold'>
                  {isPaymentComplete ? 'Proceed' : 'Insert Full Amount'}
                </p>
              )}
            </Button>
          </ItemContent>
        </Item>

        {/* Right Side - Bill Acceptor and Coin Slot */}
        <div className="flex flex-col gap-4 h-full">
          <Card className='py-3 shadow-md bg-gray-600 text-white flex-1 flex flex-col'>
            <p className='px-3 text-left font-bold text-base mb-2'>
              Bill Acceptor
            </p>
            <CardContent className="flex-1 flex items-center">
              <Card className='w-full py-8 bg-black/50 border-2 border-dashed border-gray-400'>
              </Card>
            </CardContent>
            <p className='text-right px-3 text-xs'>
              Accepts: ₱20, ₱50, ₱100
            </p>
          </Card>

          <Card className='py-3 shadow-md bg-gray-600 text-white flex-1 flex flex-col'>
            <p className='px-3 text-left font-bold text-base mb-2'>
              Coin Slot
            </p>
            <CardContent className="flex-1 flex justify-center items-center">
              <Card className='py-2 w-6 h-24 bg-black/50 border-2 border-dashed border-gray-400'>
              </Card>
            </CardContent>
            <p className='text-right px-3 text-xs'>
              Accepts: ₱1, ₱5, ₱10, ₱20
            </p>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default Offline