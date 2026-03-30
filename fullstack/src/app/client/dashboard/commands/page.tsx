'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useDeviceFilter } from '@/contexts/DeviceFilterContext'
import { useSensorData } from '@/contexts/SensorDataContext'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { Terminal, Wifi, WifiOff, AlertTriangle, ArrowUp, ArrowDown, RotateCw, Zap, Power, Activity, DollarSign, Unlink, RotateCcw, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Square, RotateCcw as Home, MapPin, RefreshCw, Coins, Wind, Fan, Flame, Droplets, Waves, Sun, Sparkles, MoveHorizontal, Camera, RefreshCcw, Download, VideoOff } from 'lucide-react'
import { motion } from 'motion/react'

type LogEntry = {
  id: number
  timestamp: string
  type: string
  message: string
}

type MotorId = 'left' | 'right' | 'both'
const MOTOR_PREFIX: Record<MotorId, string> = { left: 'MOTOR_LEFT_', right: 'MOTOR_RIGHT_', both: 'MOTOR_' }

const RELAYS = [
  { ch: 1, name: 'Bill + Coin Acceptors', icon: 'coins',   color: 'yellow' },
  { ch: 2, name: 'Bottom Exhaust',         icon: 'wind',    color: 'blue'   },
  { ch: 3, name: 'Blower Fan',             icon: 'fan',     color: 'cyan'   },
  { ch: 4, name: 'Left Ceramic Heater',    icon: 'flame',   color: 'orange' },
  { ch: 5, name: 'Diaphragm Pump',         icon: 'pump',    color: 'teal'   },
  { ch: 6, name: 'Right Ceramic Heater',   icon: 'flame',   color: 'orange' },
  { ch: 7, name: 'Mist Maker + Fan',       icon: 'mist',    color: 'sky'    },
  { ch: 8, name: 'UVC Light',              icon: 'uvc',     color: 'violet' },
]

const RELAY_COLOR_MAP: Record<string, { icon: string; glow: string; ring: string; bg: string }> = {
  yellow: { icon: 'text-yellow-400',  glow: 'shadow-[0_0_12px_3px_rgba(250,204,21,0.4)]',  ring: 'ring-yellow-400/40',  bg: 'bg-yellow-400/10'  },
  blue:   { icon: 'text-blue-400',    glow: 'shadow-[0_0_12px_3px_rgba(96,165,250,0.4)]',  ring: 'ring-blue-400/40',    bg: 'bg-blue-400/10'    },
  cyan:   { icon: 'text-cyan-400',    glow: 'shadow-[0_0_12px_3px_rgba(34,211,238,0.4)]',  ring: 'ring-cyan-400/40',    bg: 'bg-cyan-400/10'    },
  orange: { icon: 'text-orange-400',  glow: 'shadow-[0_0_12px_3px_rgba(251,146,60,0.4)]',  ring: 'ring-orange-400/40',  bg: 'bg-orange-400/10'  },
  teal:   { icon: 'text-teal-400',    glow: 'shadow-[0_0_12px_3px_rgba(45,212,191,0.4)]',  ring: 'ring-teal-400/40',    bg: 'bg-teal-400/10'    },
  sky:    { icon: 'text-sky-400',     glow: 'shadow-[0_0_12px_3px_rgba(56,189,248,0.4)]',  ring: 'ring-sky-400/40',     bg: 'bg-sky-400/10'     },
  violet: { icon: 'text-violet-400',  glow: 'shadow-[0_0_12px_3px_rgba(167,139,250,0.4)]', ring: 'ring-violet-400/40',  bg: 'bg-violet-400/10'  },
}

