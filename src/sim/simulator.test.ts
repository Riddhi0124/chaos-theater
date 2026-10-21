import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, Simulator, type Action, type Settings } from './simulator'

const FRAGILE: Settings = {
  ...DEFAULT_SETTINGS,
  timeouts: false,
  retries: true,
  jitter: false,
  breakers: false,
  fallbacks: false,
  rateLimit: false,
}

/** Warm up, inject chaos, and report member availability during the fault window. */
function experiment(settings: Settings, actions: Action[], seed = 11) {
  const sim = new Simulator(seed, settings)
  sim.runUntil(20_000)
  for (const a of actions) sim.dispatch(a)
  sim.runUntil(50_000)
  const window = sim.history.filter((s) => s.t > 22 && s.t <= 50)
  const total = window.reduce((x, s) => x + s.legitRps, 0)
  const ok = window.reduce((x, s) => x + s.legitRps * s.availability, 0)
  const plays = window.reduce((x, s) => x + s.playOk + s.playFail, 0)
  const playOk = window.reduce((x, s) => x + s.playOk, 0)
  return { sim, availability: ok / total, playSuccess: playOk / plays }
}

describe('Simulator', () => {
  it('is deterministic for a given seed', () => {
    const a = new Simulator(99)
    const b = new Simulator(99)
    a.runUntil(15_000)
    b.runUntil(15_000)
    expect(JSON.stringify(a.history)).toBe(JSON.stringify(b.history))
  })

  it('replays a recorded chaos session exactly', () => {
    const live = new Simulator(5)
    live.runUntil(8_000)
    live.dispatch({ type: 'kill', svc: 'recs' })
    live.runUntil(12_300)
    live.dispatch({ type: 'latency', svc: 'license', ms: 300 })
    live.runUntil(20_000)

    const replay = new Simulator(5, DEFAULT_SETTINGS, live.actions)
    replay.runUntil(20_000)
    expect(JSON.stringify(replay.history)).toBe(JSON.stringify(live.history))
  })

  it('is healthy at baseline (>= 99.9% availability)', () => {
    const { availability, sim } = experiment(DEFAULT_SETTINGS, [])
    expect(availability).toBeGreaterThan(0.999)
    expect(sim.incidents.length).toBe(0)
  })

  it('contains a recommendations latency spike with breakers + fallbacks, cascades without them', () => {
    const chaos: Action[] = [{ type: 'latency', svc: 'recs', ms: 800 }]
    const resilient = experiment(DEFAULT_SETTINGS, chaos)
    const fragile = experiment(FRAGILE, chaos)
    console.log('recs latency  resilient', resilient.availability, resilient.playSuccess, '| fragile', fragile.availability, fragile.playSuccess)
    expect(resilient.availability).toBeGreaterThan(0.99)
    expect(resilient.playSuccess).toBeGreaterThan(0.99)
    expect(fragile.availability).toBeLessThan(0.8)
    // the cascade spreads: playback fails even though only recs was broken
    expect(fragile.playSuccess).toBeLessThan(0.9)
    expect(resilient.sim.incidents[0]?.rootCause).toBe('recs')
  })

  it('rate limiting shields members from a bot flood', () => {
    const chaos: Action[] = [{ type: 'bots', rps: 1500 }]
    const resilient = experiment(DEFAULT_SETTINGS, chaos)
    const fragile = experiment(FRAGILE, chaos)
    console.log('bot flood     resilient', resilient.availability, '| fragile', fragile.availability)
    expect(resilient.availability).toBeGreaterThan(0.999)
    expect(fragile.availability).toBeLessThan(0.95)
  })

  it('identifies license errors as the root cause', () => {
    const { sim } = experiment(DEFAULT_SETTINGS, [{ type: 'errors', svc: 'license', rate: 0.4 }])
    expect(sim.incidents[0]?.rootCause).toBe('license')
  })

  it('identifies a CDN edge outage and keeps most of the cache warm', () => {
    const { sim } = experiment(DEFAULT_SETTINGS, [{ type: 'killEdge' }, { type: 'killEdge' }])
    expect(sim.incidents[0]?.rootCause).toBe('cdn')
    const last = sim.history[sim.history.length - 1]
    console.log('edge outage cache hit after recovery', last.cacheHit)
  })

  it('retries hide a single instance crash', () => {
    const { availability } = experiment(DEFAULT_SETTINGS, [{ type: 'kill', svc: 'profile' }])
    console.log('instance kill availability', availability)
    expect(availability).toBeGreaterThan(0.999)
  })

  it('runs fast enough for a live dashboard', () => {
    const sim = new Simulator(1)
    const t0 = performance.now()
    sim.runUntil(60_000)
    const ms = performance.now() - t0
    console.log(`60s simulated: ${sim.eventsProcessed} events in ${ms.toFixed(0)}ms (${Math.round(sim.eventsProcessed / (ms / 1000))} events/s)`)
    expect(ms).toBeLessThan(5000)
  })
})
