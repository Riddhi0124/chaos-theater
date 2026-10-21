import type { NodeName } from './topology'

/** Per-second health signal for one node, produced by the anomaly detectors. */
export interface NodeSignal {
  errRate: number
  baseErr: number
  errZ: number
  errAnom: boolean
  p99: number
  baseP99: number
  latZ: number
  latAnom: boolean
  /** share of all failures (system-wide) that originated at this node, from trace data */
  originShare: number
  /** node-specific extra signal (e.g. CDN cache-miss ratio) */
  extraZ: number
  extraAnom: boolean
  extraLabel?: string
}

export interface Candidate {
  node: NodeName
  score: number
  reasons: string[]
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`
const ms = (x: number) => `${Math.round(x)}ms`
const capZ = (z: number) => Math.min(Math.max(z, 0), 40) / 8

/**
 * Rank likely root causes. The idea: a node is a strong suspect if errors *originate* there
 * (per trace attribution), or if it got slow while everything it depends on stayed healthy.
 * A node that is slow only because a dependency is slow is a symptom, not a cause.
 */
export function rankRootCauses(
  sig: Record<NodeName, NodeSignal>,
  deps: Record<NodeName, NodeName[]>,
): Candidate[] {
  const out: Candidate[] = []
  for (const node of Object.keys(sig) as NodeName[]) {
    const s = sig[node]
    let score = 0
    const reasons: string[] = []
    if (s.errAnom) {
      score += 1 + capZ(s.errZ) + 4 * s.originShare
      reasons.push(
        `errors originating here: ${pct(s.errRate)} (baseline ${pct(s.baseErr)}), ${pct(s.originShare)} of all failures`,
      )
    }
    if (s.latAnom) {
      const slowDeps = deps[node].filter((d) => sig[d]?.latAnom)
      if (slowDeps.length === 0) {
        score += 1 + capZ(s.latZ)
        reasons.push(`p99 latency ${ms(s.p99)} vs baseline ${ms(s.baseP99)} while its dependencies stayed healthy`)
      }
    }
    if (s.extraAnom) {
      score += 1 + capZ(s.extraZ)
      reasons.push(s.extraLabel ?? 'secondary signal anomalous')
    }
    if (score > 0) out.push({ node, score, reasons })
  }
  return out.sort((a, b) => b.score - a.score)
}
