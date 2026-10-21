import { EwmaDetector } from './anomaly'
import { CircuitBreaker, type BreakerState } from './circuitBreaker'
import { MinHeap } from './heap'
import { HashRing } from './hashRing'
import { pickInstance, type LbStrategy } from './loadBalancer'
import { rankRootCauses, type Candidate, type NodeSignal } from './rca'
import { Rng } from './rng'
import { TokenBucket } from './tokenBucket'
import {
  CALLS,
  DEPS,
  EDGE_CACHE_SIZE,
  EDGE_IDS,
  NODES,
  SERVICE_SPECS,
  SERVICES,
  TITLE_COUNT,
  callKey,
  type CallSpec,
  type NodeName,
  type ServiceName,
} from './topology'

// ---------- public types ----------

export interface Settings {
  timeouts: boolean
  retries: boolean
  jitter: boolean
  breakers: boolean
  fallbacks: boolean
  rateLimit: boolean
  lb: LbStrategy
}

export const DEFAULT_SETTINGS: Settings = {
  timeouts: true,
  retries: true,
  jitter: true,
  breakers: true,
  fallbacks: true,
  rateLimit: true,
  lb: 'p2c',
}

export interface ChaosState {
  latency: Partial<Record<ServiceName, number>>
  errorRate: Partial<Record<ServiceName, number>>
  trafficMult: number
  playShare: number
  botRps: number
}

export type Action =
  | { type: 'kill'; svc: ServiceName }
  | { type: 'killEdge' }
  | { type: 'latency'; svc: ServiceName; ms: number }
  | { type: 'errors'; svc: ServiceName; rate: number }
  | { type: 'traffic'; mult: number; playShare?: number }
  | { type: 'bots'; rps: number }
  | { type: 'heal' }
  | { type: 'settings'; patch: Partial<Settings> }

export interface RecordedAction {
  t: number
  action: Action
}

export interface NodeStats {
  req: number
  err: number
  originErr: number
  p50: number
  p99: number
  util: number
}

export interface SecondStats {
  t: number
  legitRps: number
  botRps: number
  throttled: number
  availability: number
  degradedPct: number
  p50: number
  p99: number
  browseRps: number
  playRps: number
  playOk: number
  playFail: number
  browseFail: number
  cacheHit: number
  retries: number
  shortCircuits: number
  fallbacks: number
  nodes: Record<NodeName, NodeStats>
}

export type LogLevel = 'info' | 'good' | 'warn' | 'crit' | 'chaos' | 'security'

export interface LogEntry {
  t: number
  level: LogLevel
  msg: string
}

export interface Incident {
  id: number
  start: number
  end?: number
  rootCause?: NodeName
  candidates: Candidate[]
  scores: Partial<Record<NodeName, number>>
  blast: NodeName[]
  failedPlays: number
  failedBrowse: number
  degraded: number
  minAvailability: number
  breakersOpened: string[]
  trafficSurge?: number
}

export interface InstanceView {
  id: string
  alive: boolean
  registered: boolean
  inflight: number
  queued: number
}

export interface EdgeView {
  id: string
  alive: boolean
  registered: boolean
}

// ---------- internals ----------

interface Req {
  kind: 'browse' | 'play'
  title: number
  legit: boolean
}

interface Result {
  ok: boolean
  origin?: NodeName
  reason?: string
  degraded?: boolean
}

type Cb = (r: Result) => void

interface Pending {
  run: () => void
  fail: () => void
}

interface Instance {
  id: string
  svc: ServiceName
  alive: boolean
  registered: boolean
  inflight: number
  queue: Pending[]
  active: Set<Pending>
  gen: number
}

interface Edge {
  id: string
  alive: boolean
  registered: boolean
  cache: Map<number, true>
}

interface NodeAcc {
  req: number
  err: number
  originErr: number
  lat: number[]
}

interface Acc {
  legit: number
  legitOk: number
  degraded: number
  bot: number
  throttled: number
  browse: number
  play: number
  playOk: number
  playFail: number
  browseFail: number
  e2e: number[]
  cacheHit: number
  cacheMiss: number
  retries: number
  shortCircuits: number
  fallbacks: number
  nodes: Record<NodeName, NodeAcc>
}

