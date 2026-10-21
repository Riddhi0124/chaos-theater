import { useEffect, useRef, useState } from 'react'

export interface Series {
  name: string
  color: string
  values: number[]
}

interface Props {
  title: string
  unit?: string
  t: number[]
  series: Series[]
  fmt: (v: number) => string
  domain?: [number, number]
  refLine?: { y: number; label: string }
  height?: number
}

const PAD = { top: 12, right: 64, bottom: 22, left: 44 }

function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6))
  return out
}

export function LineChart({ title, unit, t, series, fmt, domain, refLine, height = 170 }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const all = series.flatMap((s) => s.values)
  let [lo, hi] = domain ?? [Math.min(0, ...all), Math.max(1, ...all) * 1.15]
  if (refLine && !domain) hi = Math.max(hi, refLine.y * 1.1)
  if (hi <= lo) hi = lo + 1
  const n = Math.max(t.length, 2)
  const iw = width - PAD.left - PAD.right
  const ih = height - PAD.top - PAD.bottom
  const x = (i: number) => PAD.left + (i / (n - 1)) * iw
  const y = (v: number) => PAD.top + ih - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * ih
  const ticks = niceTicks(lo, hi)
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * width
    const i = Math.round(((px - PAD.left) / iw) * (n - 1))
    setHover(t.length ? Math.min(t.length - 1, Math.max(0, i)) : null)
  }

  // direct labels at line ends, nudged apart so they don't collide
  const ends = series
    .map((s) => ({ s, yy: y(s.values[s.values.length - 1] ?? 0) }))
    .sort((a, b) => a.yy - b.yy)
  for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 13) ends[i].yy = ends[i - 1].yy + 13

  return (
    <figure className="chart" ref={wrap}>
      <figcaption>
        <span className="chart-title">{title}</span>
        {unit && <span className="chart-unit">{unit}</span>}
        {series.length > 1 && (
          <span className="legend">
            {series.map((s) => (
              <span key={s.name} className="legend-item">
                <i style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${title} over the last ${t.length} seconds`}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.left} x2={PAD.left + iw} y1={y(v)} y2={y(v)} />
            <text className="axis" x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end">
              {fmt(v)}
            </text>
          </g>
        ))}
        {t.length > 1 && (
          <>
            <text className="axis" x={PAD.left} y={height - 6}>
              {t[0]}s
            </text>
            <text className="axis" x={PAD.left + iw} y={height - 6} textAnchor="end">
              {t[t.length - 1]}s
            </text>
          </>
        )}
        {refLine && (
          <g>
            <line className="ref" x1={PAD.left} x2={PAD.left + iw} y1={y(refLine.y)} y2={y(refLine.y)} />
            <text className="axis" x={PAD.left + iw + 6} y={y(refLine.y) + 3.5}>
              {refLine.label}
            </text>
          </g>
        )}
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} fill="none" style={{ stroke: s.color }} strokeWidth={2} strokeLinejoin="round" />
        ))}
        {series.length > 1 &&
          ends.map(({ s, yy }) => (
            <text key={s.name} className="direct-label" x={PAD.left + iw + 6} y={yy + 3.5}>
              {s.name}
            </text>
          ))}
        {hover !== null && (
          <g>
            <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} />
            {series.map((s) => (
              <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r={4} style={{ fill: s.color }} className="hover-dot" />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          className="tooltip"
          style={{ left: Math.min(x(hover) + 10, width - 150), top: PAD.top }}
        >
          <div className="tooltip-t">t = {t[hover]}s</div>
          {series.map((s) => (
            <div key={s.name} className="tooltip-row">
              <i style={{ background: s.color }} />
              <span>{s.name}</span>
              <b>{fmt(s.values[hover])}</b>
            </div>
          ))}
        </div>
      )}
    </figure>
  )
}
