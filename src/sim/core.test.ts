import { describe, expect, it } from 'vitest'
import { EwmaDetector } from './anomaly'
import { CircuitBreaker } from './circuitBreaker'
import { HashRing } from './hashRing'
import { MinHeap } from './heap'
import { pickInstance } from './loadBalancer'
import { rankRootCauses, type NodeSignal } from './rca'
import { Rng } from './rng'
import { TokenBucket } from './tokenBucket'
import { DEPS, NODES, type NodeName } from './topology'

describe('MinHeap', () => {
  it('pops in key order and breaks ties by priority then insertion', () => {
    const h = new MinHeap<string>()
    const rng = new Rng(1)
    const keys = Array.from({ length: 500 }, () => rng.int(100))
    keys.forEach((k, i) => h.push(k, `${k}:${i}`))
    let prev = -1
    while (h.size) {
      const k = Number(h.pop()!.split(':')[0])
      expect(k).toBeGreaterThanOrEqual(prev)
      prev = k
    }
    h.push(5, 'late-priority', 1)
    h.push(5, 'a')
    h.push(5, 'b')
    expect([h.pop(), h.pop(), h.pop()]).toEqual(['a', 'b', 'late-priority'])
  })
})

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refills at the configured rate', () => {
    const b = new TokenBucket(5, 10, 0)
    for (let i = 0; i < 5; i++) expect(b.tryTake(0)).toBe(true)
    expect(b.tryTake(0)).toBe(false)
    expect(b.tryTake(100)).toBe(true) // 100ms * 10/s = 1 token
    expect(b.tryTake(100)).toBe(false)
  })
})

describe('CircuitBreaker', () => {
  it('opens on high failure rate, short-circuits, then recovers via half-open probes', () => {
    const transitions: string[] = []
    const br = new CircuitBreaker({ minCalls: 10, windowSize: 10, openMs: 1000, halfOpenProbes: 3 }, (_f, to) =>
      transitions.push(to),
    )
    for (let i = 0; i < 10; i++) br.record(0, i % 2 === 0) // 50% failures
    expect(br.state).toBe('open')
    expect(br.allow(500)).toBe(false)
    expect(br.allow(1000)).toBe(true) // half-open probe
    expect(br.state).toBe('half-open')
    br.allow(1000)
    br.allow(1000)
    expect(br.allow(1000)).toBe(false) // only 3 probes
    br.record(1001, true)
    br.record(1001, true)
    br.record(1001, true)
    expect(br.state).toBe('closed')
    expect(transitions).toEqual(['open', 'half-open', 'closed'])
  })

  it('re-opens if a half-open probe fails', () => {
    const br = new CircuitBreaker({ minCalls: 4, windowSize: 4, openMs: 100 })
    for (let i = 0; i < 4; i++) br.record(0, false)
    br.allow(200)
    br.record(200, false)
    expect(br.state).toBe('open')
  })

  it('stays closed under a low background error rate', () => {
    const br = new CircuitBreaker()
    for (let i = 0; i < 1000; i++) br.record(i, i % 20 !== 0) // 5% errors
    expect(br.state).toBe('closed')
  })
})

describe('HashRing', () => {
  const nodes = ['edge-1', 'edge-2', 'edge-3', 'edge-4', 'edge-5', 'edge-6']
  const keys = Array.from({ length: 20000 }, (_, i) => String(i))

  it('spreads keys roughly evenly across nodes', () => {
    const ring = new HashRing(nodes)
    const counts = new Map<string, number>()
    for (const k of keys) counts.set(ring.lookup(k)!, (counts.get(ring.lookup(k)!) ?? 0) + 1)
    for (const n of nodes) expect(counts.get(n)! / keys.length).toBeGreaterThan(0.11) // ideal 0.167
  })

  it('only remaps keys owned by the failed node', () => {
    const ring = new HashRing(nodes)
    const before = keys.map((k) => ring.lookup(k))
    const after = keys.map((k) => ring.lookup(k, (n) => n !== 'edge-3'))
    let moved = 0
    keys.forEach((_, i) => {
      if (before[i] !== after[i]) {
        moved++
        expect(before[i]).toBe('edge-3')
      }
    })
    expect(moved / keys.length).toBeLessThan(0.25) // ~1/6, vs ~5/6 for modulo hashing
  })
})

describe('load balancer', () => {
  it('power-of-two-choices keeps load more even than random', () => {
    const rng = new Rng(7)
    const pool = Array.from({ length: 10 }, () => ({ inflight: 0, queue: [] as unknown[] }))
    for (let i = 0; i < 5000; i++) {
      pickInstance(pool, 'p2c', { rr: 0 }, rng)!.inflight++
      pool[rng.int(10)].inflight = Math.max(0, pool[rng.int(10)].inflight - 1) // random completions
    }
    const loads = pool.map((p) => p.inflight)
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThan(Math.max(...loads) * 0.5 + 5)
  })

  it('least-outstanding picks the idlest instance', () => {
    const pool = [3, 1, 2].map((n) => ({ inflight: n, queue: [] as unknown[] }))
    expect(pickInstance(pool, 'least-outstanding', { rr: 0 }, new Rng(1))).toBe(pool[1])
  })
})

describe('EwmaDetector', () => {
  it('ignores noise and flags a sustained step change', () => {
    const rng = new Rng(3)
    const d = new EwmaDetector({ zThreshold: 4 })
    for (let i = 0; i < 60; i++) expect(d.update(100 + rng.normal() * 5).anomalous).toBe(false)
    expect(d.update(400).anomalous).toBe(true)
    expect(d.update(400).anomalous).toBe(true) // baseline frozen during anomaly
  })
})

describe('rankRootCauses', () => {
  const quiet = (): NodeSignal => ({
    errRate: 0, baseErr: 0, errZ: 0, errAnom: false, p99: 50, baseP99: 50, latZ: 0, latAnom: false,
    originShare: 0, extraZ: 0, extraAnom: false,
  })
  it('blames the deepest slow service, not the callers that are slow because of it', () => {
    const sig = Object.fromEntries(NODES.map((n) => [n, quiet()])) as Record<NodeName, NodeSignal>
    for (const n of ['gateway', 'home', 'recs'] as NodeName[]) Object.assign(sig[n], { latAnom: true, latZ: 20, p99: 900 })
    const ranked = rankRootCauses(sig, DEPS)
    expect(ranked[0].node).toBe('recs')
    expect(ranked.map((c) => c.node)).not.toContain('home')
  })
})