const newAcc = (): Acc => ({
  legit: 0,
  legitOk: 0,
  degraded: 0,
  bot: 0,
  throttled: 0,
  browse: 0,
  play: 0,
  playOk: 0,
  playFail: 0,
  browseFail: 0,
  e2e: [],
  cacheHit: 0,
  cacheMiss: 0,
  retries: 0,
  shortCircuits: 0,
  fallbacks: 0,
  nodes: Object.fromEntries(NODES.map((n) => [n, { req: 0, err: 0, originErr: 0, lat: [] }])) as unknown as Record<
    NodeName,
    NodeAcc
  >,
})

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

export const BASE_RPS = 300
const BASE_PLAY_SHARE = 0.25
const BASE_ERROR = 0.0003
const NO_TIMEOUT_MS = 30_000
const CLIENT_TIMEOUT_MS = 4000
const MAX_RETRIES = 2
const RETRY_BASE_MS = 25
const DISCOVERY_LAG_MS = 3000
const LEGIT_CLIENTS = 20_000
const BOT_CLIENTS = 4
const HISTORY = 180
const ACTION_PRIORITY = 1 // replayed actions fire after every other event at the same timestamp

type Ev = () => void

export class Simulator {
  now = 0
  readonly seed: number
  settings: Settings
  chaos: ChaosState = { latency: {}, errorRate: {}, trafficMult: 1, playShare: BASE_PLAY_SHARE, botRps: 0 }
  history: SecondStats[] = []
  log: LogEntry[] = []
  incidents: Incident[] = []
  actions: RecordedAction[] = []
  eventsProcessed = 0

  private q = new MinHeap<Ev>()
  private rng: Rng
  private acc = newAcc()
  private instances: Record<ServiceName, Instance[]>
  private lbState: Record<ServiceName, { rr: number }>
  readonly breakers = new Map<string, CircuitBreaker>()
  private callSpecs = new Map<string, CallSpec>()
  private tripOrigin = new Map<string, NodeName>()
  private limiters = new Map<number, TokenBucket>()
  private ring = new HashRing(EDGE_IDS)
  private edges = new Map<string, Edge>()
  private zipfCdf: Float64Array
  private errDet: Record<NodeName, EwmaDetector>
  private latDet: Record<NodeName, EwmaDetector>
  private missDet = new EwmaDetector({ zThreshold: 4, minAbsolute: 0.25, minRatio: 1.5 })
  private trafficDet = new EwmaDetector({ alpha: 0.05, zThreshold: 5, minRatio: 1.6 })
  private openIncident: Incident | null = null
  private anomalousStreak = 0
  private healthyStreak = 0
  private throttling = false

  constructor(seed = 42, settings: Settings = DEFAULT_SETTINGS, replay: RecordedAction[] = []) {
    this.seed = seed
    this.rng = new Rng(seed)
    this.settings = { ...settings }

    this.instances = Object.fromEntries(
      SERVICES.map((svc) => [
        svc,
        Array.from({ length: SERVICE_SPECS[svc].instances }, (_, i) => ({
          id: `${svc}-${i + 1}`,
          svc,
          alive: true,
          registered: true,
          inflight: 0,
          queue: [],
          active: new Set<Pending>(),
          gen: 0,
        })),
      ]),
    ) as unknown as Record<ServiceName, Instance[]>
    this.lbState = Object.fromEntries(SERVICES.map((s) => [s, { rr: 0 }])) as Record<ServiceName, { rr: number }>

    for (const c of CALLS) {
      const key = callKey(c.from, c.to)
      this.callSpecs.set(key, c)
      this.breakers.set(
        key,
        new CircuitBreaker({}, (from, to, t) => this.onBreaker(key, from, to, t)),
      )
    }

    // Zipf popularity: a few hit titles get most of the views
    this.zipfCdf = new Float64Array(TITLE_COUNT)
    let sum = 0
    for (let i = 0; i < TITLE_COUNT; i++) this.zipfCdf[i] = sum += 1 / (i + 1)
    for (let i = 0; i < TITLE_COUNT; i++) this.zipfCdf[i] /= sum

    // CDN edges start warm: each caches the most popular titles it owns on the ring
    for (const id of EDGE_IDS) this.edges.set(id, { id, alive: true, registered: true, cache: new Map() })
    for (let t = 0; t < TITLE_COUNT; t++) {
      const edge = this.edges.get(this.ring.lookup(String(t))!)!
      if (edge.cache.size < EDGE_CACHE_SIZE) edge.cache.set(t, true)
    }

    const det = (o: ConstructorParameters<typeof EwmaDetector>[0]) =>
      Object.fromEntries(NODES.map((n) => [n, new EwmaDetector(o)])) as Record<NodeName, EwmaDetector>
    this.errDet = det({ zThreshold: 4, minAbsolute: 0.02 })
    this.latDet = det({ zThreshold: 5, minRatio: 2, minAbsolute: 40, sdFloorRatio: 0.12 })

    for (const r of replay) this.q.push(r.t, () => this.dispatch(r.action), ACTION_PRIORITY)

    this.scheduleLegit()
    this.scheduleBots()
    this.at(1000, () => this.tick())
  }

