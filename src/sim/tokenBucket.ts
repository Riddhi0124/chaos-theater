/** Token-bucket rate limiter (per client), refilled lazily on each request. */
export class TokenBucket {
  private tokens: number
  private last: number
  readonly capacity: number
  readonly refillPerSec: number

  constructor(capacity: number, refillPerSec: number, now = 0) {
    this.capacity = capacity
    this.refillPerSec = refillPerSec
    this.tokens = capacity
    this.last = now
  }

  tryTake(now: number, n = 1): boolean {
    const elapsed = Math.max(0, now - this.last)
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSec)
    this.last = now
    if (this.tokens >= n) {
      this.tokens -= n
      return true
    }
    return false
  }
}
