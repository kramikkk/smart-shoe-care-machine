export type TransactionStatus = 'ACTIVE' | 'COMPLETED' | 'INTERRUPTED' | 'ABANDONED'

export const STATUS_BADGE: Record<TransactionStatus, { label: string; className: string }> = {
  ACTIVE:      { label: 'Running',     className: 'bg-blue-500/20 text-blue-300 border border-blue-500/30' },
  COMPLETED:   { label: 'Completed',   className: 'bg-green-500/20 text-green-300 border border-green-500/30' },
  INTERRUPTED: { label: 'Interrupted', className: 'bg-orange-500/20 text-orange-300 border border-orange-500/30' },
  ABANDONED:   { label: 'Abandoned',   className: 'bg-red-500/20 text-red-300 border border-red-500/30' },
}

export function getStatusBadge(status: string | null | undefined) {
  const key = (status ?? 'COMPLETED').toUpperCase() as TransactionStatus
  return STATUS_BADGE[key] ?? STATUS_BADGE.COMPLETED
}
