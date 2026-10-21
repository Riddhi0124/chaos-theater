import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, Simulator, type Action, type Settings } from './sim/simulator'
import { LB_LABELS, type LbStrategy } from './sim/loadBalancer'
import { SERVICES, SERVICE_SPECS, type ServiceName } from './sim/topology'
import { LineChart } from './ui/LineChart'
import { Topology } from './ui/Topology'
import { EventLog, IncidentPanel } from './ui/IncidentPanel'
import { StatusPill, type Status } from './ui/status'

const SCENARIOS: { name: string; blurb: string; actions: () => Action[] }[] = [
  {
    name: 'Recommendations slowdown',
    blurb: 'Recs gets 800ms slower. Without timeouts and breakers, the whole homepage, and playback with it, goes down.',
    actions: () => [{ type: 'latency', svc: 'recs', ms: 800 }],
  },
  {
    name: 'Premiere night',
    blurb: '3x traffic and half of members press play at once.',
    actions: () => [{ type: 'traffic', mult: 3, playShare: 0.5 }],
  },
  {
    name: 'License errors',
    blurb: '40% of DRM license calls fail. Playback has no fallback.',
    actions: () => [{ type: 'errors', svc: 'license', rate: 0.4 }],
  },
  {
    name: 'CDN edge outage',
    blurb: 'Two edges go dark. Consistent hashing moves only their titles.',
    actions: () => [{ type: 'killEdge' }, { type: 'killEdge' }],
  },
  {
    name: 'Bot flood',
    blurb: '1,500 req/s of scraping from 4 clients hit the gateway.',
    actions: () => [{ type: 'bots', rps: 1500 }],
  },
  {
    name: 'Chaos Monkey',
    blurb: 'Terminate one random instance anywhere in the fleet.',
    actions: () => [{ type: 'kill', svc: SERVICES[Math.floor(Math.random() * SERVICES.length)] }],
  },
]

const TOGGLES: { key: keyof Omit<Settings, 'lb'>; label: string; hint: string }[] = [
  { key: 'timeouts', label: 'Timeouts', hint: 'give up on slow dependencies' },
  { key: 'retries', label: 'Retries', hint: 'up to 2, exponential backoff' },
  { key: 'jitter', label: 'Backoff jitter', hint: 'spread retries out to avoid storms' },
  { key: 'breakers', label: 'Circuit breakers', hint: 'stop calling a failing dependency' },
  { key: 'fallbacks', label: 'Fallbacks', hint: 'degrade instead of failing' },
  { key: 'rateLimit', label: 'Rate limiting', hint: 'token bucket per client at the gateway' },
]

const FRAGILE: Partial<Settings> = { timeouts: false, jitter: false, breakers: false, fallbacks: false, rateLimit: false }