  // ---------- event loop ----------

  private at(t: number, fn: Ev): void {
    this.q.push(t, fn)
  }

  private after(dt: number, fn: Ev): void {
    this.q.push(this.now + dt, fn)
  }

  runUntil(t: number): void {
    while (this.q.size > 0 && this.q.peekKey()! <= t) {
      const key = this.q.peekKey()!
      const fn = this.q.pop()!
      this.now = key
      fn()
      this.eventsProcessed++
    }
    this.now = t
  }

  // ---------- actions (chaos + settings) ----------

  dispatch(action: Action): void {
    this.actions.push({ t: this.now, action })
    switch (action.type) {
      case 'kill': {
        const alive = this.instances[action.svc].filter((i) => i.alive)
        if (alive.length === 0) return
        const inst = alive[this.rng.int(alive.length)]
        this.killInstance(inst)
        this.emit('chaos', `Chaos Monkey terminated ${inst.id}`)
        return
      }
      case 'killEdge': {
        const alive = [...this.edges.values()].filter((e) => e.alive)
        if (alive.length <= 1) return
        const edge = alive[this.rng.int(alive.length)]
        edge.alive = false
        this.emit('chaos', `CDN ${edge.id} went dark`)
        this.after(DISCOVERY_LAG_MS, () => {
          if (edge.alive) return
          edge.registered = false
          this.emit('info', `Steering removed ${edge.id}; its titles re-hash to neighbouring edges`)
        })
        return
      }
      case 'latency':
        this.chaos.latency[action.svc] = action.ms || undefined
        this.emit('chaos', action.ms ? `Injected +${action.ms}ms latency into ${label(action.svc)}` : `Removed latency from ${label(action.svc)}`)
        return
      case 'errors':
        this.chaos.errorRate[action.svc] = action.rate || undefined
        this.emit('chaos', action.rate ? `Injected ${Math.round(action.rate * 100)}% errors into ${label(action.svc)}` : `Removed errors from ${label(action.svc)}`)
        return
      case 'traffic':
        this.chaos.trafficMult = action.mult
        this.chaos.playShare = action.playShare ?? BASE_PLAY_SHARE
        this.emit('chaos', action.mult === 1 ? 'Traffic back to normal' : `Traffic surge: ${action.mult}x members, ${Math.round(this.chaos.playShare * 100)}% pressing play`)
        return
      case 'bots':
        this.chaos.botRps = action.rps
        this.emit('chaos', action.rps ? `Bot flood: ${action.rps} req/s from ${BOT_CLIENTS} clients` : 'Bot traffic stopped')
        return
      case 'heal':
        this.heal()
        return
      case 'settings': {
        this.settings = { ...this.settings, ...action.patch }
        const desc = Object.entries(action.patch)
          .map(([k, v]) => `${k} ${typeof v === 'boolean' ? (v ? 'on' : 'off') : v}`)
          .join(', ')
        this.emit('info', `Config change: ${desc}`)
        return
      }
    }
  }

