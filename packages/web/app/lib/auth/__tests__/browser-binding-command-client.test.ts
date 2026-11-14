// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_BINDING_COMMAND_PATHS,
  browserBindingCommandSchema,
  type BrowserBindingCommand,
} from '@boardsesh/auth-protocol/browser-binding-v1';
vi.mock('server-only', () => ({}));
import { createBrowserBindingCommandClient } from '../browser-binding-command-client.server';
import { AuthBackendUnavailableError } from '../auth-command-transport.server';

const rpcSecret = 'owned-browser-client-private-service-secret';
const bindingToken = Buffer.alloc(32, 7).toString('base64url');
const intentToken = Buffer.alloc(32, 8).toString('base64url');
const cursor = {
  bindingId: createHash('sha256').update(bindingToken).digest('hex'),
  version: 1,
  bindingExpiresAt: '2026-12-01T00:00:00.000Z',
};
const credential = { kind: 'legacy-jwe' as const, credential: 'owned-client-held-source' };
const actor = { version: 1, credential };
const session = {
  userId: 'owned-user',
  authSessionId: 'owned-session',
  generation: 0,
  authenticatedAt: null,
  expiresAt: '2026-11-15T00:00:00.000Z',
  linkGuarded: false,
  requiresAccountCutoff: false,
};
const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://127.0.0.1:54678',
  CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
  NEXTAUTH_SECRET: 'owned-unrelated-browser-cookie-key',
  HTTP_COOKIE: 'incoming-cookie-not-for-private-transport',
};
function reply(command: BrowserBindingCommand): { status: number; body: Record<string, unknown> } {
  const metadata = { browserBindingProtocolVersion: 1, requestId: command.requestId, operation: command.operation };
  switch (command.operation) {
    case 'bootstrap':
      return {
        status: 201,
        body: { ...metadata, outcome: 'created', token: bindingToken, cursor: { ...cursor, version: 0 } },
      };
    case 'describe':
      return {
        status: 200,
        body: { ...metadata, outcome: 'known', state: 'selected', credentialKind: 'legacy-jwe', cursor },
      };
    case 'read':
      return {
        status: 200,
        body: {
          ...metadata,
          outcome: 'admitted',
          cursor,
          session,
          user: { id: session.userId, email: 'owned@example.test', name: null, image: null },
        },
      };
    case 'intent':
      return {
        status: 200,
        body: {
          ...metadata,
          outcome: 'prepared',
          intentToken,
          cursor: { ...cursor, version: command.payload.expectedVersion },
          expiresAt: '2026-11-14T00:00:00.000Z',
        },
      };
    case 'login':
      return { status: 200, body: { ...metadata, outcome: 'committed', cursor: { ...cursor, version: 2 }, session } };
    case 'logout':
      return {
        status: 200,
        body: { ...metadata, outcome: 'committed', cursor: { ...cursor, version: 2 }, session: null },
      };
  }
}
function fixture(
  transform?: (result: ReturnType<typeof reply>, command: BrowserBindingCommand) => ReturnType<typeof reply>,
) {
  const captured: { path: string; settings: RequestInit; command: BrowserBindingCommand }[] = [];
  const send = vi.fn<typeof fetch>(async (input, settings) => {
    if (typeof settings?.body !== 'string') throw new Error('Owned command body missing');
    const command = browserBindingCommandSchema.parse(JSON.parse(settings.body));
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    captured.push({ path: address, settings, command });
    const result = transform ? transform(reply(command), command) : reply(command);
    return Response.json(result.body, { status: result.status });
  });
  return { send, captured, client: createBrowserBindingCommandClient({ environment, fetch: send }) };
}