const LATENCIES = [0, 200, 500, 1000]
const ERROR_RATES = [0, 0.1, 0.4, 1]

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`

export default function App() {
  const [seed, setSeed] = useState(42)
  const simRef = useRef(new Simulator(seed))
  const [running, setRunning] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const [target, setTarget] = useState<ServiceName>('recs')
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      const sim = simRef.current
      sim.runUntil(sim.now + 100 * speed)
      rerender()
    }, 100)
    return () => clearInterval(id)
  }, [running, speed])

  const sim = simRef.current
  const dispatch = useCallback((a: Action) => {
    simRef.current.dispatch(a)
    rerender()
  }, [])

  const restart = (replay: boolean) => {
    const old = simRef.current
    simRef.current = replay ? new Simulator(old.seed, DEFAULT_SETTINGS, old.actions) : new Simulator(seed)
    setRunning(true)
    rerender()
  }

  const h = sim.history
  const last = h[h.length - 1]
  const recent = h.slice(-5)
  const avg = (f: (s: (typeof h)[number]) => number) =>
    recent.length ? recent.reduce((x, s) => x + f(s), 0) / recent.length : 0
  const availability = recent.length
    ? recent.reduce((x, s) => x + s.availability * s.legitRps, 0) / Math.max(1, recent.reduce((x, s) => x + s.legitRps, 0))
    : 1
  const plays = recent.reduce((x, s) => x + s.playOk + s.playFail, 0)
  const playOk = plays ? recent.reduce((x, s) => x + s.playOk, 0) / plays : 1
  const t = h.map((s) => s.t)

  const kpis: { label: string; value: string; status: Status; note: string }[] = [
    {
      label: 'Member availability',
      value: pct(availability, 2),
      status: availability >= 0.999 ? 'good' : availability >= 0.99 ? 'warning' : 'critical',
      note: 'SLO 99.9%',
    },
    {
      label: 'Play starts succeeding',
      value: pct(playOk, 1),
      status: playOk >= 0.999 ? 'good' : playOk >= 0.98 ? 'warning' : 'critical',
      note: `${Math.round(avg((s) => s.playRps))} plays/s`,
    },
    {
      label: 'p99 latency',
      value: `${Math.round(avg((s) => s.p99))}ms`,
      status: avg((s) => s.p99) < 300 ? 'good' : avg((s) => s.p99) < 1000 ? 'warning' : 'critical',
      note: `p50 ${Math.round(avg((s) => s.p50))}ms`,
    },
    {
      label: 'Degraded responses',
      value: pct(avg((s) => s.degradedPct), 1),
      status: avg((s) => s.degradedPct) < 0.01 ? 'good' : 'warning',
      note: 'served by fallback',
    },
    {
      label: 'Abusive req blocked',
      value: `${Math.round(avg((s) => s.throttled))}/s`,
      status: 'good',
      note: sim.settings.rateLimit ? 'rate limiter on' : 'rate limiter off',
    },
  ]

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>Chaos Theater</h1>
          <p>A resilience lab for a streaming platform. Break things, watch the system defend itself.</p>
        </div>
        <div className="transport">
          <button className="btn primary" onClick={() => setRunning((r) => !r)}>
            {running ? '❚❚ Pause' : '▶ Run'}
          </button>
          <div className="seg" role="group" aria-label="Simulation speed">
            {[1, 2, 5].map((s) => (
              <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
                {s}x
              </button>
            ))}
          </div>
          <span className="clock" title="Simulated time">
            t = {Math.floor(sim.now / 1000)}s
          </span>
          <label className="seed">
            seed
            <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} />
          </label>
          <button className="btn" onClick={() => restart(false)}>
            ↺ Restart
          </button>
          <button
            className="btn"
            onClick={() => restart(true)}
            disabled={sim.actions.length === 0}
            title="Re-run from t=0 with the same seed and the same chaos at the same moments; the timeline reproduces exactly"
          >
            ⟲ Replay run
          </button>
        </div>
      </header>

      <section className="kpis">
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-foot">
              <StatusPill status={k.status} />
              <span>{k.note}</span>
            </div>
          </div>
        ))}
      </section>

      <main className="grid">
        <div className="col-main">
          <section className="card">
            <div className="card-head">
              <h2>Live topology</h2>
              <span className="muted">
                {sim.eventsProcessed.toLocaleString()} events simulated · LB: {LB_LABELS[sim.settings.lb]}
              </span>
            </div>
            <Topology sim={sim} last={last} />
            <div className="key">
              <span><i className="k inst-up" /> instance up</span>
              <span><i className="k inst-zombie" /> dead, discovery not yet aware</span>
              <span><i className="k inst-dead" /> evicted</span>
              <span><i className="k util" /> thread pool use</span>
            </div>
          </section>

          <section className="card charts">
            <LineChart
              title="Member availability"
              unit="%"
              t={t}
              series={[{ name: 'Availability', color: 'var(--series-1)', values: h.map((s) => s.availability * 100) }]}
              fmt={(v) => `${v.toFixed(v >= 99 ? 1 : 0)}`}
              domain={[Math.max(0, Math.floor(Math.min(99, ...h.map((s) => s.availability * 100)) - 0.5)), 100]}
              refLine={{ y: 99.9, label: 'SLO' }}
            />
            <LineChart
              title="p99 latency"
              unit="ms"
              t={t}
              series={[{ name: 'p99', color: 'var(--series-1)', values: h.map((s) => s.p99) }]}
              fmt={(v) => `${Math.round(v)}`}
            />
            <LineChart
              title="Requests per second"
              t={t}
              series={[
                { name: 'Browse', color: 'var(--series-1)', values: h.map((s) => s.browseRps) },
                { name: 'Play', color: 'var(--series-2)', values: h.map((s) => s.playRps) },
                { name: 'Blocked', color: 'var(--series-3)', values: h.map((s) => s.throttled) },
              ]}
              fmt={(v) => `${Math.round(v)}`}
            />
            <LineChart
              title="Resilience activity"
              unit="per s"
              t={t}
              series={[
                { name: 'Retries', color: 'var(--series-1)', values: h.map((s) => s.retries) },
                { name: 'Fallbacks', color: 'var(--series-2)', values: h.map((s) => s.fallbacks) },
                { name: 'Short-circuits', color: 'var(--series-3)', values: h.map((s) => s.shortCircuits) },
              ]}
              fmt={(v) => `${Math.round(v)}`}
            />
            <button className="link-btn" onClick={() => setShowTable((x) => !x)}>
              {showTable ? 'Hide' : 'Show'} data table
            </button>
            {showTable && (
              <table className="data">
                <thead>
                  <tr>
                    <th>t</th>
                    <th>Availability</th>
                    <th>p99</th>
                    <th>Browse/s</th>
                    <th>Play/s</th>
                    <th>Blocked/s</th>
                    <th>Cache hit</th>
                  </tr>
                </thead>
                <tbody>
                  {h.slice(-10).reverse().map((s) => (
                    <tr key={s.t}>
                      <td>{s.t}s</td>
                      <td>{pct(s.availability, 2)}</td>
                      <td>{Math.round(s.p99)}ms</td>
                      <td>{s.browseRps}</td>
                      <td>{s.playRps}</td>
                      <td>{s.throttled}</td>
                      <td>{pct(s.cacheHit, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <aside className="col-side">
          <section className="card">
            <h2>Scenarios</h2>
            <div className="scenarios">
              {SCENARIOS.map((s) => (
                <button key={s.name} className="scenario" onClick={() => s.actions().forEach(dispatch)}>
                  <b>{s.name}</b>
                  <span>{s.blurb}</span>
                </button>
              ))}
            </div>
            <button className="btn heal" onClick={() => dispatch({ type: 'heal' })}>
              ✚ Heal everything
            </button>
          </section>

          <section className="card">
            <h2>Manual chaos</h2>
            <label className="field">
              Target
              <select value={target} onChange={(e) => setTarget(e.target.value as ServiceName)}>
                {SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_SPECS[s].label}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              Added latency
              <div className="seg">
                {LATENCIES.map((ms) => (
                  <button
                    key={ms}
                    className={(sim.chaos.latency[target] ?? 0) === ms ? 'on' : ''}
                    onClick={() => dispatch({ type: 'latency', svc: target, ms })}
                  >
                    {ms ? `+${ms}` : 'none'}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              Error rate
              <div className="seg">
                {ERROR_RATES.map((rate) => (
                  <button
                    key={rate}
                    className={(sim.chaos.errorRate[target] ?? 0) === rate ? 'on' : ''}
                    onClick={() => dispatch({ type: 'errors', svc: target, rate })}
                  >
                    {rate ? pct(rate, 0) : 'none'}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn danger" onClick={() => dispatch({ type: 'kill', svc: target })}>
              ⚡ Kill an instance
            </button>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Resilience patterns</h2>
              <div className="seg small">
                <button onClick={() => dispatch({ type: 'settings', patch: { ...DEFAULT_SETTINGS } })}>All on</button>
                <button onClick={() => dispatch({ type: 'settings', patch: FRAGILE })}>Fragile</button>
              </div>
            </div>
            {TOGGLES.map((tg) => (
              <label key={tg.key} className="toggle">
                <input
                  type="checkbox"
                  checked={sim.settings[tg.key]}
                  onChange={(e) => dispatch({ type: 'settings', patch: { [tg.key]: e.target.checked } })}
                />
                <span className="switch" aria-hidden />
                <span>
                  <b>{tg.label}</b>
                  <small>{tg.hint}</small>
                </span>
              </label>
            ))}
            <label className="field">
              Load balancing
              <select
                value={sim.settings.lb}
                onChange={(e) => dispatch({ type: 'settings', patch: { lb: e.target.value as LbStrategy } })}
              >
                {(Object.keys(LB_LABELS) as LbStrategy[]).map((k) => (
                  <option key={k} value={k}>
                    {LB_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          </section>
        </aside>

        <section className="card">
          <h2>Incident analysis</h2>
          <IncidentPanel incidents={sim.incidents} now={sim.now} />
        </section>
        <section className="card">
          <h2>Event log</h2>
          <EventLog log={sim.log} />
        </section>
      </main>
      <footer className="foot">
        Discrete-event simulation in TypeScript: min-heap event queue, seeded RNG for exact replay, token-bucket rate
        limiting, circuit breakers, consistent hashing, EWMA anomaly detection and trace-based root-cause ranking.
      </footer>
    </div>
  )
}