  private heal(): void {
    this.chaos = { latency: {}, errorRate: {}, trafficMult: 1, playShare: BASE_PLAY_SHARE, botRps: 0 }
    for (const svc of SERVICES) {
      for (const inst of this.instances[svc]) {
        if (inst.alive) continue
        inst.alive = true
        this.after(1000, () => {
          if (inst.alive) inst.registered = true
        })
      }
    }
    for (const e of this.edges.values()) {
      if (e.alive) continue
      e.alive = true
      this.after(1000, () => {
        if (e.alive) e.registered = true
      })
    }
    this.emit('good', 'All chaos cleared; dead instances restarting and re-registering')
  }

  private killInstance(inst: Instance): void {
    inst.alive = false
    inst.gen++
    const doomed = [...inst.active, ...inst.queue]
    inst.active.clear()
    inst.queue = []
    inst.inflight = 0
    for (const p of doomed) this.after(1, p.fail)
    this.after(DISCOVERY_LAG_MS, () => {
      if (inst.alive) return
      inst.registered = false
      this.emit('info', `Discovery evicted ${inst.id} after missed heartbeats`)
    })
  }

  // ---------- traffic ----------

  private scheduleLegit(): void {
    const rate = (BASE_RPS * this.chaos.trafficMult) / 1000
    this.after(this.rng.exp(rate), () => {
      const kind = this.rng.next() < this.chaos.playShare ? 'play' : 'browse'
      this.ingress({ kind, title: this.sampleTitle(), legit: true }, this.rng.int(LEGIT_CLIENTS))
      this.scheduleLegit()
    })
  }

  private scheduleBots(): void {
    if (this.chaos.botRps <= 0) {
      this.after(100, () => this.scheduleBots())
      return
    }
    this.after(this.rng.exp(this.chaos.botRps / 1000), () => {
      if (this.chaos.botRps > 0) {
        this.ingress({ kind: 'browse', title: 0, legit: false }, LEGIT_CLIENTS + this.rng.int(BOT_CLIENTS))
      }
      this.scheduleBots()
    })
  }

  private sampleTitle(): number {
    const u = this.rng.next()
    let lo = 0
    let hi = TITLE_COUNT - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.zipfCdf[mid] < u) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private ingress(req: Req, client: number): void {
    const a = this.acc
    if (req.legit) {
      if (req.kind === 'play') a.play++
      else a.browse++
    } else a.bot++

    if (this.settings.rateLimit) {
      let bucket = this.limiters.get(client)
      if (!bucket) this.limiters.set(client, (bucket = new TokenBucket(20, 10, this.now)))
      if (!bucket.tryTake(this.now)) {
        a.throttled++
        if (req.legit) this.recordE2E(req, { ok: false, reason: 'throttled' }, 0)
        return
      }
    }

    const start = this.now
    let settled = false
    const done = (res: Result) => {
      if (settled) return
      settled = true
      this.observe('gateway', this.now - start, res)
      this.recordE2E(req, res, this.now - start)
    }
    this.after(CLIENT_TIMEOUT_MS, () => done({ ok: false, origin: 'gateway', reason: 'client timeout' }))
    this.invoke('gateway', req, done)
  }

  private recordE2E(req: Req, res: Result, latency: number): void {
    if (!req.legit) return
    const a = this.acc
    a.legit++
    if (res.ok) {
      a.legitOk++
      if (res.degraded) a.degraded++
      a.e2e.push(latency)
    }
    if (req.kind === 'play') {
      if (res.ok) a.playOk++
      else a.playFail++
    } else if (!res.ok) a.browseFail++
  }

  // ---------- service mesh ----------

  /** Route to one instance of `svc`, queue or shed if it's saturated. */
  private invoke(svc: ServiceName, req: Req, cb: Cb): void {
    const spec = SERVICE_SPECS[svc]
    const pool = this.instances[svc].filter((i) => i.registered)
    const inst = pickInstance(pool, this.settings.lb, this.lbState[svc], this.rng)
    if (!inst) return this.after(1, () => cb({ ok: false, origin: svc, reason: 'no healthy instances' }))
    if (!inst.alive) return this.after(3, () => cb({ ok: false, origin: svc, reason: 'connection refused' }))

    const gen = inst.gen
    const entry: Pending = {
      run: () => {
        inst.inflight++
        inst.active.add(entry)
        this.handle(svc, req, (res) => {
          if (inst.gen !== gen) return // instance died mid-request; caller already failed
          inst.active.delete(entry)
          inst.inflight--
          const next = inst.queue.shift()
          if (next) next.run()
          cb(res)
        })
      },
      fail: () => cb({ ok: false, origin: svc, reason: 'instance crashed' }),
    }

    if (inst.inflight < spec.slots) entry.run()
    else if (inst.queue.length < spec.maxQueue) inst.queue.push(entry)
    else this.after(1, () => cb({ ok: false, origin: svc, reason: 'load shed' }))
  }

