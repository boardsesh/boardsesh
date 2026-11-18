// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';
import * as Sentry from '@sentry/nextjs';
import { redactOriginProof } from '../redact-origin-proof';

const SECRET = 'origin-proof-fixture-secret-at-least-32-bytes';

/** The SDK's own RequestData step under a real client with PII off, as production runs it. */
async function errorEventFromRequest(): Promise<Sentry.Event> {
  const client = new Sentry.NodeClient({
    sendDefaultPii: false,
    integrations: [],
    transport: Sentry.makeNodeTransport,
    stackParser: Sentry.defaultStackParser,
  });
  const event: Sentry.Event = {
    sdkProcessingMetadata: {
      normalizedRequest: {
        method: 'POST',
        url: 'https://www.boardsesh.com/api/auth/callback/credentials',
        headers: { 'x-boardsesh-origin-proof': SECRET, 'user-agent': 'Mozilla/5.0' },
      },
    },
  };
  const processed = await Sentry.requestDataIntegration().processEvent?.(event, {}, client);
  if (!processed) throw new Error('RequestData dropped the event');
  return processed;
}

describe('redactOriginProof', () => {
  it('is needed: with PII off the SDK still puts the proof on the event', async () => {
    const event = await errorEventFromRequest();
    expect(event.request?.headers?.['x-boardsesh-origin-proof']).toBe(SECRET);
  });

  it('removes it from an error event and keeps the other headers', async () => {
    const event = redactOriginProof(await errorEventFromRequest());
    expect(event.request?.headers).not.toHaveProperty('x-boardsesh-origin-proof');
    expect(event.request?.headers?.['user-agent']).toBe('Mozilla/5.0');
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it('removes it from a transaction: request headers, trace context and every span', () => {
    const transaction: Sentry.Event = {
      type: 'transaction',
      request: { headers: { 'X-Boardsesh-Origin-Proof': SECRET } },
      contexts: {
        trace: {
          trace_id: 'a'.repeat(32),
          span_id: 'b'.repeat(16),
          data: { 'http.request.header.x_boardsesh_origin_proof': SECRET, 'http.method': 'POST' },
        },
      },
      spans: [
        {
          span_id: 'c'.repeat(16),
          trace_id: 'a'.repeat(32),
          start_timestamp: 0,
          data: { 'http.request.header.x_boardsesh_origin_proof': SECRET, 'http.route': '/api/auth/[...nextauth]' },
        },
      ],
    };
    const redacted = redactOriginProof(transaction);
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted.contexts?.trace?.data).toEqual({ 'http.method': 'POST' });
    expect(redacted.spans?.[0].data).toEqual({ 'http.route': '/api/auth/[...nextauth]' });
  });

  it('removes it from a streamed span', () => {
    const span = {
      span_id: 'c'.repeat(16),
      trace_id: 'a'.repeat(32),
      start_timestamp: 0,
      data: { 'http.request.header.x_boardsesh_origin_proof': SECRET, 'http.method': 'POST' },
    };
    expect(redactOriginProof(span).data).toEqual({ 'http.method': 'POST' });
  });
});
