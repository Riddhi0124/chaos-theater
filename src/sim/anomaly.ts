/**
 * Streaming anomaly detector: exponentially weighted mean and variance, flagging points
 * whose z-score crosses a threshold. While a point is anomalous the baseline is frozen,
 * so a long incident does not teach the detector that "broken" is normal.
 */
export interface DetectorOptions {
  alpha: number
  warmup: number
  zThreshold: number
  /** value must also be at least this large (filters noise on tiny baselines) */
  minAbsolute: number
  /** value must also be at least baseline * minRatio */
  minRatio: number
  /** floor on std-dev as a fraction of the mean, so near-constant series don't explode */
  sdFloorRatio: number
}

export interface Detection {
  z: number
  anomalous: boolean
  baseline: number
}

export class EwmaDetector {
  private mean = 0
  private variance = 0
  private n = 0
  private readonly o: DetectorOptions

  constructor(opts: Partial<DetectorOptions> = {}) {
    this.o = {
      alpha: 0.1,
      warmup: 10,
      zThreshold: 4,
      minAbsolute: 0,
      minRatio: 0,
      sdFloorRatio: 0.05,
      ...opts,
    }
  }

  update(x: number): Detection {
    if (this.n === 0) {
      this.mean = x
      this.n = 1
      return { z: 0, anomalous: false, baseline: x }
    }
    const sd = Math.max(Math.sqrt(this.variance), Math.abs(this.mean) * this.o.sdFloorRatio, 1e-4)
    const z = (x - this.mean) / sd
    const baseline = this.mean
    const anomalous =
      this.n >= this.o.warmup &&
      z >= this.o.zThreshold &&
      x >= this.o.minAbsolute &&
      x >= baseline * this.o.minRatio
    if (!anomalous) {
      const diff = x - this.mean
      const inc = this.o.alpha * diff
      this.mean += inc
      this.variance = (1 - this.o.alpha) * (this.variance + diff * inc)
    }
    this.n++
    return { z, anomalous, baseline }
  }
}