  /** The work a service does: its own processing, then calls to its dependencies. */
  private handle(svc: ServiceName, req: Req, cb: Cb): void {
    const spec = SERVICE_SPECS[svc]
    const selfMs = this.rng.lognormal(spec.medianMs, spec.sigma) + (this.chaos.latency[svc] ?? 0)
    const fail = this.rng.next() < (this.chaos.errorRate[svc] ?? 0) + BASE_ERROR
    this.after(selfMs, () => {
      if (fail) return cb({ ok: false, origin: svc, reason: '5xx' })
      switch (svc) {
        case 'gateway':
          return this.call('gateway', req.kind === 'play' ? 'playback' : 'home', req, cb)
        case 'home': {
          const results: Result[] = []
          const join = (r: Result) => {
            results.push(r)
            if (results.length < 2) return
            let degraded = false
            for (const r of results) {
              if (r.ok) degraded ||= !!r.degraded
              else if (this.settings.fallbacks) {
                degraded = true
                this.acc.fallbacks++
              } else return cb(r)
            }
            cb({ ok: true, degraded })
          }
          this.call('home', 'profile', req, join)
          this.call('home', 'recs', req, join)
          return
        }
        case 'playback':
          return this.call('playback', 'license', req, (r) => (r.ok ? this.cdnFetch(req, cb) : cb(r)))
        default:
          return cb({ ok: true })
      }
    })
  }

  /** A call between services, wrapped in timeout, circuit breaker and retry-with-backoff. */
  private call(from: ServiceName, to: ServiceName, req: Req, cb: Cb): void {
    const key = callKey(from, to)
    const spec = this.callSpecs.get(key)!
    const br = this.breakers.get(key)!
    const attempt = (n: number) => {
      if (this.settings.breakers && !br.allow(this.now)) {
        this.acc.shortCircuits++
        // the dependency is unavailable to the caller; blame whichever node caused the failures
        // that tripped the breaker (it may sit deeper in the call graph)
        const origin = this.tripOrigin.get(key) ?? to
        const n = this.acc.nodes[to]
        n.req++
        n.err++
        this.acc.nodes[origin].originErr++
        return cb({ ok: false, origin, reason: 'circuit open' })
      }
      const start = this.now
      let settled = false
      const finish = (res: Result) => {
        if (settled) return
        settled = true
        this.observe(to, this.now - start, res)
        if (!res.ok) this.tripOrigin.set(key, res.origin ?? to)
        if (this.settings.breakers) br.record(this.now, res.ok)
        if (!res.ok && this.settings.retries && n < MAX_RETRIES) {
          this.acc.retries++
          const base = RETRY_BASE_MS * 2 ** n
          const delay = this.settings.jitter ? this.rng.next() * base * 2 : base
          return this.after(delay, () => attempt(n + 1))
        }
        cb(res)
      }
      this.after(this.settings.timeouts ? spec.timeoutMs : NO_TIMEOUT_MS, () =>
        finish({ ok: false, origin: to, reason: 'timeout' }),
      )
      this.invoke(to, req, finish)
    }
    attempt(0)
  }

  /** Fetch the video from the CDN edge that owns this title on the consistent-hash ring. */
  private cdnFetch(req: Req, cb: Cb): void {
    const start = this.now
    const id = this.ring.lookup(String(req.title), (e) => this.edges.get(e)!.registered)
    const edge = id ? this.edges.get(id)! : undefined
    const done = (res: Result) => {
      this.observe('cdn', this.now - start, res)
      cb(res)
    }
    if (!edge || !edge.alive) return this.after(5, () => done({ ok: false, origin: 'cdn', reason: 'edge unreachable' }))

    const hit = edge.cache.has(req.title)
    if (hit) {
      edge.cache.delete(req.title) // LRU bump
      this.acc.cacheHit++
    } else {
      this.acc.cacheMiss++
      if (edge.cache.size >= EDGE_CACHE_SIZE) edge.cache.delete(edge.cache.keys().next().value!)
    }
    edge.cache.set(req.title, true)
    const lat = hit ? this.rng.lognormal(12, 0.3) : this.rng.lognormal(140, 0.35)
    this.after(lat, () => done({ ok: true }))
  }

