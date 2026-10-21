import type { SecondStats, Simulator } from '../sim/simulator'
import { CALLS, NODE_LABELS, SERVICES, type NodeName, type ServiceName } from '../sim/topology'
import { StatusBadge, nodeStatus } from './status'

const W = 162
const H = 62
const POS: Record<NodeName | 'members', [number, number]> = {
  members: [70, 170],
  gateway: [250, 170],
  home: [450, 92],
  playback: [450, 250],
  profile: [670, 42],
  recs: [670, 128],
  license: [670, 214],
  cdn: [670, 300],
}

const EDGES: [NodeName | 'members', NodeName][] = [
  ['members', 'gateway'],
  ...CALLS.map((c) => [c.from, c.to] as [NodeName, NodeName]),
  ['playback', 'cdn'],
]

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`

export function Topology({ sim, last }: { sim: Simulator; last?: SecondStats }) {
  return (
    <svg className="topology" viewBox="0 0 760 340" role="img" aria-label="Service topology with live health">
      {EDGES.map(([from, to]) => {
        const [x1, y1] = POS[from]
        const [x2, y2] = POS[to]
        const sx = from === 'members' ? x1 + 34 : x1 + W / 2
        const ex = x2 - W / 2
        const mx = (sx + ex) / 2
        const st = from === 'members' ? 'closed' : sim.breakerState(from, to)
        const ns = last?.nodes[to]
        const failing = ns && ns.req > 0 && ns.err / ns.req > 0.05
        return (
          <g key={`${from}-${to}`}>
            <path
              d={`M${sx},${y1} C${mx},${y1} ${mx},${y2} ${ex},${y2}`}
              className={`link ${failing ? 'link-bad' : ''} ${st === 'open' ? 'link-cut' : 'flow'}`}
            />
            {st !== 'closed' && (
              <g transform={`translate(${mx},${(y1 + y2) / 2})`}>
                <rect x={-34} y={-10} width={68} height={20} rx={10} className={`breaker breaker-${st}`} />
                <text textAnchor="middle" y={4} className="breaker-text">
                  {st === 'open' ? '⏸ OPEN' : '◐ PROBING'}
                </text>
              </g>
            )}
          </g>
        )
      })}

      <g transform={`translate(${POS.members[0]},${POS.members[1]})`}>
        <circle r={32} className="members" />
        <text textAnchor="middle" y={-2} className="node-title">
          Members
        </text>
        <text textAnchor="middle" y={13} className="node-meta">
          {last ? `${last.legitRps} rps` : '—'}
        </text>
        {last && last.botRps > 0 && (
          <text textAnchor="middle" y={52} className="node-meta bot">
            +{last.botRps} bot rps
          </text>
        )}
      </g>

      {SERVICES.map((svc) => (
        <ServiceNode key={svc} svc={svc} sim={sim} last={last} />
      ))}
      <CdnNode sim={sim} last={last} />
    </svg>
  )
}

function Frame({ node, last, children }: { node: NodeName; last?: SecondStats; children: React.ReactNode }) {
  const [cx, cy] = POS[node]
  const ns = last?.nodes[node]
  const status = nodeStatus(ns)
  return (
    <g transform={`translate(${cx - W / 2},${cy - H / 2})`}>
      <rect width={W} height={H} rx={10} className={`node node-${status}`} />
      <text x={10} y={18} className="node-title">
        {NODE_LABELS[node]}
      </text>
      <StatusBadge status={status} x={W - 10} y={18} />
      {children}
      <text x={10} y={54} className="node-meta">
        {ns ? `${ns.req} rps · ${pct(ns.req ? ns.err / ns.req : 0)} err · p99 ${Math.round(ns.p99)}ms` : '—'}
      </text>
    </g>
  )
}

function ServiceNode({ svc, sim, last }: { svc: ServiceName; sim: Simulator; last?: SecondStats }) {
  const insts = sim.instanceViews(svc)
  const util = last?.nodes[svc].util ?? 0
  return (
    <Frame node={svc} last={last}>
      {insts.map((i, k) => (
        <g key={i.id} transform={`translate(${16 + k * 18},34)`}>
          <title>
            {i.id}: {i.alive ? (i.registered ? 'up' : 'rejoining') : i.registered ? 'dead, discovery not yet aware' : 'dead, evicted'} ·{' '}
            {i.inflight} in flight, {i.queued} queued
          </title>
          <circle r={6} className={`inst ${i.alive ? (i.registered ? 'inst-up' : 'inst-joining') : i.registered ? 'inst-zombie' : 'inst-dead'}`} />
          {!i.alive && <path d="M-3,-3L3,3M3,-3L-3,3" className="inst-x" />}
        </g>
      ))}
      <g transform={`translate(${W - 58},29)`}>
        <rect width={48} height={8} rx={4} className="util-bg" />
        <rect width={Math.max(4, 48 * Math.min(1, util))} height={8} rx={4} className={`util ${util > 0.85 ? 'util-hot' : ''}`} />
        <title>Thread pool utilisation {pct(util)}</title>
      </g>
    </Frame>
  )
}

function CdnNode({ sim, last }: { sim: Simulator; last?: SecondStats }) {
  return (
    <Frame node="cdn" last={last}>
      {sim.edgeViews().map((e, k) => (
        <g key={e.id} transform={`translate(${16 + k * 15},34)`}>
          <title>
            {e.id}: {e.alive ? (e.registered ? 'serving' : 'rejoining') : e.registered ? 'down, still receiving traffic' : 'down, removed from ring'}
          </title>
          <rect x={-5} y={-5} width={10} height={10} rx={2} className={`inst ${e.alive ? (e.registered ? 'inst-up' : 'inst-joining') : e.registered ? 'inst-zombie' : 'inst-dead'}`} />
        </g>
      ))}
      <text x={W - 10} y={38} textAnchor="end" className="node-meta">
        {last ? `hit ${pct(last.cacheHit)}` : ''}
      </text>
    </Frame>
  )
}
