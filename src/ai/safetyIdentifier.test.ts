import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { resolveSafetyIdentifier } from './safetyIdentifier.js';

function mockRequest(headers: Record<string, string> = {}, ip?: string): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    ip
  } as unknown as Request;
}

describe('resolveSafetyIdentifier', () => {
  it('uses explicit user first and hashes the value', () => {
    const value = resolveSafetyIdentifier({
      request: mockRequest({ 'x-user-id': 'header-user' }),
      explicitUser: 'body-user',
      requestId: 'req-1'
    });

    expect(value).toMatch(/^usr_[a-f0-9]{24}$/);
    const fromHeader = resolveSafetyIdentifier({
      request: mockRequest({ 'x-user-id': 'header-user' }),
      explicitUser: undefined,
      requestId: 'req-1'
    });
    expect(value).not.toBe(fromHeader);
  });

  it('falls back to trusted headers, then ip, then request id', () => {
    const fromHeader = resolveSafetyIdentifier({
      request: mockRequest({ 'x-openai-user': 'openai-user-123' }),
      requestId: 'req-1'
    });
    const fromIp = resolveSafetyIdentifier({
      request: mockRequest({}, '10.0.0.5'),
      requestId: 'req-1'
    });
    const fromRequestId = resolveSafetyIdentifier({
      request: mockRequest(),
      requestId: 'req-1'
    });

    expect(fromHeader).toMatch(/^usr_[a-f0-9]{24}$/);
    expect(fromIp).toMatch(/^usr_[a-f0-9]{24}$/);
    expect(fromRequestId).toMatch(/^usr_[a-f0-9]{24}$/);
    expect(fromHeader).not.toBe(fromIp);
    expect(fromIp).not.toBe(fromRequestId);
  });

  it('ignores unsafe user/header values', () => {
    const unsafe = resolveSafetyIdentifier({
      request: mockRequest({ 'x-user-id': 'bad user with spaces' }, '127.0.0.1'),
      explicitUser: 'bad user with spaces',
      requestId: 'req-safe'
    });

    const fromIp = resolveSafetyIdentifier({
      request: mockRequest({}, '127.0.0.1'),
      requestId: 'req-safe'
    });

    expect(unsafe).toBe(fromIp);
  });
});