  private observe(node: NodeName, latency: number, res: Result): void {
    const n = this.acc.nodes[node]
    n.req++
    n.lat.push(latency)
    if (!res.ok) {
      n.err++
      if (res.origin === node) n.originErr++
    }
  }

  private onBreaker(key: string, from: BreakerState, to: BreakerState, t: number): void {
    const [a, b] = key.split('->') as ServiceName[]
    const fb = this.callSpecs.get(key)?.fallbackLabel
    if (to === 'open') {
      this.log.push({
        t,
        level: 'warn',
        msg: `Circuit OPEN ${label(a)} → ${label(b)}${fb && this.settings.fallbacks ? `; serving ${fb}` : ''}`,
      })
      this.openIncident?.breakersOpened.includes(key) || this.openIncident?.breakersOpened.push(key)
    } else if (to === 'closed' && from === 'half-open') {
      this.log.push({ t, level: 'good', msg: `Circuit closed ${label(a)} → ${label(b)}; dependency recovered` })
    }
  }

  // ---------- per-second metrics, anomaly detection, incidents ----------

  private tick(): void {
    const a = this.acc
    const nodes = {} as Record<NodeName, NodeStats>
    for (const n of NODES) {
      const na = a.nodes[n]
      nodes[n] = {
        req: na.req,
        err: na.err,
        originErr: na.originErr,
        p50: percentile(na.lat, 0.5),
        p99: percentile(na.lat, 0.99),
        util: n === 'cdn' ? 0 : this.utilization(n),
      }
    }
    const lookups = a.cacheHit + a.cacheMiss
    const s: SecondStats = {
      t: Math.round(this.now / 1000),
      legitRps: a.browse + a.play,
      botRps: a.bot,
      throttled: a.throttled,
      availability: a.legit ? a.legitOk / a.legit : 1,
      degradedPct: a.legitOk ? a.degraded / a.legitOk : 0,
      p50: percentile(a.e2e, 0.5),
      p99: percentile(a.e2e, 0.99),
      browseRps: a.browse,
      playRps: a.play,
      playOk: a.playOk,
      playFail: a.playFail,
      browseFail: a.browseFail,
      cacheHit: lookups ? a.cacheHit / lookups : 1,
      retries: a.retries,
      shortCircuits: a.shortCircuits,
      fallbacks: a.fallbacks,
      nodes,
    }
    this.history.push(s)
    if (this.history.length > HISTORY) this.history.shift()
    this.detect(s)
    this.acc = newAcc()
    this.after(1000, () => this.tick())
  }

  private utilization(svc: ServiceName): number {
    const live = this.instances[svc].filter((i) => i.alive)
    if (!live.length) return 1
    const busy = live.reduce((x, i) => x + i.inflight, 0)
    return busy / (live.length * SERVICE_SPECS[svc].slots)
  }

