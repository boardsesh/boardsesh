import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Sentry from '@sentry/node';
import { afterAll, describe, expect, it } from 'vite-plus/test';

const secret = 'fixture-password-value';

describe('Sentry request bodies', () => {
  afterAll(async () => {
    await Sentry.close(1000);
  });

  it('keeps a POST body out of transactions and error events', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    Sentry.init({
      dsn: 'https://public@o0.ingest.sentry.io/1',
      sendDefaultPii: false,
      tracesSampleRate: 1,
      // The same option packages/backend/src/instrument.ts passes.
      integrations: [Sentry.requestDataIntegration({ include: { data: false } })],
      transport: () => ({
        send: async (envelope) => {
          for (const [, payload] of envelope[1] as unknown as Array<[unknown, Record<string, unknown>]>) {
            payloads.push(payload);
          }
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });

    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        Sentry.captureException(new Error('fixture failure'));
        response.end(body.length > 0 ? 'ok' : 'empty');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/auth/native/credentials`, {
        method: 'POST',
        body: JSON.stringify({ password: secret }),
      });
      await expect(response.text()).resolves.toBe('ok');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await Sentry.flush(2000);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const requestEvents = payloads.filter((payload) => payload.request);
    expect(requestEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(payloads)).not.toContain(secret);
  });
});
