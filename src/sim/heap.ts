/**
 * Binary min-heap used as the discrete-event queue.
 * Ordering is (key, priority, insertion order) so runs are fully deterministic:
 * two events at the same timestamp always fire in the same order.
 */
interface Node<T> {
  k: number
  p: number
  s: number
  v: T
}

export class MinHeap<T> {
  private a: Node<T>[] = []
  private seq = 0

  get size(): number {
    return this.a.length
  }

  push(key: number, value: T, priority = 0): void {
    this.a.push({ k: key, p: priority, s: this.seq++, v: value })
    this.up(this.a.length - 1)
  }

  peekKey(): number | undefined {
    return this.a[0]?.k
  }

  pop(): T | undefined {
    const a = this.a
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      this.down(0)
    }
    return top.v
  }

  private less(i: number, j: number): boolean {
    const x = this.a[i]
    const y = this.a[j]
    if (x.k !== y.k) return x.k < y.k
    if (x.p !== y.p) return x.p < y.p
    return x.s < y.s
  }

  private swap(i: number, j: number): void {
    const t = this.a[i]
    this.a[i] = this.a[j]
    this.a[j] = t
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.less(i, parent)) return
      this.swap(i, parent)
      i = parent
    }
  }

  private down(i: number): void {
    const n = this.a.length
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < n && this.less(l, m)) m = l
      if (r < n && this.less(r, m)) m = r
      if (m === i) return
      this.swap(i, m)
      i = m
    }
  }
}