  private detect(s: SecondStats): void {
    const totalOrigin = NODES.reduce((x, n) => x + s.nodes[n].originErr, 0)
    const sig = {} as Record<NodeName, NodeSignal>
    for (const n of NODES) {
      const ns = s.nodes[n]
      const errRate = ns.req ? ns.originErr / ns.req : 0
      const e = this.errDet[n].update(errRate)
      const l = ns.req >= 5 ? this.latDet[n].update(ns.p99) : { z: 0, anomalous: false, baseline: ns.p99 }
      sig[n] = {
        errRate,
        baseErr: e.baseline,
        errZ: e.z,
        errAnom: e.anomalous,
        p99: ns.p99,
        baseP99: l.baseline,
        latZ: l.z,
        latAnom: l.anomalous,
        originShare: totalOrigin ? ns.originErr / totalOrigin : 0,
        extraZ: 0,
        extraAnom: false,
      }
    }
    const miss = this.missDet.update(1 - s.cacheHit)
    if (miss.anomalous) {
      sig.cdn.extraZ = miss.z
      sig.cdn.extraAnom = true
      sig.cdn.extraLabel = `cache hit ratio fell to ${(s.cacheHit * 100).toFixed(0)}% (baseline ${((1 - miss.baseline) * 100).toFixed(0)}%)`
    }
    const traffic = this.trafficDet.update(s.legitRps + (this.settings.rateLimit ? 0 : s.botRps))

    // security signal: rate limiter actively throttling abusive clients
    if (s.throttled > 20 && !this.throttling) {
      this.throttling = true
      this.emit('security', `Rate limiter throttling ${s.throttled} req/s from abusive clients; members unaffected`)
    } else if (s.throttled <= 5 && this.throttling) {
      this.throttling = false
      this.emit('security', 'Abusive traffic subsided')
    }

    const anomalous = NODES.filter((n) => sig[n].errAnom || sig[n].latAnom || sig[n].extraAnom)
    const sloBreach = s.availability < 0.995 && s.legitRps > 20
    const degradedBreach = s.degradedPct > 0.05 && s.legitRps > 20
    const unhealthy = sloBreach || degradedBreach || anomalous.length > 0
    this.anomalousStreak = unhealthy ? this.anomalousStreak + 1 : 0
    this.healthyStreak = unhealthy ? 0 : this.healthyStreak + 1

    if (!this.openIncident && (sloBreach || degradedBreach || this.anomalousStreak >= 2)) {
      this.openIncident = {
        id: this.incidents.length + 1,
        start: s.t,
        candidates: [],
        scores: {},
        blast: [],
        failedPlays: 0,
        failedBrowse: 0,
        degraded: 0,
        minAvailability: 1,
        breakersOpened: [],
      }
      this.incidents.push(this.openIncident)
      this.emit('crit', `Incident #${this.openIncident.id} opened: ${sloBreach ? `availability ${(s.availability * 100).toFixed(2)}% below 99.5% SLO` : degradedBreach ? `${(s.degradedPct * 100).toFixed(0)}% of members getting a degraded experience` : `anomalies in ${anomalous.map(label).join(', ')}`}`)
    }

    const inc = this.openIncident
    if (!inc) return
    inc.failedPlays += s.playFail
    inc.failedBrowse += s.browseFail
    inc.degraded += Math.round(s.degradedPct * s.legitRps * s.availability)
    inc.minAvailability = Math.min(inc.minAvailability, s.availability)
    for (const n of anomalous) if (!inc.blast.includes(n)) inc.blast.push(n)
    if (traffic.anomalous) inc.trafficSurge = Math.max(inc.trafficSurge ?? 0, s.legitRps / Math.max(1, traffic.baseline))

    const ranked = rankRootCauses(sig, DEPS)
    for (const c of ranked) inc.scores[c.node] = (inc.scores[c.node] ?? 0) + c.score
    if (ranked.length) inc.candidates = ranked
    const best = (Object.entries(inc.scores) as [NodeName, number][]).sort((x, y) => y[1] - x[1])[0]?.[0]
    if (best && best !== inc.rootCause) {
      inc.rootCause = best
      this.emit('warn', `RCA: most likely root cause is ${label(best)}`)
    }

    if (this.healthyStreak >= 5) {
      inc.end = s.t
      this.openIncident = null
      this.emit('good', `Incident #${inc.id} resolved after ${inc.end - inc.start}s`)
    }
  }

  private emit(level: LogLevel, msg: string): void {
    this.log.push({ t: this.now, level, msg })
    if (this.log.length > 300) this.log.shift()
  }

  // ---------- views for the UI ----------

  instanceViews(svc: ServiceName): InstanceView[] {
    return this.instances[svc].map((i) => ({
      id: i.id,
      alive: i.alive,
      registered: i.registered,
      inflight: i.inflight,
      queued: i.queue.length,
    }))
  }

  edgeViews(): EdgeView[] {
    return [...this.edges.values()].map((e) => ({ id: e.id, alive: e.alive, registered: e.registered }))
  }

  breakerState(from: string, to: string): BreakerState {
    return this.breakers.get(callKey(from, to))?.state ?? 'closed'
  }
}

const label = (n: NodeName) => (n === 'cdn' ? 'CDN' : SERVICE_SPECS[n].label)
