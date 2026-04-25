type RequestMetricKey = {
  route: string
  method: string
}

type CounterKey = RequestMetricKey & {
  status: string
}

const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
const LLM_HISTOGRAM_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]
export const HTTP_METRICS_PENDING_ROUTE = '/__pending__'
export const HTTP_METRICS_UNMATCHED_ROUTE = '/__unmatched__'

const requestCounters = new Map<string, number>()
const durationSums = new Map<string, number>()
const durationCounts = new Map<string, number>()
const durationBuckets = new Map<string, number[]>()
const inflightRequests = new Map<string, number>()
const llmRequestCounters = new Map<string, number>()
const llmDurationSums = new Map<string, number>()
const llmDurationCounts = new Map<string, number>()
const llmDurationBuckets = new Map<string, number[]>()
const preflightCounters = new Map<string, number>()
const executionLifecycleCounters = new Map<string, number>()
const repositoryErrorCounters = new Map<string, number>()

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

function llmKey(model: string, status: string): string {
  return metricKey([model, status])
}

function llmModelKey(model: string): string {
  return metricKey([model])
}

function preflightKey(outcome: 'pass' | 'fail'): string {
  return metricKey([outcome])
}

function executionLifecycleKey(stage: string, outcome: string, reason: string): string {
  return metricKey([stage, outcome, reason])
}

