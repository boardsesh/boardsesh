import { describe, expect, it } from 'vite-plus/test';
import { CLOUDFLARE_ORIGIN_PROOF_HEADER, redactOriginProof } from '../origin-proof';

const SECRET = 'origin-proof-fixture-secret-at-least-32-bytes';

describe('redactOriginProof', () => {
  it('removes request headers, SDK metadata and span attributes without losing other fields', () => {
    const event = {
      request: { headers: { [CLOUDFLARE_ORIGIN_PROOF_HEADER]: SECRET, 'user-agent': 'fixture' } },
      sdkProcessingMetadata: {
        normalizedRequest: { headers: { 'x-boardsesh-origin-proof': SECRET } },
      },
      contexts: {
        trace: { data: { 'http.request.header.x_boardsesh_origin_proof': SECRET, 'http.method': 'POST' } },
      },
      spans: [{ data: { 'HTTP.REQUEST.HEADER.X_BOARDSESH_ORIGIN_PROOF': SECRET, 'http.route': '/api/posthog/batch' } }],
    };

    expect(redactOriginProof(event)).toBe(event);
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(event.request.headers).toEqual({ 'user-agent': 'fixture' });
    expect(event.contexts.trace.data).toEqual({ 'http.method': 'POST' });
    expect(event.spans[0].data).toEqual({ 'http.route': '/api/posthog/batch' });
  });

  it('redacts independently streamed spans', () => {
    const span = { data: { 'http.request.header.x_boardsesh_origin_proof': SECRET, 'http.method': 'POST' } };
    expect(redactOriginProof(span).data).toEqual({ 'http.method': 'POST' });
  });

  it('handles repeated references and cycles without recursion failures', () => {
    const headers = { [CLOUDFLARE_ORIGIN_PROOF_HEADER]: SECRET, 'user-agent': 'fixture' };
    const event: Record<string, unknown> = { request: { headers }, breadcrumbs: [headers] };
    event.self = event;

    expect(redactOriginProof(event)).toBe(event);
    expect(headers).toEqual({ 'user-agent': 'fixture' });
    expect(event.self).toBe(event);
  });

  it.each([null, undefined, 'fixture', 42])('leaves non-object payloads unchanged: %j', (payload) => {
    expect(redactOriginProof(payload)).toBe(payload);
  });
});
