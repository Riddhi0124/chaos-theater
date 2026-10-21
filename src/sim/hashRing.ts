/**
 * Consistent-hash ring with virtual nodes. Maps a title to the CDN edge that caches it.
 * When an edge goes down, only the titles it owned move (to the next live edge clockwise),
 * so the rest of the fleet keeps its warm cache.
 */
export function hash32(str: string): number {
  // FNV-1a, then a murmur3 finalizer for better avalanche on short keys
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

interface Point {
  h: number
  node: string
}

export class HashRing {
  private points: Point[] = []
  private readonly vnodes: number

  constructor(nodes: string[] = [], vnodes = 120) {
    this.vnodes = vnodes
    for (const n of nodes) this.add(n)
  }

  add(node: string): void {
    for (let v = 0; v < this.vnodes; v++) this.points.push({ h: hash32(`${node}#${v}`), node })
    this.points.sort((a, b) => a.h - b.h || (a.node < b.node ? -1 : 1))
  }

  remove(node: string): void {
    this.points = this.points.filter((p) => p.node !== node)
  }

  /** First node clockwise from hash(key) that passes `isUp`. Binary search + walk. */
  lookup(key: string, isUp: (node: string) => boolean = () => true): string | undefined {
    const pts = this.points
    if (pts.length === 0) return undefined
    const h = hash32(key)
    let lo = 0
    let hi = pts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pts[mid].h < h) lo = mid + 1
      else hi = mid
    }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(lo + i) % pts.length]
      if (isUp(p.node)) return p.node
    }
    return undefined
  }
}
