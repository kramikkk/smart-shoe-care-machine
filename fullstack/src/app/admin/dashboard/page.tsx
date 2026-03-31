'use client'

import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Users, Server, Wifi, DollarSign, Plus, Loader2, RefreshCw, Trash2, CheckCircle2, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'

interface Stats {
  clients: number
  devices: number
  devicesOnline: number
  totalRevenue: number
}

interface Client {
  id: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: string
  deviceCount: number
}

const containerVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, staggerChildren: 0.08 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0 },
}

function StatCard({
  label,
  value,
  icon: Icon,
  loading,
  prefix = '',
  accent = false,
}: {
  label: string
  value: number
  icon: React.ElementType
  loading: boolean
  prefix?: string
  accent?: boolean
}) {
  return (
    <Card className="glass-card border-none">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-xs font-semibold tracking-widest uppercase text-muted-foreground">
          {label}
        </CardTitle>
        <div className={`w-8 h-8 rounded-md flex items-center justify-center ${accent ? 'bg-primary/20' : 'bg-white/5'}`}>
          <Icon className={`w-4 h-4 ${accent ? 'text-primary' : 'text-muted-foreground'}`} />
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        ) : (
          <p className="text-3xl font-black tracking-tight">
            {prefix}{typeof value === 'number' ? value.toLocaleString('en-PH', {
              minimumFractionDigits: prefix === '₱' ? 2 : 0,
              maximumFractionDigits: prefix === '₱' ? 2 : 0,
            }) : value}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [clients, setClients] = useState<Client[]>([])
  const [statsLoading, setStatsLoading] = useState(true)
  const [clientsLoading, setClientsLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteClient, setConfirmDeleteClient] = useState<Client | null>(null)
  const [form, setForm] = useState({ name: '', email: '', password: '' })

  const fetchStats = async () => {
    setStatsLoading(true)
    try {
      const res = await fetch('/api/admin/stats')
      if (!res.ok) throw new Error('Failed to fetch stats')
      setStats(await res.json())
    } catch {
      toast.error('Failed to load stats')
    } finally {
      setStatsLoading(false)
    }
  }

  const fetchClients = async () => {
    setClientsLoading(true)
    try {
      const res = await fetch('/api/admin/clients')
      if (!res.ok) throw new Error('Failed to fetch clients')
      setClients(await res.json())
    } catch {
      toast.error('Failed to load clients')
    } finally {
      setClientsLoading(false)
    }
  }

  useEffect(() => {
    fetchStats()
    fetchClients()
  }, [])

  const handleDeleteClient = async () => {
    if (!confirmDeleteClient) return
    setDeletingId(confirmDeleteClient.id)
    setConfirmDeleteClient(null)
    try {
      const res = await fetch(`/api/admin/clients/${confirmDeleteClient.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to delete client')
      }
      toast.success('Client deleted')
      fetchClients()
      fetchStats()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete client')
    } finally {
      setDeletingId(null)
    }
  }

  const handleCreateClient = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name || !form.email || !form.password) return
    setCreating(true)
    try {
      const res = await fetch('/api/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create client')
      }
      toast.success(`Client account created for ${form.email}`)
      setForm({ name: '', email: '', password: '' })
      fetchClients()
      fetchStats()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create client')
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Dialog open={!!confirmDeleteClient} onOpenChange={(open) => { if (!open) setConfirmDeleteClient(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Client Account</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <span className="font-semibold text-foreground">{confirmDeleteClient?.name}</span>? This will unpair all their devices and permanently remove the account. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteClient(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteClient}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    <motion.div
      initial="hidden"
      animate="visible"
      variants={containerVariants}
      className="flex flex-col gap-8 py-8"
    >
      {/* Header */}
      <motion.div variants={itemVariants} className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Admin <span className="text-primary">Dashboard</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Manage clients and monitor platform activity.</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { fetchStats(); fetchClients() }}
          className="gap-2 text-muted-foreground"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </Button>
      </motion.div>

      {/* Stat Cards */}
      <motion.div variants={itemVariants} className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard label="Total Clients" value={stats?.clients ?? 0} icon={Users} loading={statsLoading} accent />
        <StatCard label="Total Devices" value={stats?.devices ?? 0} icon={Server} loading={statsLoading} accent />
        <StatCard label="Devices Online" value={stats?.devicesOnline ?? 0} icon={Wifi} loading={statsLoading} accent />
        <StatCard label="Total Revenue" value={stats?.totalRevenue ?? 0} icon={DollarSign} loading={statsLoading} prefix="₱" accent />
      </motion.div>

      {/* Main content */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Client list */}
        <div className="xl:col-span-2">
          <Card className="glass-card border-none h-full">
            <CardHeader>
              <CardTitle className="text-sm font-semibold tracking-widest uppercase text-muted-foreground">
                Client Accounts
              </CardTitle>
            </CardHeader>
            <CardContent>
              {clientsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : clients.length === 0 ? (
                <p className="text-center text-muted-foreground text-sm py-12">
                  No client accounts yet. Create one on the right.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/5">
                        <th className="text-left pb-3 pr-4 text-xs tracking-widest uppercase text-muted-foreground font-semibold">Name</th>
                        <th className="text-left pb-3 pr-4 text-xs tracking-widest uppercase text-muted-foreground font-semibold">Email</th>
                        <th className="text-center pb-3 pr-4 text-xs tracking-widest uppercase text-muted-foreground font-semibold">Verified</th>
                        <th className="text-center pb-3 pr-4 text-xs tracking-widest uppercase text-muted-foreground font-semibold">Devices</th>
                        <th className="text-left pb-3 pr-4 text-xs tracking-widest uppercase text-muted-foreground font-semibold">Joined</th>
                        <th className="pb-3 text-xs tracking-widest uppercase text-muted-foreground font-semibold" />
                      </tr>
                    </thead>
                    <tbody>
                      {clients.map((client) => (
                        <tr key={client.id} className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                          <td className="py-3 pr-4 font-medium">{client.name}</td>
                          <td className="py-3 pr-4 text-muted-foreground">{client.email}</td>
                          <td className="py-3 pr-4 text-center">
                            {client.emailVerified ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-semibold border border-emerald-500/20">
                                <CheckCircle2 className="w-3 h-3" />
                                Verified
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-xs font-semibold border border-amber-500/20">
                                <Clock className="w-3 h-3" />
                                Pending
                              </span>
                            )}
                          </td>
                          <td className="py-3 pr-4 text-center">
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold">
                              {client.deviceCount}
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-muted-foreground">
                            {new Date(client.createdAt).toLocaleDateString('en-PH', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            })}
                          </td>
                          <td className="py-3 text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              disabled={deletingId === client.id}
                              onClick={() => setConfirmDeleteClient(client)}
                            >
                              {deletingId === client.id
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <Trash2 className="w-3.5 h-3.5" />}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Create client form */}
        <div className="xl:col-span-1">
          <Card className="glass-card border-none h-full">
            <CardHeader>
              <CardTitle className="text-sm font-semibold tracking-widest uppercase text-muted-foreground">
                Create Client
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreateClient} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] tracking-widest uppercase text-muted-foreground font-semibold">
                    Full Name
                  </label>
                  <Input
                    placeholder="Enter full name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="bg-transparent border-white/10 h-10 rounded-sm"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] tracking-widest uppercase text-muted-foreground font-semibold">
                    Email Address
                  </label>
                  <Input
                    type="email"
                    placeholder="Enter email address"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="bg-transparent border-white/10 h-10 rounded-sm"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] tracking-widest uppercase text-muted-foreground font-semibold">
                    Password
                  </label>
                  <Input
                    type="password"
                    placeholder="Enter password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="bg-transparent border-white/10 h-10 rounded-sm"
                    required
                  />
                </div>
                <Button
                  type="submit"
                  disabled={creating}
                  className="w-full h-10 rounded-sm font-black uppercase tracking-widest mt-2"
                >
                  {creating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4 mr-2" />
                      Create Account
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </motion.div>
    </motion.div>
    </>
  )
}
