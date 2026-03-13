type RequestMetricKey = {
  route: string
  method: string
}

type CounterKey = RequestMetricKey & {
  status: string
}

const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]

const requestCounters = new Map<string, number>()
const durationSums = new Map<string, number>()
const durationCounts = new Map<string, number>()
const durationBuckets = new Map<string, number[]>()
const inflightRequests = new Map<string, number>()

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}

function metricKey(parts: string[]): string {
  return parts.join('\u0000')
}

function routeKey(route: string, method: string): string {
  return metricKey([route, method])
}

function counterKey(route: string, method: string, status: string): string {
  return metricKey([route, method, status])
}

function getHistogramBucketCounts(route: string, method: string): number[] {
  const key = routeKey(route, method)
  const existing = durationBuckets.get(key)
  if (existing) {
    return existing
  }

  const created = Array.from({ length: HISTOGRAM_BUCKETS_MS.length }, () => 0)
  durationBuckets.set(key, created)
  return created
}

function parseCounterKey(key: string): CounterKey {
  const [route, method, status] = key.split('\u0000')
  return { route, method, status }
}

function parseRouteKey(key: string): RequestMetricKey {
  const [route, method] = key.split('\u0000')
  return { route, method }
}

export function beginHttpRequest(route: string): void {
  inflightRequests.set(route, (inflightRequests.get(route) ?? 0) + 1)
}

export function recordHttpRequest(route: string, method: string, status: number, latencyMs: number): void {
  const normalizedStatus = String(status)
  requestCounters.set(
    counterKey(route, method, normalizedStatus),
    (requestCounters.get(counterKey(route, method, normalizedStatus)) ?? 0) + 1
  )

  const routeMetricKey = routeKey(route, method)
  durationSums.set(routeMetricKey, (durationSums.get(routeMetricKey) ?? 0) + latencyMs)
  durationCounts.set(routeMetricKey, (durationCounts.get(routeMetricKey) ?? 0) + 1)

  const bucketCounts = getHistogramBucketCounts(route, method)
  for (const [index, bucket] of HISTOGRAM_BUCKETS_MS.entries()) {
    if (latencyMs <= bucket) {
      bucketCounts[index] += 1
    }
  }
}

export function endHttpRequest(route: string): void {
  const current = inflightRequests.get(route) ?? 0
  if (current <= 1) {
    inflightRequests.delete(route)
    return
  }
  inflightRequests.set(route, current - 1)
}

export function renderPrometheusMetrics(): string {
  const lines: string[] = [
    '# HELP blackice_http_requests_total Total HTTP requests by route, method, and status.',
    '# TYPE blackice_http_requests_total counter',
  ]

  const sortedCounterEntries = [...requestCounters.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [key, value] of sortedCounterEntries) {
    const { route, method, status } = parseCounterKey(key)
    lines.push(
      `blackice_http_requests_total{route="${escapeLabelValue(route)}",method="${escapeLabelValue(method)}",status="${escapeLabelValue(status)}"} ${value}`
    )
  }

  lines.push(
    '# HELP blackice_http_request_duration_ms Request duration histogram in milliseconds.',
    '# TYPE blackice_http_request_duration_ms histogram'
  )

  const sortedDurationEntries = [...durationCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [key, count] of sortedDurationEntries) {
    const { route, method } = parseRouteKey(key)
    const bucketCounts = getHistogramBucketCounts(route, method)
    for (const [index, bucket] of HISTOGRAM_BUCKETS_MS.entries()) {
      lines.push(
        `blackice_http_request_duration_ms_bucket{route="${escapeLabelValue(route)}",method="${escapeLabelValue(method)}",le="${bucket}"} ${bucketCounts[index]}`
      )
    }
    lines.push(
      `blackice_http_request_duration_ms_bucket{route="${escapeLabelValue(route)}",method="${escapeLabelValue(method)}",le="+Inf"} ${count}`
    )
    lines.push(
      `blackice_http_request_duration_ms_sum{route="${escapeLabelValue(route)}",method="${escapeLabelValue(method)}"} ${(durationSums.get(key) ?? 0).toFixed(3)}`
    )
    lines.push(
      `blackice_http_request_duration_ms_count{route="${escapeLabelValue(route)}",method="${escapeLabelValue(method)}"} ${count}`
    )
  }

  lines.push(
    '# HELP blackice_inflight_requests Current in flight HTTP requests by route.',
    '# TYPE blackice_inflight_requests gauge'
  )

  const knownRoutes = new Set<string>([
    ...[...inflightRequests.keys()],
    ...[...durationCounts.keys()].map((key) => parseRouteKey(key).route),
  ])
  const sortedRoutes = [...knownRoutes].sort((a, b) => a.localeCompare(b))
  for (const route of sortedRoutes) {
    lines.push(`blackice_inflight_requests{route="${escapeLabelValue(route)}"} ${inflightRequests.get(route) ?? 0}`)
  }

  return `${lines.join('\n')}\n`
}

export function resetHttpMetrics(): void {
  requestCounters.clear()
  durationSums.clear()
  durationCounts.clear()
  durationBuckets.clear()
  inflightRequests.clear()
}