describe('private browser command client', () => {
  it.each([undefined, '', 'legacy', 'true'])('never opens a transport with a disabled or invalid mode: %s', (mode) => {
    const send = vi.fn<typeof fetch>();
    expect(() =>
      createBrowserBindingCommandClient({
        environment: { ...environment, CURRENT_STORE_BROWSER_BINDING_MODE: mode },
        fetch: send,
      }),
    ).toThrow(AuthBackendUnavailableError);
    expect(send).not.toHaveBeenCalled();
  });
  it('routes all six operations through private service authentication without incoming cookies', async () => {
    const { client, captured } = fixture();
    await client.bootstrap({});
    await client.describe({ bindingToken });
    await client.read({ bindingToken, actor });
    await client.intent({ bindingToken, actor, transition: 'login', expectedVersion: 1 });
    await client.login({ bindingToken, actor, intentToken, candidate: credential });
    await client.logout({ bindingToken, actor, intentToken });
    expect(captured.map((entry) => entry.path)).toEqual(
      Object.values(BROWSER_BINDING_COMMAND_PATHS).map(
        (path) => `${environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN}${path}`,
      ),
    );
    for (const entry of captured) {
      const headers = new Headers(entry.settings.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${rpcSecret}`);
      expect(headers.has('cookie')).toBe(false);
      expect(entry.settings.cache).toBe('no-store');
      expect(entry.settings.redirect).toBe('error');
      expect(Math.abs(entry.command.issuedAt - Date.now())).toBeLessThan(5000);
    }
    expect(new Set(captured.map((entry) => entry.command.requestId)).size).toBe(6);
  });
  it.each(['canonical-token', 'legacy-jwe'] as const)('preserves actual source kind and bytes: %s', async (kind) => {
    const { client, captured } = fixture();
    const proof = kind === 'canonical-token' ? { kind, token: 'owned-opaque-canonical-source' } : credential;
    await client.read({ bindingToken, actor: { version: 1, credential: proof } });
    expect(captured[0].command.payload).toEqual({ bindingToken, actor: { version: 1, credential: proof } });
  });
  it('supports a valid maximal proof beyond the unchanged 16 KiB transport default', async () => {
    const { client, captured } = fixture();
    await client.read({
      bindingToken,
      actor: { version: 1, credential: { ...credential, credential: 'a'.repeat(16_384) } },
    });
    const body = captured[0].settings.body;
    if (typeof body !== 'string') throw new Error('Owned serialized body missing');
    expect(Buffer.byteLength(body)).toBeGreaterThan(16_384);
  });
  it('copies submitted possession before network I/O can mutate the caller object', async () => {
    const submitted = { bindingToken, actor: { version: 1, credential: { ...credential } } };
    const { client, captured } = fixture((result) => {
      submitted.actor.version = 9;
      submitted.actor.credential.credential = 'changed-after-send';
      return result;
    });
    await expect(client.read(submitted)).resolves.toMatchObject({ outcome: 'admitted', cursor: { version: 1 } });
    expect(captured[0].command.payload).toEqual({ bindingToken, actor });
  });
  it.each([
    (result: ReturnType<typeof reply>) => ({ ...result, status: 201 }),
    (result: ReturnType<typeof reply>) => ({
      ...result,
      body: { ...result.body, requestId: 'e363934b-b7ba-41ba-a279-52185daa100e' },
    }),
    (result: ReturnType<typeof reply>) => ({ ...result, body: { ...result.body, operation: 'describe' } }),
    (result: ReturnType<typeof reply>) => ({ ...result, body: { ...result.body, browserBindingProtocolVersion: 2 } }),
    (result: ReturnType<typeof reply>) => ({
      ...result,
      body: { ...result.body, cursor: { ...cursor, bindingId: 'f'.repeat(64) } },
    }),
    (result: ReturnType<typeof reply>) => ({ ...result, body: { ...result.body, cursor: { ...cursor, version: 2 } } }),
    (result: ReturnType<typeof reply>) => ({
      ...result,
      body: { ...result.body, credential: 'unexpected-raw-source' },
    }),
  ])('refuses a mismatched or overbroad admission reply', async (transform) => {
    const { client } = fixture(transform);
    await expect(client.read({ bindingToken, actor })).rejects.toThrow(AuthBackendUnavailableError);
  });
  it('checks bootstrap token correlation before accepting the created binding', async () => {
    const { client } = fixture((result) => ({ ...result, body: { ...result.body, token: intentToken } }));
    await expect(client.bootstrap({})).rejects.toThrow(AuthBackendUnavailableError);
  });
  it('refuses a bootstrap receipt that already selects a later version', async () => {
    const { client } = fixture((result) => ({ ...result, body: { ...result.body, cursor } }));
    await expect(client.bootstrap({})).rejects.toThrow(AuthBackendUnavailableError);
  });
  it('rejects a prepared intent for another observed version', async () => {
    const { client } = fixture((result) => ({
      ...result,
      body: { ...result.body, cursor: { ...cursor, version: 9 } },
    }));
    await expect(
      client.intent({
        bindingToken,
        actor,
        transition: 'logout',
        expectedVersion: 1,
        expectedIdentity: { userId: session.userId, authSessionId: session.authSessionId },
      }),
    ).rejects.toThrow(AuthBackendUnavailableError);
  });
  it('rejects a logout receipt that does not advance exactly the submitted actor version', async () => {
    const { client } = fixture((result) => ({
      ...result,
      body: { ...result.body, cursor: { ...cursor, version: 1 } },
    }));
    await expect(client.logout({ bindingToken, actor, intentToken })).rejects.toThrow(AuthBackendUnavailableError);
  });
  it.each(['committed', 'already-committed'] as const)(
    'rejects a login %s receipt that advances beyond the exact actor version',
    async (outcome) => {
      const { client } = fixture((result) => ({
        ...result,
        body: { ...result.body, outcome, cursor: { ...cursor, version: 9 } },
      }));
      await expect(client.login({ bindingToken, actor, intentToken, candidate: credential })).rejects.toThrow(
        AuthBackendUnavailableError,
      );
    },
  );
  it.each([
    ['denied', 401],
    ['conflict', 409],
    ['unavailable', 503],
  ] as const)('retains explicit backend %s without inventing anonymity', async (outcome, status) => {
    const { client } = fixture((_result, command) => ({
      status,
      body: { browserBindingProtocolVersion: 1, requestId: command.requestId, operation: command.operation, outcome },
    }));
    await expect(client.read({ bindingToken, actor })).resolves.toMatchObject({ outcome });
  });
  it('never retries a mutation with a lost reply or attaches private causes', async () => {
    const privateCause = 'owned-private-network-error-containing-proof';
    const send = vi.fn<typeof fetch>(async () => {
      throw new Error(privateCause);
    });
    const client = createBrowserBindingCommandClient({ environment, fetch: send });
    const failure = await client
      .login({ bindingToken, actor, intentToken, candidate: credential })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthBackendUnavailableError);
    expect(String(failure)).not.toContain(privateCause);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects an oversized source before network I/O', async () => {
    const { client, send } = fixture();
    await expect(
      client.read({
        bindingToken,
        actor: { version: 1, credential: { ...credential, credential: 'a'.repeat(16_385) } },
      }),
    ).rejects.toThrow(AuthBackendUnavailableError);
    expect(send).not.toHaveBeenCalled();
  });
});
