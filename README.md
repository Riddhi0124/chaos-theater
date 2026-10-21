# Chaos Theater

A resilience lab for a streaming platform. It simulates a microservice backend (API gateway, home page, playback, profile, recommendations, DRM license, CDN edges), lets you inject failures in the style of Chaos Monkey, and shows the system defending itself with timeouts, retries, circuit breakers, fallbacks and rate limiting. An anomaly detector opens incidents automatically, ranks the likely root cause and writes up the member impact.

Everything runs in the browser. There is no backend to deploy.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 20 unit + simulation tests
npm run build    # static site in dist/ (deploy to GitHub Pages, Vercel or Netlify)
```

## What to try

1. Click **Fragile** (turns resilience patterns off), then **Recommendations slowdown**. Recommendations gets 800ms slower, gateway threads fill up waiting on it, and playback fails too even though nothing is wrong with playback.
2. Click **All on**. Breakers open, the homepage falls back to cached popular titles, and availability recovers within seconds.
3. Open **Incident analysis**: the root cause is identified as Recommender, with evidence and impact (failed play starts, degraded responses).
4. Click **Replay run**. The same seed plus the recorded chaos actions reproduce the exact same timeline, event for event.

## Results (from the test suite, seed 11, 30s fault window)

| Scenario | Resilience on | Resilience off |
|---|---|---|
| Recommendations +800ms | 99.98% availability, 100% play starts | 5.8% availability, 18% play starts |
| 1,500 req/s bot flood | 99.95% availability | 52% availability |
| One instance killed | 99.95% availability | |
| Two of six CDN edges down | 92% cache hit ratio after rehash | |

Root cause is identified correctly for the recommendations slowdown, license errors and the CDN outage.

The engine processes about 2 million events per second (60 simulated seconds ≈ 156k events in about 65ms).

## How it works

| Piece | Implementation | File |
|---|---|---|
| Event loop | Discrete-event simulation on a binary min-heap, ordered by (time, priority, sequence) for determinism | `src/sim/heap.ts` |
| Randomness | Seeded mulberry32 PRNG, Poisson arrivals, log-normal latencies, Zipf title popularity | `src/sim/rng.ts` |
| Load balancing | Round robin, least outstanding, power of two choices | `src/sim/loadBalancer.ts` |
| Service discovery | Dead instances keep receiving traffic until missed heartbeats evict them (3s) | `src/sim/simulator.ts` |
| Circuit breaker | Count-based sliding window; closed, open and half-open with probe calls | `src/sim/circuitBreaker.ts` |
| Retries | Exponential backoff with optional full jitter (turn jitter off to see retry storms) | `src/sim/simulator.ts` |
| Bulkheads and load shedding | Per-instance thread pool and bounded queue | `src/sim/simulator.ts` |
| Rate limiting | Token bucket per client at the gateway | `src/sim/tokenBucket.ts` |
| CDN steering | Consistent-hash ring with virtual nodes and LRU edge caches; an edge failure moves only that edge's titles | `src/sim/hashRing.ts` |
| Anomaly detection | Streaming EWMA mean/variance z-score per service, baseline frozen during anomalies | `src/sim/anomaly.ts` |
| Root-cause analysis | Trace-based error attribution (the deepest failing span), plus "slow while its dependencies are healthy" | `src/sim/rca.ts` |
| UI | React and TypeScript, hand-built SVG topology and charts with hover tooltips, light and dark themes, data table view | `src/ui/` |

## Design notes

- **Callers measure their dependencies.** Node metrics are recorded at the call site, the way client-side telemetry works, so a timeout is attributed to the slow callee rather than the caller that gave up.
- **Short circuits blame the real origin.** When a breaker is open, the failure is charged to whatever caused the breaker to trip, which may be deeper in the graph. Without this, the gateway → playback breaker would make Playback look guilty for License errors.
- **Detectors don't learn incidents.** The EWMA baseline stops updating while a signal is anomalous, so a long outage isn't absorbed as the new normal.
- **Replay is exact.** Replayed actions get a lower priority than simulation events at the same timestamp, which matches when a live click lands between animation frames. A test checks that the replayed history is byte-identical to the live one.
