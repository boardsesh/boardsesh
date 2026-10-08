// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';
import * as Sentry from '@sentry/nextjs';
import { RAILWAY_REQUEST_ID_HEADER, RAILWAY_REQUEST_ID_TAG, tagRailwayRequestId } from '../sentry-tracing';

/**
 * `tagRailwayRequestId` reads the request headers off the event, and it is only
 * useful if the SDK puts them there. #2644 turned `sendDefaultPii` off in every
 * Sentry config, and the processor's old comment assumed PII was what attached
 * request headers. This runs the SDK's own RequestData integration (the step
 * that copies the incoming request onto an event, before any scope processor)
 * under a real client with PII off, then the processor, so a future SDK that
 * starts dropping headers with PII off fails here instead of silently losing
 * the Railway join key.
 */

const INCOMING_HEADERS = {
  [RAILWAY_REQUEST_ID_HEADER]: 'req_01HZ',
  'x-forwarded-for': '203.0.113.9',
  'cf-connecting-ip': '203.0.113.9',
  'user-agent': 'Mozilla/5.0',
};

function clientWith(sendDefaultPii: boolean) {
  return new Sentry.NodeClient({
    sendDefaultPii,
    integrations: [],
    transport: Sentry.makeNodeTransport,
    stackParser: Sentry.defaultStackParser,
  });
}

async function eventAfterRequestData(sendDefaultPii: boolean): Promise<Sentry.Event> {
  const integration = Sentry.requestDataIntegration();
  const event: Sentry.Event = {
    sdkProcessingMetadata: {
      normalizedRequest: { method: 'GET', url: 'https://boardsesh.com/gyms', headers: { ...INCOMING_HEADERS } },
    },
  };
  const processed = await integration.processEvent?.(event, {}, clientWith(sendDefaultPii));
  if (!processed) throw new Error('RequestData dropped the event');
  return processed;
}

describe('the Railway request id with sendDefaultPii off', () => {
  it('still reaches the event, so the processor still tags it', async () => {
    const event = await eventAfterRequestData(false);

    expect(event.request?.headers?.[RAILWAY_REQUEST_ID_HEADER]).toBe('req_01HZ');
    expect(tagRailwayRequestId(event).tags).toEqual({ [RAILWAY_REQUEST_ID_TAG]: 'req_01HZ' });
  });

  it('keeps the client IP off the event', async () => {
    const event = await eventAfterRequestData(false);

    expect(event.request?.headers).not.toHaveProperty('x-forwarded-for');
    expect(event.request?.headers).not.toHaveProperty('cf-connecting-ip');
    expect(event.user?.ip_address).toBeUndefined();
  });

  it('is the setting that keeps the IP off: with PII on, the same request carries it', async () => {
    // The contrast proves the client option is what the first two tests
    // exercise, not a fixture that never had an IP to drop.
    const event = await eventAfterRequestData(true);

    expect(event.user?.ip_address).toBe('203.0.113.9');
    expect(tagRailwayRequestId(event).tags).toEqual({ [RAILWAY_REQUEST_ID_TAG]: 'req_01HZ' });
  });
});
