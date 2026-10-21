import type { NodeStats } from '../sim/simulator'

export type Status = 'good' | 'warning' | 'critical' | 'idle'

export const STATUS_TEXT: Record<Status, string> = {
  good: 'Healthy',
  warning: 'Degraded',
  critical: 'Failing',
  idle: 'Idle',
}

const ICON: Record<Status, string> = { good: '✓', warning: '!', critical: '✕', idle: '·' }

export function nodeStatus(ns?: NodeStats): Status {
  if (!ns) return 'idle'
  const err = ns.req ? ns.err / ns.req : 0
  if (err > 0.2) return 'critical'
  if (err > 0.02 || ns.util > 0.85) return 'warning'
  return 'good'
}

/** Status is always icon + word, never color alone. */
export function StatusBadge({ status, x, y }: { status: Status; x: number; y: number }) {
  return (
    <text x={x} y={y} textAnchor="end" className={`status-text status-${status}`}>
      {ICON[status]} {STATUS_TEXT[status]}
    </text>
  )
}

export function StatusPill({ status, children }: { status: Status; children?: React.ReactNode }) {
  return (
    <span className={`pill pill-${status}`}>
      {ICON[status]} {children ?? STATUS_TEXT[status]}
    </span>
  )
}
