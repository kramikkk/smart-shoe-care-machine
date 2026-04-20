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
  const [mode, setMode] = useState<'test' | 'live'>('live')
  const [secretKey, setSecretKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)

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
      mode,
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
            <div className="space-y-3">
              <Label>Environment Mode</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant={mode === 'live' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setMode('live')}
                  className="w-24"
                >
                  Live
                </Button>
                <Button
                  type="button"
                  variant={mode === 'test' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setMode('test')}
                  className="w-24"
                >
                  Test
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Select the correct mode for the API keys you are providing.
              </p>
            </div>

            <div className="space-y-4 rounded-lg border border-border/60 p-4">
              <div className="space-y-2">
                <Label htmlFor="paymongo-secret-key">Secret Key</Label>
                <Input
                  id="paymongo-secret-key"
                  type="password"
                  placeholder={mode === 'live' ? 'sk_live_...' : 'sk_test_...'}
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
            <h4 className="mb-4 font-semibold text-foreground">Detailed setup flow</h4>
            <div className="space-y-4 text-muted-foreground">
              <div className="space-y-1">
                <strong className="text-foreground">1. Choose mode first</strong>
                <p>Select <em>Live</em> or <em>Test</em> on the left. The keys you copy must match this mode.</p>
              </div>
              <div className="space-y-1">
                <strong className="text-foreground">2. Copy Secret Key</strong>
                <p>In PayMongo, go to <em>Developers &gt; API Keys</em> and copy the correct Secret Key (<code>sk_test_...</code> or <code>sk_live_...</code>).</p>
              </div>
              <div className="space-y-1">
                <strong className="text-foreground">3. Create webhook endpoint</strong>
                <p>In <em>Developers &gt; Webhooks</em>, add:</p>
                <div className="mt-1.5 rounded-md border border-border/50 bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground break-all select-all">
                  https://smart-shoe-care-machine.onrender.com/api/payment/webhook
                </div>
              </div>
              <div className="space-y-1">
                <strong className="text-foreground">4. Select events</strong>
                <p>Enable at least <code>payment.paid</code>. Recommended: also add <code>payment.failed</code>.</p>
              </div>
              <div className="space-y-1">
                <strong className="text-foreground">5. Copy Webhook Secret</strong>
                <p>Open webhook details and copy the signing secret (<code>whsec_...</code>), then paste it on the left.</p>
              </div>
              <div className="space-y-1">
                <strong className="text-foreground">6. Save and verify</strong>
                <p>Click <em>Save Credentials</em>, then run one test payment to confirm kiosk detects success.</p>
              </div>
            </div>
            
            <div className="mt-6 rounded-md border border-primary/20 bg-primary/10 p-3 text-xs text-primary">
              <strong>Tip:</strong> Ensure you are using <code>sk_test_...</code> keys for Test mode and <code>sk_live_...</code> keys for Live mode.
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
