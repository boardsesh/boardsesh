import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Sentry from '@sentry/node';
import { afterAll, describe, expect, it, vi } from 'vite-plus/test';
import { lookupAddressCoordinates } from '../services/gym-address-location';

vi.mock('../redis/client', () => ({
  redisClientManager: {
    getClients: () => ({
      publisher: {
        get: async () => null,
        set: async () => 'OK',
      },
    }),
  },
}));

describe('address lookup telemetry', () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Sentry.close(1000);
  });

  it('keeps the provider query out of later events, breadcrumbs and spans', async () => {
    const payloads: unknown[] = [];
    Sentry.init({
      dsn: 'https://public@o0.ingest.sentry.io/1',
      tracesSampleRate: 1,
      sendDefaultPii: false,
      integrations: [
        Sentry.httpIntegration({ ignoreIncomingRequests: () => true }),
        Sentry.requestDataIntegration({ include: { data: false } }),
      ],
      transport: () => ({
        send: async (envelope) => {
          payloads.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    const address = 'telemetry-secret-address-7965 Amsterdam';
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{ lat: '52.37', lon: '4.89' }]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      vi.stubEnv('GYM_GEOCODING_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`);
      await Sentry.startSpan({ name: 'staff report test', op: 'test' }, async () => {
        expect(await lookupAddressCoordinates(address)).toEqual({ latitude: 52.37, longitude: 4.89 });
        Sentry.captureException(new Error('after address lookup'));
      });
      await Sentry.flush(2000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const serialized = JSON.stringify(payloads);
    expect(serialized).toContain('after address lookup');
    expect(serialized).not.toContain('telemetry-secret-address');
    expect(serialized).not.toContain('q=');
  });
});
