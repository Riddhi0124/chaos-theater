export type ServiceName = 'gateway' | 'home' | 'playback' | 'profile' | 'recs' | 'license'
export type NodeName = ServiceName | 'cdn'

export const SERVICES: ServiceName[] = ['gateway', 'home', 'playback', 'profile', 'recs', 'license']
export const NODES: NodeName[] = [...SERVICES, 'cdn']

export interface ServiceSpec {
  label: string
  instances: number
  /** concurrent requests per instance (thread pool size) */
  slots: number
  /** queued requests per instance before load shedding */
  maxQueue: number
  medianMs: number
  sigma: number
}

export const SERVICE_SPECS: Record<ServiceName, ServiceSpec> = {
  gateway: { label: 'API Gateway', instances: 3, slots: 32, maxQueue: 64, medianMs: 2, sigma: 0.3 },
  home: { label: 'Home API', instances: 3, slots: 16, maxQueue: 32, medianMs: 5, sigma: 0.3 },
  playback: { label: 'Playback API', instances: 3, slots: 16, maxQueue: 32, medianMs: 4, sigma: 0.3 },
  profile: { label: 'Profile', instances: 3, slots: 12, maxQueue: 24, medianMs: 8, sigma: 0.4 },
  recs: { label: 'Recommender', instances: 3, slots: 12, maxQueue: 24, medianMs: 35, sigma: 0.5 },
  license: { label: 'License (DRM)', instances: 2, slots: 10, maxQueue: 20, medianMs: 20, sigma: 0.4 },
}

export const NODE_LABELS: Record<NodeName, string> = {
  ...Object.fromEntries(SERVICES.map((s) => [s, SERVICE_SPECS[s].label])),
  cdn: 'CDN Edges',
} as Record<NodeName, string>

/** Service dependency graph (who calls whom). */
export const DEPS: Record<NodeName, NodeName[]> = {
  gateway: ['home', 'playback'],
  home: ['profile', 'recs'],
  playback: ['license', 'cdn'],
  profile: [],
  recs: [],
  license: [],
  cdn: [],
}

export interface CallSpec {
  from: ServiceName
  to: ServiceName
  timeoutMs: number
  /** can the caller degrade gracefully if this dependency fails? */
  hasFallback: boolean
  fallbackLabel?: string
}

export const CALLS: CallSpec[] = [
  { from: 'gateway', to: 'home', timeoutMs: 1000, hasFallback: false },
  { from: 'gateway', to: 'playback', timeoutMs: 1500, hasFallback: false },
  { from: 'home', to: 'profile', timeoutMs: 150, hasFallback: true, fallbackLabel: 'default profile' },
  { from: 'home', to: 'recs', timeoutMs: 250, hasFallback: true, fallbackLabel: 'cached popular titles' },
  { from: 'playback', to: 'license', timeoutMs: 400, hasFallback: false },
]

export const callKey = (from: string, to: string) => `${from}->${to}`

export const EDGE_IDS = ['edge-1', 'edge-2', 'edge-3', 'edge-4', 'edge-5', 'edge-6']
export const TITLE_COUNT = 2000
export const EDGE_CACHE_SIZE = 380
