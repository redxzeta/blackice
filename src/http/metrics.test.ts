import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordLlmRequest, renderPrometheusMetrics, resetHttpMetrics } from './metrics.js'
import { requestLoggingMiddleware } from './requestLogging.js'

describe('http metrics', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetHttpMetrics()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetHttpMetrics()
  })

  it('exports request counters, histogram, and inflight gauge in Prometheus format', async () => {
    const app = express()
    app.use(requestLoggingMiddleware)
    app.get('/widgets/:id', async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      res.status(201).json({ ok: true })
    })

    const res = await request(app).get('/widgets/123')

    expect(res.status).toBe(201)

    const output = renderPrometheusMetrics()
    expect(output).toContain('# TYPE blackice_http_requests_total counter')
    expect(output).toContain(
      'blackice_http_requests_total{route="/widgets/:id",method="GET",status="201"} 1'
    )
    expect(output).toContain(
      'blackice_http_request_duration_ms_bucket{route="/widgets/:id",method="GET",le="+Inf"} 1'
    )
    expect(output).toContain(
      'blackice_http_request_duration_ms_count{route="/widgets/:id",method="GET"} 1'
    )
    expect(output).toContain('blackice_inflight_requests{route="/widgets/:id"} 0')
  })

  it('collapses unmatched requests into a bounded route label', async () => {
    const app = express()
    app.use(requestLoggingMiddleware)

    const res = await request(app).get('/does-not-exist/123')

    expect(res.status).toBe(404)

    const output = renderPrometheusMetrics()
    expect(output).toContain(
      'blackice_http_requests_total{route="/__unmatched__",method="GET",status="404"} 1'
    )
    expect(output).not.toContain('/does-not-exist/123')
  })

  it('exports LLM request counters and latency histograms by model and status', () => {
    recordLlmRequest('qwen2.5:14b', 'success', 125)
    recordLlmRequest('qwen2.5:14b', 'failure', 250)

    const output = renderPrometheusMetrics()

    expect(output).toContain('# TYPE llm_request_total counter')
    expect(output).toContain('# TYPE llm_request_latency_seconds histogram')
    expect(output).toContain('llm_request_total{model="qwen2.5:14b",status="success"} 1')
    expect(output).toContain('llm_request_total{model="qwen2.5:14b",status="failure"} 1')
    expect(output).toContain('llm_request_latency_seconds_bucket{model="qwen2.5:14b",le="+Inf"} 2')
    expect(output).toContain('llm_request_latency_seconds_count{model="qwen2.5:14b"} 2')
  })
})
