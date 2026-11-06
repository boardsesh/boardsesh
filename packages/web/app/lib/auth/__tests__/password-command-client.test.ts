// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_BACKEND_UNAVAILABLE, AUTH_COMMAND_RESPONSE_BYTES } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import {
  createPasswordCommandClient,
  registrationMailOrigin,
  webPasswordMode,
} from '../password-command-client.server';

type Handler = (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void;
let handle: Handler;
let origin: string;
const received: { url?: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  received.push({ url: request.url, headers: request.headers, body });
  handle(request, response, body);
});
const environment = () => ({
  NODE_ENV: 'test',
  CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin,
  CURRENT_STORE_AUTH_RPC_SECRET: 'dedicated-server-rpc-secret-at-least-32-bytes',
});
function reply(response: ServerResponse, body: Record<string, unknown>, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => {
  received.length = 0;
  handle = (_request, response, body) =>
    reply(response, {
      protocolVersion: 2,
      operation: 'password',
      requestId: body.requestId,
      outcome: 'invalid_credentials',
    });
});

describe('server-only password command transport', () => {
  it.each(['forgot-password', 'reset-password'] as const)(
    'uses only the fixed %s destination and correlated v2 reply',
    async (operation) => {
      handle = (_request, response, command) =>
        reply(response, {
          protocolVersion: 2,
          operation,
          requestId: command.requestId,
          outcome: operation === 'forgot-password' ? 'accepted' : 'reset',
        });
      const client = createPasswordCommandClient({ environment: environment() });
      const payload = {
        email: 'hint@example.test',
        token: `pr1_${'A'.repeat(43)}`,
        password: 'unchanged bytes',
        confirmPassword: 'unchanged bytes',
      };
      const result =
        operation === 'forgot-password' ? await client.forgotPassword(payload) : await client.resetPassword(payload);
      expect(result.operation).toBe(operation);
      expect(received).toHaveLength(1);
      expect(received[0].url).toBe(`/api/internal/auth/current-store/${operation}`);
      expect(received[0].body).toMatchObject({ protocolVersion: 2, operation, payload });
      expect(received[0].headers.cookie).toBeUndefined();
    },
  );
  it('sends only the fixed command, distinct server credential, raw password input and fresh nonce', async () => {
    const client = createPasswordCommandClient({ environment: environment() });
    await expect(client.password('Legacy@example.com', 'one')).resolves.toMatchObject({
      outcome: 'invalid_credentials',
    });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/api/internal/auth/current-store/password');
    expect(received[0].headers.authorization).toBe(`Bearer ${environment().CURRENT_STORE_AUTH_RPC_SECRET}`);
    expect(received[0].headers.cookie).toBeUndefined();
    expect(received[0].body).toEqual({
      protocolVersion: 2,
      operation: 'password',
      requestId: expect.stringMatching(/^[\da-f-]{36}$/),
      issuedAt: expect.any(Number),
      payload: { email: 'Legacy@example.com', password: 'one' },
    });
    await client.password('Legacy@example.com', 'one');
    expect(received[1].body.requestId).not.toBe(received[0].body.requestId);
  });
  it('does not require credentials while default mode is off', () => {
    expect(webPasswordMode({})).toBe('legacy');
    expect(() => webPasswordMode({ CURRENT_STORE_WEB_AUTH_MODE: 'unknown' })).toThrow(AUTH_BACKEND_UNAVAILABLE);
  });
  it.each([
    { CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://remote.invalid' },
    { CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://rpc.invalid/path' },
    { CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://user:secret@rpc.invalid' },
    { CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://rpc.invalid?redirect=elsewhere' },
    { CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://rpc.invalid#fragment' },
    { CURRENT_STORE_AUTH_RPC_SECRET: 'short' },
    { CURRENT_STORE_AUTH_RPC_SECRET: ' spaced-server-credential-at-least-32 ' },
    { NEXTAUTH_SECRET: 'dedicated-server-rpc-secret-at-least-32-bytes' },
    { CRON_SECRET: 'dedicated-server-rpc-secret-at-least-32-bytes' },
    { NODE_ENV: 'production' },
  ])('rejects unsafe configured transport before network activity: %j', (unsafe) => {
    expect(() => createPasswordCommandClient({ environment: { ...environment(), ...unsafe } })).toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
    expect(received).toHaveLength(0);
  });
  it('accepts explicit HTTPS remote origin but never infers it from request headers', () => {
    expect(() =>
      createPasswordCommandClient({
        environment: {
          ...environment(),
          NODE_ENV: 'production',
          CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://rpc.boardsesh.test',
        },
      }),
    ).not.toThrow();
  });
  it.each(['wrong-id', 'wrong-operation', 'status', 'extra-secret', 'malformed-json', 'wrong-content-type'])(
    'rejects %s and exposes no remote response or nested cause',
    async (fault) => {
      handle = (_request, response, command) => {
        const body = {
          protocolVersion: 2,
          operation: 'password',
          requestId: command.requestId,
          outcome: 'invalid_credentials',
        };
        if (fault === 'wrong-id') body.requestId = '40b5df4e-ad28-4ce1-a8da-a5580f7d8a99';
        if (fault === 'wrong-operation') body.operation = 'register';
        if (fault === 'malformed-json' || fault === 'wrong-content-type') {
          response.writeHead(200, {
            'Content-Type': fault === 'wrong-content-type' ? 'text/plain' : 'application/json',
          });
          response.end('private remote token');
          return;
        }
        reply(
          response,
          { ...body, ...(fault === 'extra-secret' ? { token: 'private remote token' } : {}) },
          fault === 'status' ? 503 : 200,
        );
      };
      const failure = await createPasswordCommandClient({ environment: environment() })
        .password('email', 'private password')
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: AUTH_BACKEND_UNAVAILABLE });
      expect(failure).not.toHaveProperty('cause');
      expect(String(failure)).not.toContain('private');
      expect(received).toHaveLength(1);
    },
  );
  it('refuses redirects without issuing a second request', async () => {
    handle = (_request, response) => {
      response.writeHead(307, { Location: `${origin}/stolen` });
      response.end();
    };
    await expect(createPasswordCommandClient({ environment: environment() }).password('x', 'y')).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
    expect(received).toHaveLength(1);
  });
  it('caps streamed response bytes even without Content-Length', async () => {
    handle = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write(' '.repeat(AUTH_COMMAND_RESPONSE_BYTES));
      response.end('private overflow');
    };
    await expect(createPasswordCommandClient({ environment: environment() }).password('x', 'y')).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });
  it.each(['headers', 'body'] as const)('applies one deadline to stalled %s and never retries', async (stall) => {
    handle = (_request, response) => {
      if (stall === 'body') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{');
      }
    };
    const startedAt = Date.now();
    await expect(
      createPasswordCommandClient({ environment: environment(), timeoutMs: 100 }).password('x', 'y'),
    ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(received).toHaveLength(1);
  });
  it('caps serialized request before network without retrying', async () => {
    await expect(
      createPasswordCommandClient({ environment: environment() }).register({ password: 'x'.repeat(20_000) }),
    ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(received).toHaveLength(0);
  });
  it('validates canonical mail origin without trusting a production request Host', () => {
    expect(
      registrationMailOrigin('https://attacker.test', {
        NODE_ENV: 'production',
        BASE_URL: '',
        NEXTAUTH_URL: 'https://www.boardsesh.test',
      }),
    ).toBe('https://www.boardsesh.test');
    expect(() => registrationMailOrigin('https://attacker.test', { NODE_ENV: 'production', BASE_URL: '' })).toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
    expect(() => registrationMailOrigin('https://attacker.test', { NODE_ENV: 'test' })).toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
    expect(registrationMailOrigin(origin, { NODE_ENV: 'test', BASE_URL: '' })).toBe(origin);
  });
  it.each(['verify-email', 'resend-verification'] as const)(
    'uses the fixed %s path and body version2',
    async (operation) => {
      handle = (_request, response, body) =>
        reply(response, {
          protocolVersion: 2,
          operation,
          requestId: body.requestId,
          outcome: operation === 'verify-email' ? 'verified' : 'accepted',
        });
      const client = createPasswordCommandClient({ environment: environment() });
      if (operation === 'verify-email')
        await expect(client.verifyEmail(`ev1_${'A'.repeat(43)}`)).resolves.toMatchObject({ outcome: 'verified' });
      else
        await expect(client.resendVerification({ email: 'Climber@example.com' })).resolves.toMatchObject({
          outcome: 'accepted',
        });
      expect(received).toHaveLength(1);
      expect(received[0].url).toBe(`/api/internal/auth/current-store/${operation}`);
      expect(received[0].body).toMatchObject({ protocolVersion: 2, operation });
      expect(received[0].headers.cookie).toBeUndefined();
    },
  );
  it('rejects a well-formed reply from a different operation', async () => {
    const client = createPasswordCommandClient({ environment: environment() });
    // The default fixture emits a valid password reply with the correct nonce.
    await expect(client.verifyEmail(`ev1_${'A'.repeat(43)}`)).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(received).toHaveLength(1);
  });
  it('rejects a v1 reply even when HTTP status and nonce otherwise match', async () => {
    handle = (_request, response, body) =>
      reply(response, { operation: 'password', requestId: body.requestId, outcome: 'invalid_credentials' });
    await expect(createPasswordCommandClient({ environment: environment() }).password('x', 'y')).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });
});
