'use client'

import { useMemo, useState } from 'react'
import { CreditCard, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useClientPaymentConfig } from '@/hooks/useClientPaymentConfig'

export function PaymentProviderCard() {
  const { config, isSaving, isToggling, isResetting, error, saveManual, setEnabled, resetCredentials } = useClientPaymentConfig()
  const [secretKey, setSecretKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isCopyingWebhookUrl, setIsCopyingWebhookUrl] = useState(false)

  const statusText = useMemo(() => {
    if (!config) return 'Not connected'
    if (config.status === 'connected') return 'Connected'
    if (config.status === 'disabled') return 'Disabled'
    return 'Pending'
  }, [config])

  const isConnected = config?.status === 'connected'

  const onManualSave = async () => {
    setSubmitError(null)
    if (!secretKey || !webhookSecret) {
      setSubmitError('Secret key and webhook secret are required.')
      return
    }

    const result = await saveManual({
      secretKey,
      webhookSecret,
    })

    if (!result.ok) {
      setSubmitError(result.error)
      return
    }

    setSecretKey('')
    setWebhookSecret('')
  }

  const onToggle = async () => {
    setSubmitError(null)
    const result = await setEnabled(!isConnected)
    if (!result.ok) {
      setSubmitError(result.error)
    }
  }

  const onReset = async () => {
    setSubmitError(null)
    const confirmed = window.confirm('Reset payment credentials? This will disable online payments until credentials are saved again.')
    if (!confirmed) return
    const result = await resetCredentials()
    if (!result.ok) {
      setSubmitError(result.error)
      return
    }
    setSecretKey('')
    setWebhookSecret('')
  }

  const handleCopyWebhookPath = async () => {
    setIsCopyingWebhookUrl(true)
    try {
      await navigator.clipboard.writeText('smart-shoe-care-machine.onrender.com/api/payment/webhook')
    } finally {
      setTimeout(() => setIsCopyingWebhookUrl(false), 1000)
    }
  }

  return (
    <Card className="glass-card border-none">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Payments Integration</CardTitle>
        </div>
        <CardDescription>
          Configure PayMongo credentials manually per client to accept payments.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Status Indicator */}
        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Connection Status</span>
            <span className="text-sm text-muted-foreground">{statusText}</span>
          </div>
          {config && (
            <div className="text-right text-xs text-muted-foreground">
              {config.lastValidatedAt && <p>Validated: {new Date(config.lastValidatedAt).toLocaleDateString()}</p>}
              {config.lastWebhookAt && <p>Webhook: {new Date(config.lastWebhookAt).toLocaleDateString()}</p>}
            </div>
          )}
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Main Form Area */}
          <div className="space-y-5">
            <div className="space-y-4 rounded-lg border border-border/60 p-4">
              <div className="space-y-2">
                <Label htmlFor="paymongo-secret-key">Secret Key</Label>
                <Input
                  id="paymongo-secret-key"
                  type="password"
                  placeholder="sk_live_..."
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  autoComplete="off"
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="paymongo-webhook-secret">Webhook Secret</Label>
                <Input
                  id="paymongo-webhook-secret"
                  type="password"
                  placeholder="whsec_..."
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  autoComplete="off"
                  className="font-mono text-sm"
                />
              </div>
            </div>

            {(error || submitError) && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error || submitError}
              </div>
            )}

            <Button type="button" onClick={() => void onManualSave()} disabled={isSaving} className="w-full">
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Credentials
            </Button>

            <div className="flex flex-col gap-4 pt-6 border-t border-border/50">
              <h4 className="text-sm font-medium">Payment Controls</h4>
              
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-border/50 p-4 bg-muted/20">
                <div className="space-y-1">
                  <Label className="text-sm font-semibold">Enable Online Payment</Label>
                  <p className="text-xs text-muted-foreground w-11/12">
                    Allow customers to process online transactions via the kiosk.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {isToggling && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <Switch
                    checked={isConnected}
                    onCheckedChange={() => void onToggle()}
                    disabled={isToggling || isSaving || isResetting || !config?.hasManualSecretKey || !config?.hasManualWebhookSecret}
                  />
                </div>
              </div>

              <div className="flex justify-start">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive text-sm px-2 h-8"
                  onClick={() => void onReset()}
                  disabled={isResetting || isSaving || isToggling || !config}
                >
                  {isResetting && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                  Clear sensitive credentials
                </Button>
              </div>
            </div>
          </div>

          {/* Instructions Sidebar */}
          <div className="rounded-xl border border-border/50 bg-card p-5 shadow-sm text-sm self-start h-full">
            <h4 className="mb-4 font-semibold text-foreground">Quick setup guide</h4>
            <div className="space-y-4 text-muted-foreground">
              <div className="space-y-1">
                <strong className="text-foreground">1. Copy your Live Secret Key</strong>
                <p>In PayMongo, go to <em>Developers &gt; API Keys</em>, copy <code>sk_live_...</code>, then paste it into the <em>Secret Key</em> field.</p>
              </div>
              <div className="space-y-1">
                <strong className="text-foreground">2. Create a webhook</strong>
                <p>In <em>Developers &gt; Webhooks</em>, add this endpoint:</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="flex-1 rounded-md border border-border/50 bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground break-all select-all">
                    smart-shoe-care-machine.onrender.com/api/payment/webhook
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => void handleCopyWebhookPath()}
                  >
                    {isCopyingWebhookUrl ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <strong className="text-foreground">3. Select webhook events</strong>
                <p>Enable <code>payment.paid</code>. You can also enable <code>payment.failed</code>.</p>
              </div>
              <div className="space-y-1">
                <strong className="text-foreground">4. Copy your Webhook Secret</strong>
                <p>Open webhook details, copy <code>whsec_...</code>, then paste it into Webhook Secret.</p>
              </div>
              <div className="space-y-1">
                <strong className="text-foreground">5. Save and enable</strong>
                <p>Click <em>Save Credentials</em>, then turn on <em>Enable Online Payment</em>.</p>
              </div>
            </div>
            
            <div className="mt-6 rounded-md border border-primary/20 bg-primary/10 p-3 text-xs text-primary">
              <strong>Tip:</strong> For client deployment, always paste <code>sk_live_...</code> (not <code>sk_test_...</code>).
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
