'use client'

import { useCallback, useEffect, useState } from 'react'

type PaymentConfig = {
  provider: 'paymongo'
  mode: 'test' | 'live'
  onboardingType: 'manual'
  status: 'pending' | 'connected' | 'disabled'
  providerAccountId: string | null
  hasManualSecretKey: boolean
  hasManualWebhookSecret: boolean
  lastValidatedAt: string | null
  lastWebhookAt: string | null
}

export function useClientPaymentConfig() {
  const [config, setConfig] = useState<PaymentConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isToggling, setIsToggling] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadConfig = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/client/payment-config')
      const data = await response.json()
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? 'Failed to load payment config')
      }
      setConfig(data.config)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payment config')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const saveManual = useCallback(async (payload: {
    mode: 'test' | 'live'
    secretKey: string
    webhookSecret: string
  }) => {
    setIsSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/client/payment-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? 'Failed to save payment config')
      }
      await loadConfig()
      return { ok: true as const }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save payment config'
      setError(message)
      return { ok: false as const, error: message }
    } finally {
      setIsSaving(false)
    }
  }, [loadConfig])

  const setEnabled = useCallback(async (enabled: boolean) => {
    setIsToggling(true)
    setError(null)
    try {
      const response = await fetch('/api/client/payment-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? 'Failed to update payment status')
      }
      await loadConfig()
      return { ok: true as const }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update payment status'
      setError(message)
      return { ok: false as const, error: message }
    } finally {
      setIsToggling(false)
    }
  }, [loadConfig])

  const resetCredentials = useCallback(async () => {
    setIsResetting(true)
    setError(null)
    try {
      const response = await fetch('/api/client/payment-config', { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? 'Failed to reset payment credentials')
      }
      await loadConfig()
      return { ok: true as const }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reset payment credentials'
      setError(message)
      return { ok: false as const, error: message }
    } finally {
      setIsResetting(false)
    }
  }, [loadConfig])

  return {
    config,
    isLoading,
    isSaving,
    isToggling,
    isResetting,
    error,
    saveManual,
    setEnabled,
    resetCredentials,
    refresh: loadConfig,
  }
}
