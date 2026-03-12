import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { requestLoggingMiddleware } from './requestLogging.js'
import { log } from '../log.js'

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('requestLoggingMiddleware', () => {
  it('uses valid incoming x-request-id and logs request metadata', async () => {
    const app = express()
    const spy = vi.spyOn(log, 'info')

    app.use(requestLoggingMiddleware)
    app.get('/ok', (_req, res) => {
      res.status(200).json({ ok: true })
    })

    const res = await request(app).get('/ok').set('x-request-id', 'abc-123_REQ:test')

    expect(res.status).toBe(200)
    expect(res.headers['x-request-id']).toBe('abc-123_REQ:test')
    expect(spy).toHaveBeenCalledWith(
      'http_request',
      expect.objectContaining({
        request_id: 'abc-123_REQ:test',
        method: 'GET',
        path: '/ok',
        status: 200,
        completed: true,
      })
    )
  })

  it('replaces invalid incoming x-request-id with generated id', async () => {
    const app = express()
    app.use(requestLoggingMiddleware)
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }))

    const res = await request(app).get('/ok').set('x-request-id', 'bad id with spaces')

    expect(res.status).toBe(200)
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]+$/)
    expect(res.headers['x-request-id']).not.toBe('bad id with spaces')
  })
})