function repositoryErrorKey(operation: string, storageKind: string): string {
  return metricKey([operation, storageKind])
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

function getLlmHistogramBucketCounts(model: string): number[] {
  const key = llmModelKey(model)
  const existing = llmDurationBuckets.get(key)
  if (existing) {
    return existing
  }

  const created = Array.from({ length: LLM_HISTOGRAM_BUCKETS_SECONDS.length }, () => 0)
  llmDurationBuckets.set(key, created)
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

function parseLlmKey(key: string): { model: string; status: string } {
  const [model, status] = key.split('\u0000')
  return { model, status }
}

function parseLlmModelKey(key: string): { model: string } {
  const [model] = key.split('\u0000')
  return { model }
}

function parsePreflightKey(key: string): { outcome: string } {
  const [outcome] = key.split('\u0000')
  return { outcome }
}

function parseExecutionLifecycleKey(key: string): {
  stage: string
  outcome: string
  reason: string
} {
  const [stage, outcome, reason] = key.split('\u0000')
  return { stage, outcome, reason }
}

function parseRepositoryErrorKey(key: string): { operation: string; storageKind: string } {
  const [operation, storageKind] = key.split('\u0000')
  return { operation, storageKind }
}

export function beginHttpRequest(route: string): void {
  inflightRequests.set(route, (inflightRequests.get(route) ?? 0) + 1)
}

export function recordHttpRequest(
  route: string,
  method: string,
  status: number,
  latencyMs: number
): void {
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

export function recordLlmRequest(
  model: string,
  status: 'success' | 'failure',
  latencyMs: number
): void {
  const normalizedModel = model.trim() || '<unknown>'
  const latencySeconds = Math.max(0, latencyMs) / 1000
  const requestKey = llmKey(normalizedModel, status)
  llmRequestCounters.set(requestKey, (llmRequestCounters.get(requestKey) ?? 0) + 1)

  const modelMetricKey = llmModelKey(normalizedModel)
  llmDurationSums.set(modelMetricKey, (llmDurationSums.get(modelMetricKey) ?? 0) + latencySeconds)
  llmDurationCounts.set(modelMetricKey, (llmDurationCounts.get(modelMetricKey) ?? 0) + 1)

  const bucketCounts = getLlmHistogramBucketCounts(normalizedModel)
  for (const [index, bucket] of LLM_HISTOGRAM_BUCKETS_SECONDS.entries()) {
    if (latencySeconds <= bucket) {
      bucketCounts[index] += 1
    }
  }
}

export function recordPreflightResult(outcome: 'pass' | 'fail'): void {
  const key = preflightKey(outcome)
  preflightCounters.set(key, (preflightCounters.get(key) ?? 0) + 1)
}

export function recordExecutionLifecycle(
  stage: 'preflight_gate' | 'signing' | 'placement' | 'refresh' | 'cancel',
  outcome:
    | 'allowed'
    | 'blocked'
    | 'success'
    | 'failure'
    | 'accepted'
    | 'rejected'
    | 'placed'
    | 'filled'
    | 'cancelled'
    | 'failed',
  reason:
    | 'ok'
    | 'preflight_required'
    | 'preflight_failed'
    | 'preflight_mismatch'
    | 'preflight_stale'
    | 'intent_expired'
    | 'invalid_state'
    | 'adapter_error'
    | 'venue_status'
): void {
  const key = executionLifecycleKey(stage, outcome, reason)
  executionLifecycleCounters.set(key, (executionLifecycleCounters.get(key) ?? 0) + 1)
}

export function recordRepositoryError(
  operation: 'create' | 'read' | 'write' | 'readiness_check',
  storageKind: 'memory' | 'file' | 'other'
): void {
  const key = repositoryErrorKey(operation, storageKind)
  repositoryErrorCounters.set(key, (repositoryErrorCounters.get(key) ?? 0) + 1)
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
    lines.push(
      `blackice_inflight_requests{route="${escapeLabelValue(route)}"} ${inflightRequests.get(route) ?? 0}`
    )
  }

  lines.push(
    '# HELP llm_request_total Total LLM requests by model and status.',
    '# TYPE llm_request_total counter'
  )

  const sortedLlmCounterEntries = [...llmRequestCounters.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )
  for (const [key, value] of sortedLlmCounterEntries) {
    const { model, status } = parseLlmKey(key)
    lines.push(
      `llm_request_total{model="${escapeLabelValue(model)}",status="${escapeLabelValue(status)}"} ${value}`
    )
  }

  lines.push(
    '# HELP llm_request_latency_seconds LLM request latency histogram in seconds.',
    '# TYPE llm_request_latency_seconds histogram'
  )

  const sortedLlmDurationEntries = [...llmDurationCounts.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )
  for (const [key, count] of sortedLlmDurationEntries) {
    const { model } = parseLlmModelKey(key)
    const bucketCounts = getLlmHistogramBucketCounts(model)
    for (const [index, bucket] of LLM_HISTOGRAM_BUCKETS_SECONDS.entries()) {
      lines.push(
        `llm_request_latency_seconds_bucket{model="${escapeLabelValue(model)}",le="${bucket}"} ${bucketCounts[index]}`
      )
    }
    lines.push(
      `llm_request_latency_seconds_bucket{model="${escapeLabelValue(model)}",le="+Inf"} ${count}`
    )
    lines.push(
      `llm_request_latency_seconds_sum{model="${escapeLabelValue(model)}"} ${(llmDurationSums.get(key) ?? 0).toFixed(6)}`
    )
    lines.push(`llm_request_latency_seconds_count{model="${escapeLabelValue(model)}"} ${count}`)
  }

  lines.push(
    '# HELP blackice_preflight_total Total persisted preflight results by bounded outcome.',
    '# TYPE blackice_preflight_total counter'
  )

  const sortedPreflightEntries = [...preflightCounters.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )
  for (const [key, value] of sortedPreflightEntries) {
    const { outcome } = parsePreflightKey(key)
    lines.push(`blackice_preflight_total{outcome="${escapeLabelValue(outcome)}"} ${value}`)
  }

  lines.push(
    '# HELP blackice_execution_lifecycle_total Total execution lifecycle events by bounded stage, outcome, and reason.',
    '# TYPE blackice_execution_lifecycle_total counter'
  )

  const sortedExecutionEntries = [...executionLifecycleCounters.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )
  for (const [key, value] of sortedExecutionEntries) {
    const { stage, outcome, reason } = parseExecutionLifecycleKey(key)
    lines.push(
      `blackice_execution_lifecycle_total{stage="${escapeLabelValue(stage)}",outcome="${escapeLabelValue(outcome)}",reason="${escapeLabelValue(reason)}"} ${value}`
    )
  }

  lines.push(
    '# HELP blackice_repository_errors_total Total execution repository errors by bounded operation and storage kind.',
    '# TYPE blackice_repository_errors_total counter'
  )

  const sortedRepositoryEntries = [...repositoryErrorCounters.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )
  for (const [key, value] of sortedRepositoryEntries) {
    const { operation, storageKind } = parseRepositoryErrorKey(key)
    lines.push(
      `blackice_repository_errors_total{operation="${escapeLabelValue(operation)}",storage_kind="${escapeLabelValue(storageKind)}"} ${value}`
    )
  }

  return `${lines.join('\n')}\n`
}

export function resetHttpMetrics(): void {
  requestCounters.clear()
  durationSums.clear()
  durationCounts.clear()
  durationBuckets.clear()
  inflightRequests.clear()
  llmRequestCounters.clear()
  llmDurationSums.clear()
  llmDurationCounts.clear()
  llmDurationBuckets.clear()
  preflightCounters.clear()
  executionLifecycleCounters.clear()
  repositoryErrorCounters.clear()
}
