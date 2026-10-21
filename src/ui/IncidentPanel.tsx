import type { Incident, LogEntry } from '../sim/simulator'
import { NODE_LABELS } from '../sim/topology'
import { StatusPill } from './status'

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function summary(inc: Incident, now: number): string {
  const dur = (inc.end ?? Math.floor(now / 1000)) - inc.start
  const root = inc.rootCause ? NODE_LABELS[inc.rootCause] : 'an unidentified component'
  const parts = [
    `${inc.end ? 'Over' : 'For the last'} ${dur}s, ${root} was the most likely root cause.`,
  ]
  const symptoms = inc.blast.filter((n) => n !== inc.rootCause).map((n) => NODE_LABELS[n])
  if (symptoms.length) parts.push(`Knock-on effects reached ${symptoms.join(', ')}.`)
  if (inc.trafficSurge) parts.push(`It coincided with a ${inc.trafficSurge.toFixed(1)}x traffic surge.`)
  const impact: string[] = []
  if (inc.failedPlays) impact.push(`${inc.failedPlays.toLocaleString()} failed play starts`)
  if (inc.failedBrowse) impact.push(`${inc.failedBrowse.toLocaleString()} failed page loads`)
  if (inc.degraded) impact.push(`${inc.degraded.toLocaleString()} degraded but successful responses`)
  parts.push(impact.length ? `Member impact: ${impact.join(', ')}.` : 'No member-visible failures.')
  if (inc.breakersOpened.length)
    parts.push(`Circuit breakers on ${inc.breakersOpened.map((k) => k.replace('->', ' → ')).join(', ')} isolated the fault.`)
  parts.push(`Lowest availability: ${(inc.minAvailability * 100).toFixed(2)}%.`)
  return parts.join(' ')
}

export function IncidentPanel({ incidents, now }: { incidents: Incident[]; now: number }) {
  const current = incidents[incidents.length - 1]
  if (!current)
    return (
      <div className="empty">
        <StatusPill status="good">No incidents</StatusPill>
        <p>Inject a failure and the detector opens an incident, ranks likely root causes, and writes up the impact.</p>
      </div>
    )
  const top = current.candidates.find((c) => c.node === current.rootCause)
  return (
    <div className="incident">
      <div className="incident-head">
        <h3>Incident #{current.id}</h3>
        {current.end ? <StatusPill status="good">Resolved</StatusPill> : <StatusPill status="critical">Open</StatusPill>}
        <span className="muted">started t={current.start}s</span>
      </div>
      <div className="rca">
        <div className="rca-label">Likely root cause</div>
        <div className="rca-node">{current.rootCause ? NODE_LABELS[current.rootCause] : 'Analysing…'}</div>
        {top && (
          <ul>
            {top.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="impact-grid">
        <div>
          <b>{current.failedPlays.toLocaleString()}</b>
          <span>failed play starts</span>
        </div>
        <div>
          <b>{current.failedBrowse.toLocaleString()}</b>
          <span>failed page loads</span>
        </div>
        <div>
          <b>{current.degraded.toLocaleString()}</b>
          <span>served by fallback</span>
        </div>
        <div>
          <b>{(current.minAvailability * 100).toFixed(2)}%</b>
          <span>lowest availability</span>
        </div>
      </div>
      <p className="summary">{summary(current, now)}</p>
      {incidents.length > 1 && (
        <details>
          <summary>Earlier incidents ({incidents.length - 1})</summary>
          <ul className="past">
            {incidents
              .slice(0, -1)
              .reverse()
              .map((i) => (
                <li key={i.id}>
                  #{i.id} t={i.start}s, {i.end ? `${i.end - i.start}s` : 'open'}:{' '}
                  {i.rootCause ? NODE_LABELS[i.rootCause] : 'unknown'}, {i.failedPlays} failed plays
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  )
}

const LEVEL_ICON: Record<LogEntry['level'], string> = {
  info: '•',
  good: '✓',
  warn: '!',
  crit: '✕',
  chaos: '⚡',
  security: '⛨',
}

export function EventLog({ log }: { log: LogEntry[] }) {
  return (
    <ol className="log">
      {log
        .slice(-60)
        .reverse()
        .map((e, i) => (
          <li key={`${e.t}-${i}-${e.msg}`} className={`log-${e.level}`}>
            <span className="log-t">{clock(e.t)}</span>
            <span className="log-icon" aria-hidden>
              {LEVEL_ICON[e.level]}
            </span>
            <span>{e.msg}</span>
          </li>
        ))}
    </ol>
  )
}
