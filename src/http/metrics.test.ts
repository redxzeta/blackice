import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestLoggingMiddleware } from './requestLogging.js'
import { renderPrometheusMetrics, resetHttpMetrics } from './metrics.js'

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
})
