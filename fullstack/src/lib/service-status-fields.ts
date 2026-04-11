/**
 * Normalise firmware `service-status` payloads so UI and logs agree.
 * Firmware 1.2.1+ sends progress, timeRemaining, active plus elapsedSeconds /
 * remainingSeconds / durationSeconds; older builds may omit some fields.
 */

export type ServiceStatusLike = Record<string, unknown>

export type ServiceStage = 'cleaning' | 'drying' | 'sterilizing'

/** Map firmware `serviceType` string to a known kiosk stage. */
export function normalizeServiceStage(t: string): ServiceStage | null {
  const x = String(t).trim().toLowerCase()
  if (x === 'cleaning' || x === 'drying' || x === 'sterilizing') return x
  return null
}

/**
 * Auto/kiosk package flow: total wall time left = current stage remaining plus
 * later stages (durations must match what was sent in start-service).
 */
export function packageRemainingSecondsForAuto(
  currentStage: ServiceStage,
  stageRemainingSeconds: number,
  stageDurationsSec: { cleaning: number; drying: number; sterilizing: number }
): number {
  const r = Math.max(0, Math.floor(stageRemainingSeconds))
  const { drying: d, sterilizing: s } = stageDurationsSec
  if (currentStage === 'cleaning') return r + d + s
  if (currentStage === 'drying') return r + s
  return r
}

export function parseServiceStatusRemainingSeconds(msg: ServiceStatusLike): number {
  const v = msg.remainingSeconds ?? msg.timeRemaining
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

/**
 * Same as {@link parseServiceStatusRemainingSeconds} but returns `null` when the
 * payload omits or invalidates time fields — avoids treating "missing" as 0s left
 * (which would flash complete / redirect on kiosk).
 */
export function tryParseServiceStatusRemainingSeconds(msg: ServiceStatusLike): number | null {
  const rs = msg.remainingSeconds
  const tr = msg.timeRemaining
  // Treat missing or JSON `null` as absent — `Number(null)` is 0 and would fake "done"
  if ((rs === undefined || rs === null) && (tr === undefined || tr === null)) {
    return null
  }
  const v = rs ?? tr
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}

export function parseServiceStatusProgress(msg: ServiceStatusLike): number {
  const p = msg.progress
  if (typeof p === 'number' && Number.isFinite(p)) {
    return Math.min(100, Math.max(0, Math.round(p)))
  }
  if (typeof p === 'string' && p.trim() !== '') {
    const n = Number(p)
    if (Number.isFinite(n)) return Math.min(100, Math.max(0, Math.round(n)))
  }
  const dur = typeof msg.durationSeconds === 'number' ? msg.durationSeconds : Number(msg.durationSeconds)
  const elapsed =
    typeof msg.elapsedSeconds === 'number' ? msg.elapsedSeconds : Number(msg.elapsedSeconds)
  if (Number.isFinite(dur) && dur > 0 && Number.isFinite(elapsed) && elapsed >= 0) {
    return Math.min(100, Math.round((elapsed * 100) / dur))
  }
  return 0
}

export function parseServiceStatusActive(msg: ServiceStatusLike): boolean {
  if (typeof msg.active === 'boolean') return msg.active
  const s = String(msg.status ?? '')
  return s === 'started' || s === 'running'
}

/** Stage length in seconds from firmware, or null if missing/invalid. */
export function parseServiceStatusDurationSeconds(msg: ServiceStatusLike): number | null {
  const d = msg.durationSeconds
  const n = typeof d === 'number' ? d : Number(d)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}
