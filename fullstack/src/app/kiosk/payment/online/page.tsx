'use client'

import { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Loader2, XCircle, ArrowLeft } from 'lucide-react'
import { DEFAULT_SERVICES, ServiceType } from '@/lib/kiosk-constants'
import { usePricing } from '@/hooks/usePricing'
import { useKioskWebSocket } from '@/contexts/KioskWebSocketContext'
import { debug, isDebug } from '@/lib/debug'

const OnlinePayment = () => {
  const searchParams = useSearchParams()
  const router = useRouter()
  const selectedShoe = searchParams.get('shoe') || 'mesh'
  const selectedService = searchParams.get('service') as ServiceType || 'cleaning'
  const selectedCare = searchParams.get('care') || 'normal'

  // Ref to prevent multiple payment creations
  const isCreatingPayment = useRef(false)
  const hasInitializedRef = useRef(false)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const hasRedirectedRef = useRef(false)

  const serviceDescriptions: Record<ServiceType, string> = {
    cleaning: 'Professional shoe cleaning',
    drying: 'Quick and effective drying',
    sterilizing: 'UV sterilization treatment',
    package: 'Complete care: cleaning, drying, and sterilizing',
  }

  const { services, isLoaded: isPricingLoaded } = usePricing()
  const { onMessage } = useKioskWebSocket()

  // Get selected service data
  const selectedServiceData = useMemo(() => {
    return services.find(s => s.id === selectedService) || services[0]
  }, [selectedService, services])

  // PayMongo API States
  const [paymentState, setPaymentState] = useState<'idle' | 'creating' | 'awaiting_payment' | 'checking' | 'success' | 'failed'>('idle')
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null)
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const redirectToSuccess = useCallback(() => {
    if (hasRedirectedRef.current) return
    hasRedirectedRef.current = true
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    debug.log('[Payment] Redirecting to success page')
    router.push(`/kiosk/success/payment?shoe=${selectedShoe}&service=${selectedService}&care=${selectedCare}`)
  }, [router, selectedShoe, selectedService, selectedCare])

  // Listen for payment-success WebSocket event (webhook-driven)
  useEffect(() => {
    const unsubscribe = onMessage((message) => {
      if (message.type === 'payment-success') {
        debug.log('[Payment] WebSocket payment-success received:', message)
        redirectToSuccess()
      }
    })
    return unsubscribe
  }, [onMessage, redirectToSuccess])

  const checkPaymentStatus = useCallback(async (intentId: string) => {
    try {
      const groupToken = localStorage.getItem('kiosk_group_token') || ''
      const deviceId = localStorage.getItem('kiosk_device_id') || ''
      const response = await fetch(
        `/api/payment/status?paymentIntentId=${intentId}&deviceId=${encodeURIComponent(deviceId)}`,
        { headers: { 'X-Group-Token': groupToken } }
      )
      const data = await response.json()

      debug.log(`[Payment] Poll status: ${data.status}`)

      if (data.success) {
        if (data.status === 'succeeded') {
          debug.log('[Payment] Poll detected succeeded — redirecting')
          redirectToSuccess()
          return true
        } else if (data.status === 'failed') {
          debug.warn('[Payment] Poll detected failed')
          setPaymentState('failed')
          setError('Payment failed. Please try again.')
          return true
        }
      }
      return false
    } catch (err) {
      debug.error('[Payment] Poll error:', err)
      return false
    }
  }, [redirectToSuccess])

  const startPolling = useCallback((intentId: string) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)

    const pollInterval = setInterval(async () => {
      const isComplete = await checkPaymentStatus(intentId)
      if (isComplete) {
        clearInterval(pollInterval)
        pollIntervalRef.current = null
      }
    }, 3000)

    pollIntervalRef.current = pollInterval

    // Cleanup after 30 minutes (QR expiry time)
    const timeout = setTimeout(() => {
      clearInterval(pollInterval)
      pollIntervalRef.current = null
      setPaymentState('failed')
      setError('QR code expired. Please try again.')
    }, 1800000)

    timeoutRef.current = timeout
  }, [checkPaymentStatus])

  const handlePayment = useCallback(async () => {
    if (isCreatingPayment.current) return

    try {
      isCreatingPayment.current = true
      setPaymentState('creating')
      setError(null)

      if (selectedServiceData.price < 1) {
        throw new Error('Payment amount must be at least ₱1.00 for online payments. Please use offline payment for amounts less than ₱1.')
      }

      const deviceId = localStorage.getItem('kiosk_device_id')
      const groupToken = localStorage.getItem('kiosk_group_token') || ''
      debug.log(`[Payment] Creating payment — device: ${deviceId}, service: ${selectedService}, shoe: ${selectedShoe}, care: ${selectedCare}, amount: ₱${selectedServiceData.price}`)

      const response = await fetch('/api/payment/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Group-Token': groupToken },
        body: JSON.stringify({
          amount: selectedServiceData.price,
          description: `Smart Shoe Care - ${selectedServiceData.name}`,
          deviceId,
          shoeType: selectedShoe.charAt(0).toUpperCase() + selectedShoe.slice(1),
          careType: selectedService === 'package'
            ? 'Auto'
            : selectedCare.charAt(0).toUpperCase() + selectedCare.slice(1),
          serviceType: selectedService.charAt(0).toUpperCase() + selectedService.slice(1),
        }),
      })

      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || 'Failed to create payment')
      }

      debug.log(`[Payment] QR created — intentId: ${data.paymentIntentId}`)
      setPaymentIntentId(data.paymentIntentId)
      setQrImageUrl(data.qrImageUrl)
      setPaymentState('awaiting_payment')

      startPolling(data.paymentIntentId)
    } catch (err: any) {
      debug.error('[Payment] Creation failed:', err.message)
      setError(err.message)
      setPaymentState('failed')
      isCreatingPayment.current = false
    }
  }, [selectedServiceData, selectedShoe, selectedService, selectedCare, startPolling])

  // Auto-generate QR on page load - exactly once, after pricing is loaded
  useEffect(() => {
    if (hasInitializedRef.current) return
    if (selectedService && paymentState === 'idle' && isPricingLoaded) {
      hasInitializedRef.current = true
      handlePayment()
    }
  }, [selectedService, paymentState, handlePayment, isPricingLoaded])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      isCreatingPayment.current = false
      hasInitializedRef.current = false
    }
  }, [])

  const handleCancel = async () => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    pollIntervalRef.current = null
    timeoutRef.current = null
    isCreatingPayment.current = false

    if (paymentIntentId) {
      try {
        const groupToken = localStorage.getItem('kiosk_group_token') || ''
        const deviceId = localStorage.getItem('kiosk_device_id') || ''
        await fetch('/api/payment/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Group-Token': groupToken },
          body: JSON.stringify({ paymentIntentId, deviceId })
        })
      } catch {
        // Still navigate back even if cancellation fails
      }
    }

    router.back()
  }

  // Loading state - rendered without Card wrapper
  if (paymentState === 'idle' || paymentState === 'creating') {
    return (
      <div className="container mx-auto px-4 h-screen flex flex-col justify-center items-center">
        <div className="bg-white/50 backdrop-blur-sm rounded-2xl border border-white/30 shadow-lg p-8">
          <div className="flex flex-col items-center space-y-4">
            <div className="bg-white rounded-full p-6 shadow-xl">
              <Loader2 className="w-16 h-16 animate-spin text-blue-600" />
            </div>
            <div className="space-y-2 text-center">
              <h3 className="text-2xl font-bold text-gray-800">Generating QR Code</h3>
              <p className="text-base text-gray-600">Please wait while we prepare your payment...</p>
            </div>
            <div className="bg-gradient-to-r from-blue-50 to-cyan-50 px-6 py-3 rounded-full border border-blue-200">
              <p className="text-base font-semibold text-blue-800">
                {selectedServiceData.name} - ₱{selectedServiceData.price}
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto px-4 h-screen flex flex-col justify-center max-w-4xl">
      <Card className="bg-white/80 backdrop-blur-md shadow-2xl border border-white/50 gap-0">
        <CardHeader className="border-white/30 pb-0">
          <CardTitle className="text-2xl font-bold flex items-center justify-center text-gray-800">
            {paymentState === 'failed' ? (
              <>
                <XCircle className="w-6 h-6 text-red-500" />
                Payment Failed
              </>
            ) : (
              'Scan QR Code to Pay'
            )}
          </CardTitle>
        </CardHeader>

        <CardContent className="px-4 py-4">
          {paymentState === 'awaiting_payment' && qrImageUrl && (
            <div className="grid grid-cols-2 gap-4">
              {/* Left Side - Service Details & Instructions */}
              <div className="space-y-4 flex flex-col flex-1">
                {/* Service Details */}
                <div className="bg-white/70 backdrop-blur-sm p-4 rounded-xl border border-white/40 shadow-sm">
                  <div className="space-y-2">
                    <div>
                      <h3 className="font-bold text-xl text-gray-800">{selectedServiceData.name}</h3>
                      <p className="text-md text-gray-600">{serviceDescriptions[selectedServiceData.id] ?? ''}</p>
                    </div>
                    <div className="pt-2 border-t border-gray-200">
                      <p className="text-4xl font-bold text-blue-600">₱{selectedServiceData.price}</p>
                      <p className="text-md text-gray-600 mt-1">Total Amount</p>
                    </div>
                  </div>
                </div>

                {/* Instructions */}
                <div className="bg-white/70 backdrop-blur-sm p-4 rounded-xl border border-white/40 shadow-sm flex-grow">
                  <h4 className="font-semibold text-md text-gray-800 mb-2">Payment Instructions</h4>
                  <div className="space-y-2 text-md text-gray-600">
                    <div className="flex items-start gap-2">
                      <span className="font-bold text-blue-600">1.</span>
                      <p>Open your GCash, PayMaya, or any QRPH supported app</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-bold text-blue-600">2.</span>
                      <p>Scan the QR code on the right side</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-bold text-blue-600">3.</span>
                      <p>Confirm the payment amount</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-bold text-blue-600">4.</span>
                      <p>Complete the transaction</p>
                    </div>
                  </div>
                </div>

                {/* Cancel Button */}
                <Button
                  onClick={handleCancel}
                  variant="default"
                  className="w-full py-4 hover:bg-red-400 text-white-800 bg-red-500 backdrop-blur-sm border shadow-md flex items-center justify-center"
                >
                  <ArrowLeft className="w-5 h-5 mr-2 text-white-800" />
                  <p className="text-base font-bold">Cancel Payment</p>
                </Button>
              </div>

              {/* Right Side - QR Code */}
              <div className="space-y-4 flex flex-col flex-1">
                <div className="border border-white/40 rounded-xl p-6 bg-white/70 backdrop-blur-sm shadow-md flex flex-col justify-center items-center flex-grow overflow-hidden">
                  <img
                    src={qrImageUrl}
                    alt="QRPH Payment QR Code"
                    className="w-full h-auto object-contain"
                    style={{ maxWidth: '280px', maxHeight: '280px' }}
                  />
                  <p className="text-center text-xs text-gray-600 mt-3 font-medium">
                    Secure and verified by QRPH with PayMongo API
                  </p>
                </div>

                {/* Status */}
                <div className="bg-white/70 backdrop-blur-sm p-4 rounded-xl border border-white/40 shadow-sm">
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                    <p className="text-xs text-gray-600 font-medium">
                      Waiting for payment confirmation...
                    </p>
                  </div>
                  <p className="text-xs text-yellow-600 font-medium text-center">
                    ⏱️ QR code expires in 30 minutes
                  </p>
                </div>

                {/* Test Button — only visible when NEXT_PUBLIC_DEBUG=true */}
                {isDebug && (
                  <Button
                    onClick={async () => {
                      debug.log('[Payment] Test button pressed — saving test transaction to DB')
                      try {
                        const groupToken = localStorage.getItem('kiosk_group_token') || ''
                        const deviceId = localStorage.getItem('kiosk_device_id') || ''
                        const res = await fetch('/api/transaction/create', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'X-Group-Token': groupToken },
                          body: JSON.stringify({
                            paymentMethod: 'Online',
                            serviceType: selectedService.charAt(0).toUpperCase() + selectedService.slice(1),
                            shoeType: selectedShoe.charAt(0).toUpperCase() + selectedShoe.slice(1),
                            careType: selectedService === 'package'
                              ? 'Auto'
                              : selectedCare.charAt(0).toUpperCase() + selectedCare.slice(1),
                            deviceId,
                          }),
                        })
                        const data = await res.json()
                        debug.log('[Payment] Test transaction saved:', data)
                      } catch (err) {
                        debug.error('[Payment] Test transaction failed:', err)
                      }
                      redirectToSuccess()
                    }}
                    variant="outline"
                    className="w-full py-3 border-dashed border-yellow-500 !bg-yellow-400 !text-yellow-900 hover:!bg-yellow-300 text-xs font-semibold"
                  >
                    [TEST] Simulate Payment Success
                  </Button>
                )}
              </div>
            </div>
          )}

          {paymentState === 'checking' && (
            <div className="text-center py-6">
              <div className="bg-white/70 backdrop-blur-sm rounded-xl p-5 border border-white/40">
                <Loader2 className="w-10 h-10 animate-spin mx-auto text-blue-600 mb-3" />
                <p className="text-base font-medium text-gray-800">Verifying payment...</p>
              </div>
            </div>
          )}

          {paymentState === 'failed' && (
            <div className="text-center py-6 space-y-3">
              <div className="bg-white/70 backdrop-blur-sm rounded-xl p-5 border border-red-200/50">
                <XCircle className="w-12 h-12 mx-auto text-red-500 mb-3" />
                <p className="text-base font-medium text-red-600">{error || 'Payment failed'}</p>
              </div>
              <Button
                onClick={async () => {
                  if (paymentIntentId) {
                    try {
                      const groupToken = localStorage.getItem('kiosk_group_token') || ''
                      const deviceId = localStorage.getItem('kiosk_device_id') || ''
                      await fetch('/api/payment/cancel', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Group-Token': groupToken },
                        body: JSON.stringify({ paymentIntentId, deviceId })
                      })
                    } catch {
                      // ignore
                    }
                  }
                  setPaymentIntentId(null)
                  setQrImageUrl(null)
                  setPaymentState('idle')
                  setError(null)
                  isCreatingPayment.current = false
                  handlePayment()
                }}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Generate New QR Code
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default OnlinePayment
