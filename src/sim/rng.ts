/** Seeded PRNG (mulberry32) so every run can be replayed exactly. */
export class Rng {
  private s: number
  private spare: number | null = null

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  /** Exponential inter-arrival time for a Poisson process with `rate` events per unit. */
  exp(rate: number): number {
    return -Math.log(1 - this.next()) / rate
  }

  normal(): number {
    if (this.spare !== null) {
      const v = this.spare
      this.spare = null
      return v
    }
    let u = 0
    while (u === 0) u = this.next()
    const v = this.next()
    const mag = Math.sqrt(-2 * Math.log(u))
    this.spare = mag * Math.sin(2 * Math.PI * v)
    return mag * Math.cos(2 * Math.PI * v)
  }

  /** Log-normal sample: realistic long-tailed service latency. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal())
  }
}