export default function CommandsPage() {
  const { selectedDevice } = useDeviceFilter()

  const { isConnected, sendMessage, addMessageHandler } = useSensorData()
  const [isDeviceReady, setIsDeviceReady] = useState(false)

  // Log
  const [log, setLog] = useState<LogEntry[]>([])
  const logIdRef = useRef(0)

  const addLog = useCallback((type: string, message: string) => {
    setLog(prev => [{
      id: ++logIdRef.current,
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
    }, ...prev].slice(0, 200))
  }, [])

  // Camera tab state
  const [streamKey, setStreamKey] = useState(0)
  const [streamActive, setStreamActive] = useState(false)
  const [streamStatus, setStreamStatus] = useState<'loading' | 'live' | 'error'>('idle')

  // Relay state
  const [relayStates, setRelayStates] = useState<boolean[]>(Array(8).fill(false))

  // Servo
  const [servoAngle, setServoAngle] = useState(0)   // last sent / confirmed angle
  const [sliderAngle, setSliderAngle] = useState(0) // live slider position
  const [servoBusy, setServoBusy] = useState(false)

  // Stepper 1
  const [s1Pos, setS1Pos] = useState<number | null>(null)           // steps, from wsLog
  const [s1TargetMm, setS1TargetMm] = useState(0)                   // slider drag target
  const [s1SpeedLevel, setS1SpeedLevel] = useState<'slow'|'normal'|'fast'>('normal')

  // Stepper 2
  const [s2Pos, setS2Pos] = useState<number | null>(null)           // steps, from wsLog
  const [s2TargetMm, setS2TargetMm] = useState(0)                   // slider drag target
  const [s2SpeedLevel, setS2SpeedLevel] = useState<'slow'|'normal'|'fast'>('normal')

  // DC Motors
  const [motorSpeed, setMotorSpeed] = useState<Record<MotorId, 0 | 50 | 100>>({ left: 0, right: 0, both: 0 })
  const [motorDir, setMotorDir] = useState<Record<MotorId, 'fwd' | 'rev'>>({ left: 'fwd', right: 'fwd', both: 'fwd' })

  // RGB
  const [rgbR, setRgbR] = useState(255)
  const [rgbG, setRgbG] = useState(128)
  const [rgbB, setRgbB] = useState(0)
  const [activeColorCmd, setActiveColorCmd] = useState<string | null>(null)

  // Reset local state when device changes
  useEffect(() => {
    setS1Pos(null)
    setS2Pos(null)
    setMotorSpeed({ left: 0, right: 0, both: 0 })
    setMotorDir({ left: 'fwd', right: 'fwd', both: 'fwd' })
    setIsDeviceReady(false)
  }, [selectedDevice])

  // Log connection events and handle incoming WS messages
  useEffect(() => {
    if (isConnected) {
      addLog('system', 'Connected to device')
    } else {
      setIsDeviceReady(false)
    }
  }, [isConnected, addLog])

  // Subscribe to WS messages for commands-specific handling
  useEffect(() => {
    const cleanup = addMessageHandler((msg) => {
      if (msg.type === 'serial-command') return // filter echo-back
      if (['device-online', 'firmware-log', 'sensor-data', 'distance-data'].includes(msg.type as string)) {
        setIsDeviceReady(true)
      }
      if (msg.type === 'firmware-log') {
        const text = (msg.message as string) || ''
        const s1Steps = text.match(/\bS1\s+pos=(-?\d+)/)
        if (s1Steps) setS1Pos(parseInt(s1Steps[1]))
        const s2Steps = text.match(/\bS2\s+pos=(-?\d+)/)
        if (s2Steps) setS2Pos(parseInt(s2Steps[1]))
        addLog((msg.level as string) || 'info', text || JSON.stringify(msg))
      } else if (msg.type === 'service-status') {
        addLog('service', `Progress: ${msg.progress}% — ${msg.timeRemaining}s remaining`)
      } else if (msg.type === 'service-complete') {
        addLog('service', `Complete: ${msg.serviceType}`)
      } else if (msg.type === 'classification-result') {
        addLog('classify', `Result: ${msg.result} (${((msg.confidence as number) * 100).toFixed(1)}%)`)
      } else if (msg.type === 'classification-error') {
        addLog('error', `Classification error: ${msg.error}`)
      }
    })
    return cleanup
  }, [addMessageHandler, addLog])

  // ── Send helper ───────────────────────────────────────────────────────────

  const send = useCallback((command: string) => {
    if (!isConnected || !selectedDevice) {
      toast.error('Not connected to device')
      return
    }
    sendMessage({ type: 'serial-command', deviceId: selectedDevice, command })
    addLog('sent', `→ ${command}`)
  }, [isConnected, selectedDevice, sendMessage, addLog])

  // ── Servo helper ──────────────────────────────────────────────────────────
  const sendServo = useCallback((angle: number) => {
    setServoAngle(angle)
    setSliderAngle(angle)
    send(`SERVO_${angle}`)
  }, [send])

  // ── Motor helper ──────────────────────────────────────────────────────────
  const applyMotor = useCallback((id: MotorId, speed: 0 | 50 | 100, dir: 'fwd' | 'rev') => {
    setMotorSpeed(p => ({ ...p, [id]: speed }))
    setMotorDir(p => ({ ...p, [id]: dir }))
    const prefix = MOTOR_PREFIX[id]
    if (speed === 0) { send(`${prefix}BRAKE`); return }
    const pwm = speed === 100 ? 255 : 128
    send(`${prefix}${dir === 'fwd' ? pwm : -pwm}`)
  }, [send])

  // ── Shorthand: disabled when not connected, device not ready, OR servo demo is running ───────
  const disabled = !isConnected || !isDeviceReady || servoBusy

  // ── Badge color ───────────────────────────────────────────────────────────

  const badgeVariant = (type: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (type.toLowerCase()) {
      case 'error': return 'destructive'
      case 'warn': return 'outline'
      case 'sent': return 'secondary'
      default: return 'default'
    }
  }

  // ── Empty state ───────────────────────────────────────────────────────────

  if (!selectedDevice) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
        <Terminal className="w-12 h-12 opacity-30" />
        <p className="text-lg font-medium">Select a device to send commands</p>
      </div>
    )
  }

  // ── Page ──────────────────────────────────────────────────────────────────

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex flex-col gap-4 h-full pb-4"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Device <span className="text-primary">Commands</span>
          </h1>
          <p className="text-sm text-muted-foreground">Send firmware commands directly to the device.</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs sm:text-sm shrink-0 pt-1">
          {!isConnected
            ? <><WifiOff className="w-4 h-4 text-red-500 shrink-0" /><span className="text-red-500 hidden sm:inline">Disconnected</span></>
            : !isDeviceReady
            ? <><Wifi className="w-4 h-4 text-yellow-500 animate-pulse shrink-0" /><span className="text-yellow-500 hidden sm:inline">Waiting…</span></>
            : <><Wifi className="w-4 h-4 text-green-500 shrink-0" /><span className="text-green-500 hidden sm:inline">Device ready</span></>
          }
        </div>
      </div>

      {/* Servo demo banner — shown across ALL tabs while demo is running */}
      {servoBusy && (
        <div className="flex items-center gap-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 px-4 py-2 text-sm text-yellow-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          Servo demo running — all commands are disabled for ~6 seconds.
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="relays" className="flex flex-col gap-4 flex-1">
        <div className="overflow-x-auto pb-1 -mx-1 px-1">
          <TabsList className="w-max min-w-full justify-start gap-1 h-9">
            <TabsTrigger value="relays" className="text-xs sm:text-sm">Relays</TabsTrigger>
            <TabsTrigger value="servos" className="text-xs sm:text-sm">Servos</TabsTrigger>
            <TabsTrigger value="motors" className="text-xs sm:text-sm">DC Motors</TabsTrigger>
            <TabsTrigger value="steppers" className="text-xs sm:text-sm">Linear Actuators</TabsTrigger>
            <TabsTrigger value="rgb" className="text-xs sm:text-sm">RGB LED</TabsTrigger>
            <TabsTrigger value="system" className="text-xs sm:text-sm">System</TabsTrigger>
            <TabsTrigger value="cam" className="text-xs sm:text-sm">Camera</TabsTrigger>
          </TabsList>
        </div>

        {/* ── RELAYS ── */}
        <TabsContent value="relays" className="space-y-4">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground/60">Relay Channels</p>
              {relayStates.filter(Boolean).length > 0 && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/15 text-primary">
                  {relayStates.filter(Boolean).length} active
                </span>
              )}
            </div>
            <button
              type="button"
              disabled={disabled || !relayStates.some(Boolean)}
              onClick={() => { send('RELAY_ALL_OFF'); setRelayStates(Array(8).fill(false)) }}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Power className="w-3 h-3" />
              All Off
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {RELAYS.map((relay, idx) => {
              const isOn = relayStates[idx]
              const iconMap: Record<string, React.ReactNode> = {
                coins: <Coins className="w-5 h-5" />,
                wind:  <Wind className="w-5 h-5" />,
                fan:   <Fan className="w-5 h-5" />,
                flame: <Flame className="w-5 h-5" />,
                pump:  <Waves className="w-5 h-5" />,
                mist:  <Droplets className="w-5 h-5" />,
                uvc:   <Sparkles className="w-5 h-5" />,
              }
              const c = RELAY_COLOR_MAP[relay.color] ?? RELAY_COLOR_MAP.blue

              return (
                <button
                  type="button"
                  key={relay.ch}
                  disabled={disabled}
                  onClick={() => {
                    const newState = !isOn
                    setRelayStates(prev => { const n = [...prev]; n[idx] = newState; return n })
                    send(`RELAY_${idx + 1}_${newState ? 'ON' : 'OFF'}`)
                  }}
                  className={`group relative text-left rounded-2xl p-4 border transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed
                    ${isOn
                      ? `${c.bg} border-transparent ring-1 ${c.ring}`
                      : 'glass-card border-white/5 hover:border-white/10 hover:bg-white/[0.04]'
                    }`}
                >
                  {/* Icon */}
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 transition-all duration-300
                    ${isOn ? `${c.bg} ${c.icon} ${c.glow}` : 'bg-white/5 text-muted-foreground/40'}`}
                  >
                    {iconMap[relay.icon]}
                  </div>

                  {/* Name */}
                  <p className={`text-sm font-semibold leading-snug mb-1 transition-colors duration-300 ${isOn ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {relay.name}
                  </p>

                  {/* Footer */}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">Ch.{relay.ch}</span>
                    <span className={`text-[10px] font-black uppercase tracking-widest transition-colors duration-300 ${isOn ? c.icon : 'text-muted-foreground/30'}`}>
                      {isOn ? 'ON' : 'OFF'}
                    </span>
                  </div>

                  {/* Active dot */}
                  {isOn && (
                    <div className={`absolute top-3 right-3 w-2 h-2 rounded-full ${c.icon.replace('text-', 'bg-')} ${c.glow} animate-pulse`} />
                  )}
                </button>
              )
            })}
          </div>
        </TabsContent>

        {/* ── SERVOS ── */}
        <TabsContent value="servos" className="space-y-4">

          {/* Main servo card */}
          <Card className="glass-card border-none overflow-hidden">
            <CardContent className="p-0">
              <div className="flex flex-col lg:flex-row">

                {/* ── Gauge panel ── */}
                <div className="flex flex-col items-center justify-center gap-3 p-6 lg:p-8 lg:w-[45%] border-b lg:border-b-0 lg:border-r border-white/5">
                  {(() => {
                    const r = 90
                    const cx = 120
                    const cy = 115
                    const toXY = (deg: number) => {
                      const rad = Math.PI - (deg * Math.PI / 180)
                      return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) }
                    }
                    const fullArcPath = `M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`
                    const fullArc = Math.PI * r
                    const sliderDash = (sliderAngle / 180) * fullArc
                    const confirmedDash = (servoAngle / 180) * fullArc

                    // Needle geometry
                    const needle = toXY(servoAngle)
                    const ghost = toXY(sliderAngle)
                    const needlePoly = (pt: {x:number,y:number}, w: number) => {
                      const dx = pt.x - cx, dy = pt.y - cy
                      const len = Math.sqrt(dx*dx + dy*dy) || 1
                      const ux = dx/len, uy = dy/len
                      const px = -uy*w, py = ux*w
                      const tip = { x: cx + ux*(r-3), y: cy + uy*(r-3) }
                      return `${(cx+px).toFixed(1)},${(cy+py).toFixed(1)} ${(cx-px).toFixed(1)},${(cy-py).toFixed(1)} ${tip.x.toFixed(1)},${tip.y.toFixed(1)}`
                    }

                    // Tick marks
                    const ticks = [0, 30, 60, 90, 120, 150, 180]
                    const primary = 'hsl(var(--primary))'
                    const bg = 'hsl(var(--background))'

                    return (
                      <svg viewBox="0 0 240 145" className="w-full max-w-[280px] sm:max-w-[320px]">
                        {/* Tick marks */}
                        {ticks.map(deg => {
                          const inner = { x: cx + (r-14) * Math.cos(Math.PI - deg*Math.PI/180), y: cy - (r-14) * Math.sin(Math.PI - deg*Math.PI/180) }
                          const outer = { x: cx + (r+4) * Math.cos(Math.PI - deg*Math.PI/180), y: cy - (r+4) * Math.sin(Math.PI - deg*Math.PI/180) }
                          return <line key={deg} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
                            stroke="currentColor" strokeOpacity={deg % 90 === 0 ? 0.3 : 0.12} strokeWidth={deg % 90 === 0 ? 1.5 : 1} />
                        })}
                        {/* Background arc */}
                        <path d={fullArcPath} fill="none" strokeLinecap="round"
                          style={{ stroke: 'currentColor', strokeOpacity: 0.1, strokeWidth: 12 }} />
                        {/* Slider preview arc */}
                        <path d={fullArcPath} fill="none" strokeLinecap="round"
                          strokeDasharray={`${sliderDash.toFixed(1)} 1000`}
                          style={{ stroke: primary, strokeOpacity: 0.25, strokeWidth: 12 }} />
                        {/* Confirmed arc */}
                        <path d={fullArcPath} fill="none" strokeLinecap="round"
                          strokeDasharray={`${confirmedDash.toFixed(1)} 1000`}
                          style={{ stroke: primary, strokeWidth: 12 }} />
                        {/* Ghost needle */}
                        {sliderAngle !== servoAngle && (
                          <polygon points={needlePoly(ghost, 4)} style={{ fill: primary, fillOpacity: 0.3 }} />
                        )}
                        {/* Confirmed needle */}
                        <polygon points={needlePoly(needle, 3.5)} style={{ fill: primary }} />
                        {/* Pivot */}
                        <circle cx={cx} cy={cy} r="9" style={{ fill: primary, filter: 'drop-shadow(0 0 6px hsl(var(--primary)/0.6))' }} />
                        <circle cx={cx} cy={cy} r="5" style={{ fill: bg }} />
                        {/* Labels */}
                        <text x={cx-r-2} y={cy+20} fontSize="11" textAnchor="middle" fill="currentColor" fillOpacity="0.5">0°</text>
                        <text x={cx} y={cy-r-10} fontSize="11" textAnchor="middle" fill="currentColor" fillOpacity="0.5">90°</text>
                        <text x={cx+r+2} y={cy+20} fontSize="11" textAnchor="middle" fill="currentColor" fillOpacity="0.5">180°</text>
                      </svg>
                    )
                  })()}

                  {/* Angle readout */}
                  <div className="text-center">
                    <div className="text-5xl font-black tabular-nums tracking-tight">
                      {sliderAngle}<span className="text-2xl text-muted-foreground font-bold">°</span>
                    </div>
                    <p className={`text-xs mt-1 font-medium ${sliderAngle !== servoAngle ? 'text-yellow-400' : 'text-muted-foreground'}`}>
                      {sliderAngle !== servoAngle
                        ? `Pending · confirmed at ${servoAngle}°`
                        : 'Position confirmed'}
                    </p>
                  </div>
                </div>

                {/* ── Controls panel ── */}
                <div className="flex flex-col gap-5 p-6 lg:p-8 flex-1">

                  {/* Quick presets */}
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 mb-3">Quick Positions</p>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        { angle: 0,   label: 'Start'  },
                        { angle: 90,  label: 'Center' },
                        { angle: 180, label: 'End'    },
                      ] as const).map(({ angle, label }) => (
                        <button
                          type="button"
                          key={angle}
                          disabled={disabled}
                          onClick={() => sendServo(angle)}
                          className={`relative flex flex-col items-center gap-1 rounded-2xl py-4 border transition-all duration-200
                            ${servoAngle === angle
                              ? 'bg-primary/10 border-primary/40 text-primary shadow-[0_0_20px_hsl(var(--primary)/0.15)]'
                              : 'border-white/10 bg-white/[0.02] text-muted-foreground hover:text-foreground hover:border-white/15 hover:bg-white/5'
                            } disabled:opacity-40 disabled:cursor-not-allowed`}
                        >
                          {servoAngle === angle && (
                            <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-primary" />
                          )}
                          <span className="text-2xl font-black tabular-nums">{angle}°</span>
                          <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Slider */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">Custom Angle</p>
                      <span className="text-xs font-bold tabular-nums text-primary">{sliderAngle}°</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={180}
                      step={1}
                      value={sliderAngle}
                      disabled={disabled}
                      onChange={e => setSliderAngle(Number(e.target.value))}
                      onMouseUp={e => sendServo(Number((e.target as HTMLInputElement).value))}
                      onTouchEnd={e => sendServo(Number((e.target as HTMLInputElement).value))}
                      className="w-full accent-primary disabled:opacity-40 cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-muted-foreground/40 font-medium mt-1.5">
                      <span>0°</span><span>45°</span><span>90°</span><span>135°</span><span>180°</span>
                    </div>
                  </div>

                  {/* Fine adjustment */}
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 mb-3">Fine Adjust</p>
                    <div className="grid grid-cols-4 gap-2">
                      {([
                        { label: '−10°', delta: -10 },
                        { label: '−1°',  delta: -1  },
                        { label: '+1°',  delta: +1  },
                        { label: '+10°', delta: +10 },
                      ] as const).map(({ label, delta }) => (
                        <button
                          type="button"
                          key={label}
                          disabled={disabled}
                          onClick={() => {
                            const next = Math.min(180, Math.max(0, sliderAngle + delta))
                            sendServo(next)
                          }}
                          className="rounded-xl py-2 text-xs font-bold border border-white/10 bg-white/[0.02] text-muted-foreground hover:text-foreground hover:bg-white/5 hover:border-white/15 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                </div>
              </div>
            </CardContent>
          </Card>

          {/* Demo card */}
          <div className={`flex items-center justify-between gap-4 rounded-2xl px-5 py-4 border transition-all ${
            servoBusy
              ? 'bg-yellow-500/5 border-yellow-500/25'
              : 'bg-white/[0.02] border-white/5'
          }`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <RotateCw className={`w-3.5 h-3.5 shrink-0 ${servoBusy ? 'text-yellow-400 animate-spin' : 'text-muted-foreground/50'}`} />
                <p className="text-sm font-semibold">Full Range Demo</p>
              </div>
              <p className="text-xs text-muted-foreground/60 truncate">
                Sweeps 0° → 90° → 180° → 0° &mdash;{' '}
                <span className={servoBusy ? 'text-yellow-400' : 'text-yellow-500/70'}>
                  {servoBusy ? 'Running, ~6 seconds remaining…' : 'blocks all commands for ~6 s'}
                </span>
              </p>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                send('SERVO_DEMO')
                setServoBusy(true)
                setTimeout(() => setServoBusy(false), 7000)
              }}
              className={`shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl font-semibold text-sm border transition-all ${
                servoBusy
                  ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400 cursor-wait'
                  : 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              <RotateCw className={`w-4 h-4 ${servoBusy ? 'animate-spin' : ''}`} />
              {servoBusy ? 'Running…' : 'Run Demo'}
            </button>
          </div>

        </TabsContent>

        {/* ── DC MOTORS ── */}
        <TabsContent value="motors" className="space-y-4">

          <Card className="glass-card border-none overflow-hidden">
            <CardContent className="p-0">
              <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-white/5">
                {([
                  { id: 'left'  as MotorId, label: 'Left Brush',   icon: '← L' },
                  { id: 'both'  as MotorId, label: 'Both Brushes', icon: '⇄'   },
                  { id: 'right' as MotorId, label: 'Right Brush',  icon: 'R →' },
                ]).map(({ id, label, icon }) => {
                  const spd = motorSpeed[id]
                  const dir = motorDir[id]
                  const running = spd > 0
                  const isBoth = id === 'both'
                  const activeColor = dir === 'fwd' ? 'blue' : 'orange'

                  const speedBarColor = running
                    ? dir === 'fwd' ? 'bg-blue-500' : 'bg-orange-500'
                    : 'bg-white/10'

                  return (
                    <div key={id} className={`flex flex-col gap-5 p-5 transition-all duration-300 ${
                      isBoth ? 'bg-white/[0.02]' : ''
                    }`}>

                      {/* Header */}
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl shrink-0 flex items-center justify-center transition-all duration-300 ${
                          running
                            ? dir === 'fwd'
                              ? 'bg-blue-500/15 shadow-[0_0_14px_rgba(59,130,246,0.3)]'
                              : 'bg-orange-500/15 shadow-[0_0_14px_rgba(249,115,22,0.3)]'
                            : 'bg-white/5'
                        }`}>
                          {dir === 'fwd'
                            ? <RotateCw className={`w-5 h-5 transition-colors ${running ? 'text-blue-400' : 'text-muted-foreground/30'} ${running ? 'animate-spin' : ''}`}
                                style={{ animationDuration: spd === 100 ? '0.5s' : '1s' }} />
                            : <RotateCcw className={`w-5 h-5 transition-colors ${running ? 'text-orange-400' : 'text-muted-foreground/30'} ${running ? 'animate-spin' : ''}`}
                                style={{ animationDuration: spd === 100 ? '0.5s' : '1s', animationDirection: 'reverse' }} />
                          }
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm">{label}</p>
                          <p className={`text-xs font-medium transition-colors ${running ? (dir === 'fwd' ? 'text-blue-400' : 'text-orange-400') : 'text-muted-foreground/40'}`}>
                            {running ? `${spd}% · ${dir === 'fwd' ? 'Forward' : 'Reverse'}` : 'Stopped'}
                          </p>
                        </div>
                        <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full transition-all ${
                          running
                            ? dir === 'fwd' ? 'bg-blue-500/15 text-blue-400' : 'bg-orange-500/15 text-orange-400'
                            : 'bg-white/5 text-muted-foreground/40'
                        }`}>
                          {spd === 0 ? 'OFF' : `${spd}%`}
                        </span>
                      </div>

                      {/* Speed bar */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40">Speed</p>
                        </div>
                        <div className="flex gap-1">
                          {Array.from({ length: 10 }).map((_, i) => {
                            const threshold = (i + 1) * 10
                            const filled = spd >= threshold
                            return (
                              <div key={i} className={`flex-1 h-1.5 rounded-full transition-all duration-300 ${
                                filled ? (dir === 'fwd' ? 'bg-blue-500' : 'bg-orange-500') : 'bg-white/10'
                              }`} />
                            )
                          })}
                        </div>
                        <div className="rounded-xl bg-white/5 p-1 grid grid-cols-3 gap-1">
                          {([0, 50, 100] as const).map(s => (
                            <button
                              type="button"
                              key={s}
                              disabled={disabled}
                              onClick={() => applyMotor(id, s, dir)}
                              className={`rounded-lg py-2 text-xs font-bold transition-all duration-150 ${
                                spd === s
                                  ? s === 0
                                    ? 'bg-white/10 text-foreground shadow'
                                    : dir === 'fwd'
                                      ? 'bg-blue-600 text-white shadow-[0_0_12px_rgba(59,130,246,0.4)]'
                                      : 'bg-orange-600 text-white shadow-[0_0_12px_rgba(249,115,22,0.4)]'
                                  : 'text-muted-foreground/50 hover:text-foreground'
                              } disabled:opacity-40 disabled:cursor-not-allowed`}
                            >
                              {s === 0 ? 'Off' : `${s}%`}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Direction */}
                      <div className="space-y-2">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40">Direction</p>
                        <div className="rounded-xl bg-white/5 p-1 grid grid-cols-2 gap-1">
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => applyMotor(id, spd, 'fwd')}
                            className={`flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-xs font-bold transition-all duration-150 ${
                              dir === 'fwd'
                                ? 'bg-blue-600 text-white shadow-[0_0_12px_rgba(59,130,246,0.35)]'
                                : 'text-muted-foreground/50 hover:text-foreground'
                            } disabled:opacity-40 disabled:cursor-not-allowed`}
                          >
                            <ArrowUp className="w-3 h-3 shrink-0" /> Fwd
                          </button>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => applyMotor(id, spd, 'rev')}
                            className={`flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-xs font-bold transition-all duration-150 ${
                              dir === 'rev'
                                ? 'bg-orange-600 text-white shadow-[0_0_12px_rgba(249,115,22,0.35)]'
                                : 'text-muted-foreground/50 hover:text-foreground'
                            } disabled:opacity-40 disabled:cursor-not-allowed`}
                          >
                            <ArrowDown className="w-3 h-3 shrink-0" /> Rev
                          </button>
                        </div>
                      </div>

                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Emergency stop */}
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              send('MOTOR_BRAKE')
              setMotorSpeed({ left: 0, right: 0, both: 0 })
            }}
            className="w-full flex items-center justify-center gap-2.5 rounded-2xl py-3.5 font-bold text-sm bg-destructive/10 hover:bg-destructive/15 text-destructive border border-destructive/20 hover:border-destructive/40 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Zap className="w-4 h-4" />
            Emergency Stop — Cut All Brush Motors
          </button>

        </TabsContent>

        {/* ── LINEAR ACTUATORS ── */}
        <TabsContent value="steppers" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {([
              {
                n: 1, label: 'Top Actuator', sub: '480 mm stroke',
                maxMm: 480, stepsPerMm: 10, precision: 1,
                pos: s1Pos, targetMm: s1TargetMm, setTargetMm: setS1TargetMm,
                speedLevel: s1SpeedLevel, setSpeedLevel: setS1SpeedLevel,
                jog: [-50, -10, 10, 50] as number[], step: 1,
                color: 'violet' as const,
                onRefresh: () => send('STEPPER1_INFO'),
                onReturn:  () => send('STEPPER1_RETURN'),
                onZero:    () => { send('STEPPER1_HOME'); setS1Pos(0); setS1TargetMm(0) },
                onStop:    () => send('STEPPER1_STOP'),
                onMove:    (delta: number) => send(`STEPPER1_MM_${delta}`),
                onSpeed:   (lvl: string) => send(`STEPPER1_SPEED_${[200,400,800][['slow','normal','fast'].indexOf(lvl)]}`),
              },
              {
                n: 2, label: 'Side Actuator', sub: '100 mm stroke',
                maxMm: 100, stepsPerMm: 200, precision: 2,
                pos: s2Pos, targetMm: s2TargetMm, setTargetMm: setS2TargetMm,
                speedLevel: s2SpeedLevel, setSpeedLevel: setS2SpeedLevel,
                jog: [-20, -5, 5, 20] as number[], step: 0.5,
                color: 'teal' as const,
                onRefresh: () => send('STEPPER2_INFO'),
                onReturn:  () => send('STEPPER2_RETURN'),
                onZero:    () => { send('STEPPER2_HOME'); setS2Pos(0); setS2TargetMm(0) },
                onStop:    () => send('STEPPER2_STOP'),
                onMove:    (delta: number) => send(`STEPPER2_MM_${delta}`),
                onSpeed:   (lvl: string) => send(`STEPPER2_SPEED_${[3000,12000,24000][['slow','normal','fast'].indexOf(lvl)]}`),
              },
            ]).map(({ n, label, sub, maxMm, stepsPerMm, precision, pos, targetMm, setTargetMm,
                      speedLevel, setSpeedLevel, jog, step, color,
                      onRefresh, onReturn, onZero, onStop, onMove, onSpeed }) => {
              const posMm  = pos !== null ? pos / stepsPerMm : null
              const pct    = posMm !== null ? Math.min(100, Math.max(0, (posMm / maxMm) * 100)) : 0
              const tgtPct = Math.min(100, Math.max(0, (targetMm / maxMm) * 100))

              const c = color === 'violet' ? {
                icon:         'text-violet-400',
                bg:           'bg-violet-500/10',
                fill:         'bg-violet-500',
                glow:         'shadow-[0_0_16px_rgba(139,92,246,0.45)]',
                ring:         'ring-violet-500/30',
                text:         'text-violet-400',
                accentColor:  '#8b5cf6',
                activeBg:     'bg-violet-600',
                activeShadow: 'shadow-[0_0_12px_rgba(139,92,246,0.45)]',
                moveBtn:      'bg-violet-500/10 hover:bg-violet-500/20 text-violet-400 border border-violet-500/30 hover:border-violet-500/50',
              } : {
                icon:         'text-teal-400',
                bg:           'bg-teal-500/10',
                fill:         'bg-teal-500',
                glow:         'shadow-[0_0_16px_rgba(20,184,166,0.45)]',
                ring:         'ring-teal-500/30',
                text:         'text-teal-400',
                accentColor:  '#14b8a6',
                activeBg:     'bg-teal-600',
                activeShadow: 'shadow-[0_0_12px_rgba(20,184,166,0.45)]',
                moveBtn:      'bg-teal-500/10 hover:bg-teal-500/20 text-teal-400 border border-teal-500/30 hover:border-teal-500/50',
              }

              return (
                <Card key={n} className="glass-card border-none overflow-hidden">
                  <CardContent className="p-0">

                    {/* ── Header ── */}
                    <div className="flex items-center justify-between p-5 pb-4 border-b border-white/5">
                      <div className="flex items-center gap-3">
                        <div className={`p-2.5 rounded-xl transition-all duration-300 ${c.bg} ${posMm !== null ? c.glow : ''}`}>
                          <MoveHorizontal className={`w-5 h-5 transition-colors ${posMm !== null ? c.icon : 'text-muted-foreground/40'}`} />
                        </div>
                        <div>
                          <p className="font-semibold text-sm">{label}</p>
                          <p className="text-xs text-muted-foreground/60">{sub}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className={`px-3 py-1.5 rounded-xl font-mono font-bold text-sm ring-1 transition-all duration-500 ${
                          posMm !== null
                            ? `${c.ring} ${c.bg} ${c.text}`
                            : 'ring-white/8 bg-white/[0.02] text-muted-foreground/30'
                        }`}>
                          {posMm !== null ? `${posMm.toFixed(precision)} mm` : '— mm'}
                        </div>
                        <button type="button" disabled={disabled} onClick={onRefresh}
                          className="p-2 rounded-xl border border-white/10 bg-white/[0.02] text-muted-foreground/50 hover:text-foreground hover:bg-white/5 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* ── Position rail ── */}
                    <div className="px-5 pt-5 pb-2">
                      <div className="relative py-1.5">
                        <div className="h-2 rounded-full bg-white/[0.06]" />
                        {/* Target ghost fill */}
                        <div className={`absolute top-1.5 left-0 h-2 ${c.fill} opacity-15 rounded-full transition-all duration-150`}
                          style={{ width: `${tgtPct}%` }} />
                        {/* Confirmed fill */}
                        <div className={`absolute top-1.5 left-0 h-2 ${c.fill} opacity-65 rounded-full transition-all duration-500`}
                          style={{ width: `${pct}%` }} />
                        {/* Glowing head */}
                        {posMm !== null && (
                          <div className={`absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 border-background transition-all duration-500 ${c.fill} ${c.glow}`}
                            style={{ left: `clamp(0px, calc(${pct}% - 10px), calc(100% - 20px))` }} />
                        )}
                      </div>
                      <div className="flex justify-between text-[10px] text-muted-foreground/40 font-medium mt-2.5">
                        <span>0</span>
                        <span>{maxMm / 2} mm</span>
                        <span>{maxMm} mm</span>
                      </div>
                    </div>

                    <div className="px-5 pb-5 space-y-4">

                      {/* ── Jog ── */}
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40 mb-2">Jog</p>
                        <div className="rounded-xl bg-white/5 p-1 grid grid-cols-5 gap-1">
                          {([
                            { delta: jog[0], icon: <ChevronsLeft className="w-4 h-4" />,             label: String(Math.abs(jog[0])) },
                            { delta: jog[1], icon: <ChevronLeft className="w-4 h-4" />,              label: String(Math.abs(jog[1])) },
                            { delta: 0,      icon: <Square className="w-3.5 h-3.5 fill-current" />, label: 'Stop', stop: true },
                            { delta: jog[2], icon: <ChevronRight className="w-4 h-4" />,             label: String(Math.abs(jog[2])) },
                            { delta: jog[3], icon: <ChevronsRight className="w-4 h-4" />,            label: String(Math.abs(jog[3])) },
                          ] as { delta: number; icon: React.ReactNode; label: string; stop?: boolean }[]).map(({ delta, icon, label: lbl, stop }, i) => (
                            <button
                              type="button"
                              key={i}
                              disabled={disabled}
                              onClick={() => stop ? onStop() : onMove(delta)}
                              className={`flex flex-col items-center gap-1 rounded-lg py-2.5 text-xs font-bold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
                                stop
                                  ? 'bg-destructive/20 hover:bg-destructive/30 text-destructive'
                                  : 'text-muted-foreground/60 hover:text-foreground hover:bg-white/5'
                              }`}
                            >
                              {icon}
                              <span className="text-[9px] font-bold opacity-70">{lbl}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* ── Go to Position ── */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40">Go to Position</p>
                          <span className={`text-xs font-bold tabular-nums ${c.text}`}>{targetMm} mm</span>
                        </div>
                        <input
                          type="range"
                          min={0} max={maxMm} step={step} value={targetMm}
                          disabled={disabled}
                          onChange={e => setTargetMm(Number(e.target.value))}
                          className="w-full disabled:opacity-40 cursor-pointer"
                          style={{ accentColor: c.accentColor }}
                        />
                        <div className="flex justify-between text-[10px] text-muted-foreground/40 font-medium mt-1 mb-3">
                          <span>0</span><span>{maxMm / 2} mm</span><span>{maxMm} mm</span>
                        </div>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => onMove(targetMm - (posMm ?? 0))}
                          className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${c.moveBtn}`}
                        >
                          <MapPin className="w-4 h-4" />
                          Move to {targetMm} mm
                        </button>
                      </div>

                      {/* ── Speed ── */}
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40 mb-2">Speed</p>
                        <div className="rounded-xl bg-white/5 p-1 grid grid-cols-3 gap-1">
                          {(['slow', 'normal', 'fast'] as const).map(lvl => (
                            <button
                              type="button"
                              key={lvl}
                              disabled={disabled}
                              onClick={() => { setSpeedLevel(lvl); onSpeed(lvl) }}
                              className={`rounded-lg py-2 text-xs font-bold capitalize transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
                                speedLevel === lvl
                                  ? `${c.activeBg} text-white ${c.activeShadow}`
                                  : 'text-muted-foreground/50 hover:text-foreground'
                              }`}
                            >
                              {lvl}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* ── Utilities ── */}
                      <div className="grid grid-cols-2 gap-2 pt-3 border-t border-white/5">
                        <button type="button" disabled={disabled} onClick={onReturn}
                          className="flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold border border-white/10 bg-white/[0.02] text-muted-foreground/60 hover:text-foreground hover:bg-white/5 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                          <Home className="w-3.5 h-3.5" /> Return to 0
                        </button>
                        <button type="button" disabled={disabled} onClick={onZero}
                          className="flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold border border-white/10 bg-white/[0.02] text-muted-foreground/60 hover:text-foreground hover:bg-white/5 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                          <MapPin className="w-3.5 h-3.5" /> Zero Here
                        </button>
                      </div>

                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {/* Stop both */}
          <button
            type="button"
            disabled={disabled}
            onClick={() => { send('STEPPER1_STOP'); send('STEPPER2_STOP') }}
            className="w-full flex items-center justify-center gap-2.5 rounded-2xl py-3.5 font-bold text-sm bg-destructive/10 hover:bg-destructive/15 text-destructive border border-destructive/20 hover:border-destructive/40 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Square className="w-4 h-4 fill-current" />
            Stop Both Actuators
          </button>
        </TabsContent>

        {/* ── RGB LED ── */}
        <TabsContent value="rgb">
          {(() => {
            const previewColor = `rgb(${rgbR},${rgbG},${rgbB})`
            const brightness = rgbR * 0.299 + rgbG * 0.587 + rgbB * 0.114
            const isOff = rgbR === 0 && rgbG === 0 && rgbB === 0
            const hexColor = `#${[rgbR, rgbG, rgbB].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`

            const PRESETS = [
              { label: 'White',  cmd: 'RGB_WHITE',  color: '#f8fafc', r: 255, g: 255, b: 255 },
              { label: 'Blue',   cmd: 'RGB_BLUE',   color: '#3b82f6', r: 59,  g: 130, b: 246 },
              { label: 'Green',  cmd: 'RGB_GREEN',  color: '#22c55e', r: 34,  g: 197, b: 94  },
              { label: 'Violet', cmd: 'RGB_VIOLET', color: '#a78bfa', r: 139, g: 92,  b: 246 },
              { label: 'Off',    cmd: 'RGB_OFF',    color: '#1e293b', r: 0,   g: 0,   b: 0   },
            ]

            return (
              <Card className="glass-card border-none overflow-hidden">
                <CardContent className="p-0">
                  <div className="flex flex-col lg:flex-row">

                    {/* ── Left: Preview ── */}
                    <div
                      className="relative flex flex-col items-center justify-between gap-6 p-6 lg:p-8 lg:w-[42%] border-b lg:border-b-0 lg:border-r border-white/5 min-h-[300px] transition-all duration-700"
                      style={{ background: isOff ? undefined : `radial-gradient(ellipse at 50% 30%, ${previewColor}18 0%, transparent 65%)` }}
                    >
                      {/* Orb */}
                      <div className="flex-1 flex items-center justify-center w-full">
                        <div className="relative flex items-center justify-center">
                          <div className="absolute rounded-full transition-all duration-700 pointer-events-none"
                            style={{ width: 200, height: 200, backgroundColor: previewColor, opacity: isOff ? 0 : 0.07, filter: 'blur(40px)' }} />
                          <div className="absolute rounded-full transition-all duration-500 pointer-events-none"
                            style={{ width: 160, height: 160, backgroundColor: previewColor, opacity: isOff ? 0 : 0.12, filter: 'blur(20px)' }} />
                          <div
                            className="relative w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500"
                            style={{
                              backgroundColor: previewColor,
                              boxShadow: isOff
                                ? 'inset 0 1px 0 rgba(255,255,255,0.05)'
                                : `0 0 50px 8px ${previewColor}50, 0 0 20px 4px ${previewColor}30, inset 0 1px 0 rgba(255,255,255,0.25)`,
                            }}
                          >
                            {isOff && <Power className="w-7 h-7 text-white/10" />}
                          </div>
                        </div>
                      </div>

                      {/* Color info */}
                      <div className="text-center space-y-1">
                        <p
                          className="font-mono text-2xl font-bold tracking-widest transition-all duration-300"
                          style={{
                            color: isOff ? 'rgba(255,255,255,0.15)' : previewColor,
                            textShadow: isOff ? 'none' : `0 0 20px ${previewColor}80`,
                          }}
                        >
                          {hexColor}
                        </p>
                        <p className="text-[11px] text-muted-foreground/40 font-mono">rgb({rgbR}, {rgbG}, {rgbB})</p>
                      </div>

                      {/* Preset swatches */}
                      <div className="w-full grid grid-cols-5 gap-1.5">
                        {PRESETS.map(({ label, cmd, color, r, g, b }) => (
                          <button
                            type="button"
                            key={cmd}
                            disabled={disabled}
                            onClick={() => { send(cmd); setRgbR(r); setRgbG(g); setRgbB(b); setActiveColorCmd(cmd) }}
                            className={`flex flex-col items-center gap-1.5 py-2.5 rounded-xl border transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${
                              activeColorCmd === cmd
                                ? 'border-white/15 bg-white/10 scale-[1.05]'
                                : 'border-transparent hover:border-white/10 hover:bg-white/[0.04]'
                            }`}
                          >
                            <div
                              className="w-8 h-8 rounded-full border border-white/10 transition-all duration-300"
                              style={{
                                backgroundColor: color,
                                boxShadow: activeColorCmd === cmd ? `0 0 14px 4px ${color}80` : 'none',
                              }}
                            />
                            <span className="text-[9px] font-bold text-muted-foreground/50 uppercase tracking-wide leading-none">{label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* ── Right: Controls ── */}
                    <div className="flex flex-col gap-6 p-6 lg:p-8 flex-1">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/40">Custom Color</p>

                      <div className="space-y-5">
                        {([
                          {
                            label: 'Red',   val: rgbR, set: setRgbR, accent: '#ef4444',
                            zero: `rgb(0,${rgbG},${rgbB})`,       pure: `rgb(255,${rgbG},${rgbB})`,
                          },
                          {
                            label: 'Green', val: rgbG, set: setRgbG, accent: '#22c55e',
                            zero: `rgb(${rgbR},0,${rgbB})`,       pure: `rgb(${rgbR},255,${rgbB})`,
                          },
                          {
                            label: 'Blue',  val: rgbB, set: setRgbB, accent: '#3b82f6',
                            zero: `rgb(${rgbR},${rgbG},0)`,       pure: `rgb(${rgbR},${rgbG},255)`,
                          },
                        ] as { label: string; val: number; set: (v: number) => void; accent: string; zero: string; pure: string }[]).map(({ label, val, set, accent, zero, pure }) => (
                          <div key={label} className="space-y-2">
                            <div className="flex justify-between items-center">
                              <span className="text-xs font-bold" style={{ color: accent }}>{label}</span>
                              <span className="text-sm font-mono font-bold tabular-nums" style={{ color: accent }}>{val}</span>
                            </div>
                            {/* Custom gradient track */}
                            <div className="relative h-8">
                              <div
                                className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-3 rounded-full overflow-hidden pointer-events-none"
                                style={{ background: `linear-gradient(to right, ${zero}, ${pure})` }}
                              >
                                <div
                                  className="absolute inset-y-0 right-0 bg-black/60"
                                  style={{ width: `${(1 - val / 255) * 100}%` }}
                                />
                              </div>
                              {/* Native input (invisible, handles interaction) */}
                              <input
                                type="range"
                                min={0} max={255} step={1} value={val}
                                disabled={disabled}
                                onChange={e => { set(Number(e.target.value)); setActiveColorCmd('custom') }}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-0"
                              />
                              {/* Custom thumb */}
                              <div
                                className="absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 border-background pointer-events-none shadow-lg"
                                style={{
                                  left: `clamp(0px, calc(${(val / 255) * 100}% - 10px), calc(100% - 20px))`,
                                  backgroundColor: accent,
                                  boxShadow: `0 0 10px 3px ${accent}60`,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Apply button */}
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => { send(`RGB_CUSTOM_${rgbR}_${rgbG}_${rgbB}`); setActiveColorCmd('custom') }}
                        className="mt-auto w-full py-3.5 rounded-xl text-sm font-bold border transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                          backgroundColor: isOff ? 'rgba(255,255,255,0.03)' : previewColor,
                          color: isOff ? 'rgba(255,255,255,0.25)' : brightness > 140 ? '#000' : '#fff',
                          boxShadow: isOff ? 'none' : `0 0 24px 4px ${previewColor}45`,
                          borderColor: isOff ? 'rgba(255,255,255,0.08)' : `${previewColor}40`,
                        }}
                      >
                        {isOff ? 'Turn Off' : `Apply ${hexColor}`}
                      </button>
                    </div>

                  </div>
                </CardContent>
              </Card>
            )
          })()}
        </TabsContent>

        {/* ── SYSTEM ── */}
        <TabsContent value="system" className="space-y-6">

          {/* Safe Operations */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Device Status */}
            <Card className="glass-card border-none">
              <CardContent className="p-5 flex items-start gap-4">
                <div className="p-3 rounded-xl bg-primary/10 shrink-0">
                  <Activity className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold text-sm">Device Status</p>
                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-primary/10 text-primary">Safe</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">Queries device state — response appears in the log below.</p>
                  <Button size="sm" disabled={disabled} onClick={() => send('STATUS')}>Query Status</Button>
                </div>
              </CardContent>
            </Card>

            {/* Reset Money */}
            <Card className="glass-card border-none ring-1 ring-yellow-500/20">
              <CardContent className="p-5 flex items-start gap-4">
                <div className="p-3 rounded-xl bg-yellow-500/10 shrink-0">
                  <DollarSign className="w-5 h-5 text-yellow-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold text-sm">Reset Money Counters</p>
                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-500">Caution</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">Resets all coin and bill totals to ₱0. This cannot be undone.</p>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="outline" className="border-yellow-500/40 text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-400" disabled={disabled}>Reset Money</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Reset Money Counters?</AlertDialogTitle>
                        <AlertDialogDescription>All coin and bill totals will be reset to ₱0. This cannot be undone.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => send('RESET_MONEY')}>Reset</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Danger Zone */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
                <p className="text-xs font-black uppercase tracking-[0.2em] text-destructive/80">Danger Zone</p>
              </div>
              <div className="flex-1 h-px bg-destructive/20" />
            </div>

            <div className="rounded-2xl ring-1 ring-destructive/20 bg-destructive/[0.03] p-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

                {/* Reset WiFi */}
                <div className="rounded-xl bg-background/40 border border-destructive/15 p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="p-2 rounded-lg bg-destructive/10 shrink-0">
                      <WifiOff className="w-4 h-4 text-destructive" />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">Destructive</span>
                  </div>
                  <div>
                    <p className="font-semibold text-sm mb-1">Reset WiFi</p>
                    <p className="text-xs text-muted-foreground">Clears WiFi credentials and restarts. Device offline for 10–30 seconds.</p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="destructive" className="w-full mt-auto" disabled={disabled}>Reset WiFi</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Reset WiFi Credentials?</AlertDialogTitle>
                        <AlertDialogDescription>The device will clear its WiFi settings and restart. It will be offline for 10–30 seconds and must be reconfigured.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { send('RESET_WIFI'); toast.info('Command sent — device is restarting. This may take 10–30 seconds.') }}>
                          Reset WiFi
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>

                {/* Reset Pairing */}
                <div className="rounded-xl bg-background/40 border border-destructive/15 p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="p-2 rounded-lg bg-destructive/10 shrink-0">
                      <Unlink className="w-4 h-4 text-destructive" />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">Destructive</span>
                  </div>
                  <div>
                    <p className="font-semibold text-sm mb-1">Reset Pairing</p>
                    <p className="text-xs text-muted-foreground">Clears pairing, generates new pairing code, and restarts. Device offline for 10–30 seconds.</p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="destructive" className="w-full mt-auto" disabled={disabled}>Reset Pairing</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Reset Device Pairing?</AlertDialogTitle>
                        <AlertDialogDescription>The device will lose its pairing status, generate a new pairing code, and restart. It must be re-paired after coming back online.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { send('RESET_PAIRING'); toast.info('Command sent — device is restarting. This may take 10–30 seconds.') }}>
                          Reset Pairing
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>

                {/* Factory Reset */}
                <div className="rounded-xl bg-destructive/5 border border-destructive/25 p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="p-2 rounded-lg bg-destructive/15 shrink-0">
                      <RotateCcw className="w-4 h-4 text-destructive" />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-destructive/20 text-destructive">Critical</span>
                  </div>
                  <div>
                    <p className="font-semibold text-sm mb-1">Factory Reset</p>
                    <p className="text-xs text-muted-foreground">Clears all settings — WiFi, pairing, money counters — and restarts. Full reconfiguration required.</p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="destructive" className="w-full mt-auto" disabled={disabled}>Factory Reset</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Factory Reset Device?</AlertDialogTitle>
                        <AlertDialogDescription>This will erase all WiFi credentials, pairing data, and money counters, then restart the device. The device will be completely offline and must be fully reconfigured from scratch.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { send('FACTORY_RESET'); toast.info('Factory reset sent — device is restarting. Full reconfiguration required.') }}>
                          Factory Reset
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>

              </div>
            </div>
          </div>

        </TabsContent>

        {/* ── CAMERA ── */}
        <TabsContent value="cam">
          <Card className="glass-card border-none">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-muted-foreground" />
                <CardTitle className="text-sm font-medium">CAM Live Feed</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-5 flex flex-col items-center gap-4">

              {/* Feed — centered, capped width, 4:3 VGA ratio */}
              <div className="relative w-full max-w-md rounded-xl overflow-hidden bg-black aspect-[4/3]">
                {streamActive ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      key={streamKey}
                      src={`/api/device/${selectedDevice}/stream?k=${streamKey}`}
                      alt="CAM live feed"
                      className={`w-full h-full object-contain transition-opacity duration-300 ${streamStatus === 'live' ? 'opacity-100' : 'opacity-0'}`}
                      onLoad={() => setStreamStatus('live')}
                      onError={() => setStreamStatus('error')}
                    />
                    {streamStatus === 'loading' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <Camera className="w-8 h-8 opacity-25 animate-pulse" />
                        <p className="text-xs">Connecting to camera…</p>
                      </div>
                    )}
                    {streamStatus === 'error' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <VideoOff className="w-8 h-8 opacity-25" />
                        <p className="text-xs">Camera unreachable</p>
                      </div>
                    )}
                    {/* Live badge overlay */}
                    {streamStatus === 'live' && (
                      <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/50 backdrop-blur-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
                        <span className="text-xs text-emerald-400 font-medium">Live</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                    <Camera className="w-10 h-10 opacity-15" />
                    <p className="text-sm opacity-40">Stream not started</p>
                  </div>
                )}
              </div>

              {/* Controls row */}
              <div className="flex items-center gap-2">
                {!streamActive ? (
                  <Button
                    size="sm"
                    className="gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => { setStreamStatus('loading'); setStreamActive(true); setStreamKey(k => k + 1) }}
                  >
                    <Camera className="w-3.5 h-3.5" />
                    Start Live View
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm" variant="outline" className="gap-1.5 text-xs"
                      onClick={() => { setStreamActive(false); setStreamStatus('idle') }}
                    >
                      <VideoOff className="w-3.5 h-3.5" />
                      Stop
                    </Button>
                    <Button
                      size="sm" variant="outline" className="gap-1.5 text-xs"
                      onClick={() => { setStreamStatus('loading'); setStreamKey(k => k + 1) }}
                    >
                      <RefreshCcw className="w-3.5 h-3.5" />
                      Reconnect
                    </Button>
                  </>
                )}
                <Button
                  size="sm" variant="outline" className="gap-1.5 text-xs"
                  onClick={() => window.open(`/api/device/${selectedDevice}/snapshot?t=${Date.now()}`, '_blank')}
                >
                  <Download className="w-3.5 h-3.5" />
                  Snapshot
                </Button>
              </div>

            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Live Response Log ── */}
      <Card className="glass-card border-none flex-shrink-0">
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium text-muted-foreground">Live Response Log</CardTitle>
          <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => setLog([])}>Clear</Button>
        </CardHeader>
        <CardContent className="p-0">
          <div className="h-40 overflow-y-auto font-mono text-xs px-4 pb-3 space-y-1">
            {log.length === 0 && <p className="text-muted-foreground/50 pt-2">No messages yet…</p>}
            {log.map(entry => (
              <div key={entry.id} className="flex items-start gap-2">
                <span className="text-muted-foreground/50 flex-shrink-0 pt-0.5">{entry.timestamp}</span>
                <Badge variant={badgeVariant(entry.type)} className="text-[10px] px-1 py-0 h-4 flex-shrink-0 capitalize">
                  {entry.type}
                </Badge>
                <span className="text-foreground/80 break-all">{entry.message}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
