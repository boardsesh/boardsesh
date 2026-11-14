// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createBrowserRenewalCommandClient } from '../browser-renewal-command-client.server';
import { AuthBackendUnavailableError } from '../auth-command-transport.server';
import {
  browserRenewalCommandSchema,
  type BrowserRenewalCommand,
  type BrowserRenewalReply,
  type BrowserRenewalPreparation,
} from '@boardsesh/auth-protocol/browser-renewal-v1';
const rpcSecret = 'owned-renewal-independent-command-service-secret-6975';
const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_BROWSER_RENEWAL_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://127.0.0.1:54681',
  CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
  NEXTAUTH_SECRET: 'owned-unrelated-renewal-codec-key',
  HTTP_COOKIE: 'owned-incoming-not-forwarded',
};
const bindingToken = 'A'.repeat(43);
const actor = { version: 1, credential: { kind: 'canonical-token' as const, token: 'B'.repeat(43) } };
const nonceHash = 'e'.repeat(64);
const operationToken = 'C'.repeat(43);
const preparationToken = 'D'.repeat(43);
function preparation(): BrowserRenewalPreparation {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const target = now + 30 * 24 * 60 * 60 * 1000;
  const bindingId = createHash('sha256').update(bindingToken).digest('hex');
  return {
    version: 1,
    credentialKind: 'canonical-token',
    sourceCredentialProof: {
      version: 1,
      userId: 'owned-A',
      authSessionId: 'original-SID',
      generation: 3,
      authenticatedAt: null,
      linkGuarded: false,
      requiresAccountCutoff: true,
    },
    sourceCredentialHash: createHash('sha256')
      .update(JSON.stringify(['browser-renewal-source-v1', actor.credential]))
      .digest('hex'),
    sourceExpiresAt: new Date(now + 3600000).toISOString(),
    browserCursor: { bindingId, version: 1, bindingExpiresAt: new Date(now + 86400000).toISOString() },
    intentRevision: 2,
    futureBrowserCursor: { bindingId, version: 2, bindingExpiresAt: new Date(target).toISOString() },
    targetExpiresAt: new Date(target).toISOString(),
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
  };
}
function fixture(transform?: (reply: BrowserRenewalReply) => { status?: number; body: unknown }) {
  const frozen = preparation();
  const sent: { command: BrowserRenewalCommand; init: RequestInit; url: string }[] = [];
  const send = vi.fn<typeof fetch>(async (input, init) => {
    if (typeof input !== 'string' || typeof init?.body !== 'string')
      throw new Error('Owned fixture requires a URL and JSON body');
    const command = browserRenewalCommandSchema.parse(JSON.parse(init.body) as unknown);
    sent.push({ command, init, url: input });
    const metadata = {
      browserRenewalProtocolVersion: 1 as const,
      requestId: command.requestId,
      operation: command.operation,
    };
    const reply: BrowserRenewalReply =
      command.operation === 'prepare'
        ? {
            ...metadata,
            operation: 'prepare',
            outcome: 'prepared',
            operationToken,
            preparationToken,
            preparation: structuredClone(frozen),
          }
        : {
            ...metadata,
            operation: command.operation,
            outcome: 'completed',
            cursor: structuredClone(frozen.futureBrowserCursor),
            credentialProof: structuredClone(frozen.sourceCredentialProof),
            credentialExpiresAt: frozen.targetExpiresAt,
          };
    const changed = transform?.(reply);
    return Response.json(changed?.body ?? reply, { status: changed?.status ?? 200 });
  });
  return { client: createBrowserRenewalCommandClient({ environment, fetch: send }), send, sent, prepared: frozen };
}
function bound(prepared: BrowserRenewalPreparation) {
  return {
    bindingToken,
    actor: structuredClone(actor),
    operationToken,
    preparationToken,
    nonceHash,
    preparation: structuredClone(prepared),
    candidate: structuredClone(actor.credential),
  };
}
describe('renewal private command reply correlation', () => {
  it('sends all three exact operations with private service auth and no incoming cookies', async () => {
    const current = fixture();
    await current.client.prepare({ bindingToken, actor, nonceHash });
    await current.client.finalize(bound(current.prepared));
    await current.client.acknowledge(bound(current.prepared));
    expect(current.sent.map((entry) => entry.url)).toEqual(
      ['prepare', 'finalize', 'acknowledge'].map(
        (operation) =>
          `${environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN}/api/internal/auth/browser-renewal/v1/${operation}`,
      ),
    );
    for (const entry of current.sent) {
      const headers = new Headers(entry.init.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${rpcSecret}`);
      expect(headers.has('cookie')).toBe(false);
      expect(entry.init.cache).toBe('no-store');
      expect(entry.init.redirect).toBe('error');
      expect(Math.abs(entry.command.issuedAt - Date.now())).toBeLessThan(5000);
    }
    expect(new Set(current.sent.map((entry) => entry.command.requestId)).size).toBe(3);
  });
  it.each(['legacy', 'pretend-enabled'])('refuses %s mode before transport', (mode) => {
    expect(() =>
      createBrowserRenewalCommandClient({
        environment: { ...environment, CURRENT_STORE_BROWSER_RENEWAL_MODE: mode },
        fetch: vi.fn(),
      }),
    ).toThrow(AuthBackendUnavailableError);
  });
  it.each(['id', 'version', 'hash', 'kind'] as const)(
    'refuses coherent foreign prepared %s evidence',
    async (field) => {
      const current = fixture((reply) => {
        if (reply.outcome !== 'prepared') throw new Error('owned prepare expected');
        const changed = structuredClone(reply);
        if (field === 'id') {
          changed.preparation.browserCursor.bindingId = 'f'.repeat(64);
          changed.preparation.futureBrowserCursor.bindingId = 'f'.repeat(64);
        }
        if (field === 'version') {
          changed.preparation.browserCursor.version = 9;
          changed.preparation.futureBrowserCursor.version = 10;
        }
        if (field === 'hash') changed.preparation.sourceCredentialHash = 'f'.repeat(64);
        if (field === 'kind') changed.preparation.credentialKind = 'legacy-jwe';
        return { body: changed };
      });
      await expect(current.client.prepare({ bindingToken, actor, nonceHash })).rejects.toThrow(
        AuthBackendUnavailableError,
      );
      expect(current.send).toHaveBeenCalledTimes(1);
    },
  );
  it.each(
    (['finalize', 'acknowledge'] as const).flatMap((operation) =>
      (
        [
          'id',
          'version',
          'expiry',
          'binding-expiry',
          'owner',
          'sid',
          'generation',
          'provenance',
          'age',
          'operation',
        ] as const
      ).map((field) => [operation, field] as const),
    ),
  )('refuses a schema-valid %s completed %s reply', async (operation, field) => {
    const current = fixture((reply) => {
      if (reply.outcome !== 'completed') throw new Error('owned complete expected');
      const changed = structuredClone(reply);
      if (field === 'id') changed.cursor.bindingId = 'f'.repeat(64);
      if (field === 'version') changed.cursor.version = 3;
      if (field === 'expiry')
        changed.credentialExpiresAt = new Date(Date.parse(changed.credentialExpiresAt) + 1000).toISOString();
      if (field === 'binding-expiry')
        changed.cursor.bindingExpiresAt = new Date(Date.parse(changed.cursor.bindingExpiresAt) + 1000).toISOString();
      if (field === 'owner') changed.credentialProof.userId = 'foreign-B';
      if (field === 'sid') changed.credentialProof.authSessionId = 'foreign-SID';
      if (field === 'generation') changed.credentialProof.generation += 1;
      if (field === 'provenance') delete changed.credentialProof.requiresAccountCutoff;
      if (field === 'age') {
        changed.credentialProof.authenticatedAt = new Date(Date.now() - 30000).toISOString();
        changed.credentialProof.linkGuarded = true;
      }
      if (field === 'operation') changed.operation = operation === 'finalize' ? 'acknowledge' : 'finalize';
      return { body: changed };
    });
    await expect(current.client[operation](bound(current.prepared))).rejects.toThrow(AuthBackendUnavailableError);
    expect(current.send).toHaveBeenCalledTimes(1);
  });
  it.each(['status', 'request-id', 'extra-secret'] as const)('refuses %s on a prepared reply', async (field) => {
    const current = fixture((reply) => ({
      status: field === 'status' ? 201 : 200,
      body:
        field === 'request-id'
          ? { ...reply, requestId: 'e363934b-b7ba-41ba-a279-52185daa100e' }
          : field === 'extra-secret'
            ? { ...reply, credential: 'owned-unexpected-private-source' }
            : reply,
    }));
    await expect(current.client.prepare({ bindingToken, actor, nonceHash })).rejects.toThrow(
      AuthBackendUnavailableError,
    );
  });
  it('copies submitted nested actor/preparation before the network callback can mutate them', async () => {
    const current = fixture();
    const payload = bound(current.prepared);
    const original = current.send.getMockImplementation()!;
    current.send.mockImplementation(async (...parameters) => {
      payload.actor.credential.token = 'changed-after-send';
      payload.preparation.futureBrowserCursor.version = 9;
      return original(...parameters);
    });
    await expect(current.client.finalize(payload)).resolves.toMatchObject({
      outcome: 'completed',
      cursor: { version: 2 },
    });
    expect(current.sent[0].command.payload.actor.credential).toEqual(actor.credential);
  });
  it('refuses UTF8 source overflow before any fetch', async () => {
    const current = fixture();
    await expect(
      current.client.prepare({
        bindingToken,
        nonceHash,
        actor: { version: 1, credential: { kind: 'legacy-jwe', credential: 'é'.repeat(9000) } },
      }),
    ).rejects.toThrow(AuthBackendUnavailableError);
    expect(current.send).not.toHaveBeenCalled();
  });
  it('never retries a finalizer whose transport outcome is unknown or exposes its cause', async () => {
    const current = fixture();
    current.send.mockRejectedValue(new Error('unsafe-owned-private-URL-and-credential-cause'));
    const result = await current.client.finalize(bound(current.prepared)).catch((error) => error);
    expect(result).toBeInstanceOf(AuthBackendUnavailableError);
    expect(String(result)).not.toContain('unsafe-owned');
    expect(current.send).toHaveBeenCalledTimes(1);
  });
  it('retains explicit service-unavailable status without a retry', async () => {
    const current = fixture((reply) => ({
      status: 503,
      body: {
        browserRenewalProtocolVersion: 1,
        requestId: reply.requestId,
        operation: reply.operation,
        outcome: 'unavailable',
      },
    }));
    await expect(current.client.finalize(bound(current.prepared))).resolves.toMatchObject({ outcome: 'unavailable' });
    expect(current.send).toHaveBeenCalledTimes(1);
  });
});
