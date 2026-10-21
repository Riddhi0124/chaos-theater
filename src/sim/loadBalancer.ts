import type { Rng } from './rng'

export type LbStrategy = 'round-robin' | 'least-outstanding' | 'p2c'

export const LB_LABELS: Record<LbStrategy, string> = {
  'round-robin': 'Round robin',
  'least-outstanding': 'Least outstanding',
  p2c: 'Power of two choices',
}

export interface Balanceable {
  inflight: number
  queue: unknown[]
}

const load = (x: Balanceable) => x.inflight + x.queue.length

/** Client-side load balancing over the instances service discovery says are up. */
export function pickInstance<T extends Balanceable>(
  pool: T[],
  strategy: LbStrategy,
  state: { rr: number },
  rng: Rng,
): T | undefined {
  if (pool.length === 0) return undefined
  if (pool.length === 1) return pool[0]
  switch (strategy) {
    case 'round-robin':
      return pool[state.rr++ % pool.length]
    case 'least-outstanding': {
      let best = pool[0]
      for (const x of pool) if (load(x) < load(best)) best = x
      return best
    }
    case 'p2c': {
      const i = rng.int(pool.length)
      let j = rng.int(pool.length - 1)
      if (j >= i) j++
      return load(pool[i]) <= load(pool[j]) ? pool[i] : pool[j]
    }
  }
}
