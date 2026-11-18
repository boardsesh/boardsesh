import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { validateToken } from '../middleware/auth';
import { authenticateSessionRequest } from '../handlers/session-auth';
import { handleNativeAuthExchange } from '../handlers/native-auth';

// The browser delegation lease (`bsbd1_`) and the browser-to-native handoff
// (`bsnh1_`) were removed by #7596. Their prefixes are now ordinary unrecognised
// strings: no authority configuration, credential database or private key is
// consulted, and a server whose staged auth environment is unset still answers.
const retiredLease = `bsbd1_${'A'.repeat(43)}`;
const retiredHandoff = `bsnh1_${'B'.repeat(43)}`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/session') {
        const result = await authenticateSessionRequest(request);
        response.writeHead(result.ok ? 200 : result.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
        return;
      }
      if (request.url === '/auth/native/exchange') {
        await handleNativeAuthExchange(request, response);
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  // The removed branches read these before anything else and answered 503
  // when they were missing, which is how production runs today.
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', '');
  vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a retired bsbd1_ browser lease', () => {
  it('is an unrecognised bearer, so optional-auth transports stay anonymous', async () => {
    await expect(validateToken(retiredLease)).resolves.toBeNull();
    // GraphQL HTTP and the WebSocket handshake ask for refusals to throw.
    await expect(validateToken(retiredLease, { throwOnRefusal: true })).resolves.toBeNull();
  });

  it('gets 401 where a credential is required', async () => {
    const response = await fetch(`${origin}/session`, { headers: { Authorization: `Bearer ${retiredLease}` } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, status: 401, error: 'Unauthorized' });
  });
});

describe('a retired bsnh1_ browser-to-native transfer', () => {
  it("gets the legacy transfer parser's 401 from /auth/native/exchange", async () => {
    const response = await fetch(`${origin}/auth/native/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferToken: retiredHandoff }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid or expired transfer token' });
  });
});
