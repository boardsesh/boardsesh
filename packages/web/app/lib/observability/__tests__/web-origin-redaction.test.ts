import { describe, expect, it } from 'vite-plus/test';
import { redactWebOriginEvent, redactWebOriginLog, redactWebOriginSpan } from '../web-origin-redaction';

describe('origin verification telemetry redaction', () => {
  it('removes incoming headers from errors and transactions while preserving correlation', () => {
    const event = {
      request: { headers: { 'X-Boardsesh-Origin-Verify': 'secret', 'x-railway-request-id': 'request-id' } },
      contexts: { trace: { data: { 'http.request.header.x-boardsesh-origin-verify': 'secret' } } },
      spans: [{ data: { 'http.request.header.x_boardsesh_origin_verify': ['secret'], 'http.status_code': 200 } }],
    };
    redactWebOriginEvent(event);
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(event.request.headers['x-railway-request-id']).toBe('request-id');
    expect(event.spans[0].data['http.status_code']).toBe(200);
  });
  it('removes header attributes from standalone spans and structured logs', () => {
    const span = { data: { 'http.request.header.x-boardsesh-origin-verify': 'secret' } };
    const log = { attributes: { 'x-boardsesh-origin-verify': { value: 'secret' }, route: '/' } };
    expect(redactWebOriginSpan(span).data).toEqual({});
    expect(redactWebOriginLog(log).attributes).toEqual({ route: '/' });
  });
  it('accepts telemetry without request headers', () => {
    expect(redactWebOriginEvent({})).toEqual({});
    expect(redactWebOriginSpan({})).toEqual({});
    expect(redactWebOriginLog({})).toEqual({});
  });
});
