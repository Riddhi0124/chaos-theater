/**
 * Count-based circuit breaker (closed -> open -> half-open), in the style of Hystrix / resilience4j.
 * - closed: calls flow; failures tracked in a sliding window of the last `windowSize` calls
 * - open: calls short-circuit to the fallback for `openMs`
 * - half-open: a few probe calls test whether the dependency recovered
 */
export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerOptions {
  windowSize: number
  minCalls: number
  failureThreshold: number
  openMs: number
  halfOpenProbes: number
}

export const DEFAULT_BREAKER: BreakerOptions = {
  windowSize: 40,
  minCalls: 20,
  failureThreshold: 0.5,
  openMs: 4000,
  halfOpenProbes: 5,
}

export class CircuitBreaker {
  state: BreakerState = 'closed'
  private window: boolean[] = []
  private failures = 0
  private openedAt = 0
  private probesIssued = 0
  private probeSuccesses = 0
  private readonly opts: BreakerOptions
  private readonly onChange?: (from: BreakerState, to: BreakerState, now: number) => void

  constructor(opts: Partial<BreakerOptions> = {}, onChange?: (from: BreakerState, to: BreakerState, now: number) => void) {
    this.onChange = onChange
    this.opts = { ...DEFAULT_BREAKER, ...opts }
  }

  get failureRate(): number {
    return this.window.length ? this.failures / this.window.length : 0
  }

  allow(now: number): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      if (now - this.openedAt < this.opts.openMs) return false
      this.transition('half-open', now)
      this.probesIssued = 0
      this.probeSuccesses = 0
    }
    if (this.probesIssued < this.opts.halfOpenProbes) {
      this.probesIssued++
      return true
    }
    return false
  }

  record(now: number, ok: boolean): void {
    if (this.state === 'open') return
    if (this.state === 'half-open') {
      if (!ok) return this.trip(now)
      if (++this.probeSuccesses >= this.opts.halfOpenProbes) this.close(now)
      return
    }
    this.window.push(ok)
    if (!ok) this.failures++
    if (this.window.length > this.opts.windowSize && !this.window.shift()) this.failures--
    if (this.window.length >= this.opts.minCalls && this.failureRate >= this.opts.failureThreshold) {
      this.trip(now)
    }
  }

  private trip(now: number): void {
    this.openedAt = now
    this.transition('open', now)
  }

  private close(now: number): void {
    this.window = []
    this.failures = 0
    this.transition('closed', now)
  }

  private transition(to: BreakerState, now: number): void {
    if (to === this.state) return
    const from = this.state
    this.state = to
    this.onChange?.(from, to, now)
  }
}
