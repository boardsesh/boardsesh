// @vitest-environment node
import { createHash } from 'node:crypto';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  EXPIRED_BROWSER_BINDING_COMMAND_PATHS,
  expiredBrowserBindingCommandSchema,
  type ExpiredBrowserBindingPreparation,
  type ExpiredBrowserBindingReply,
} from '@boardsesh/auth-protocol/expired-browser-binding-v1';
vi.mock('server-only', () => ({}));
import { createExpiredBrowserBindingCommandClient } from '../expired-browser-binding-command-client.server';

const oldToken = Buffer.alloc(32, 11).toString('base64url');
const targetToken = Buffer.alloc(32, 12).toString('base64url');
const operationToken = Buffer.alloc(32, 13).toString('base64url');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const environment = {
  CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://private.expired-binding.example.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-private-expired-binding-rpc-secret-6975',
  NEXTAUTH_SECRET: 'separate-owned-original-browser-cookie-secret-6975',
};
function preparation(): ExpiredBrowserBindingPreparation {
  const now = Math.floor(Date.now() / 1000) * 1000;
  return {
    version: 1,
    purpose: 'expired-browser-binding-retirement-v1',
    oldBindingId: hash(oldToken),
    oldVersion: 3,
    oldIntentRevision: 7,
    oldStateHash: 'd'.repeat(64),
    oldExpiresAt: new Date(now - 1000).toISOString(),
    targetCursor: {
      bindingId: hash(targetToken),
      version: 0,
      bindingExpiresAt: new Date(now + 30 * 86400000).toISOString(),
    },
    nonceHash: 'e'.repeat(64),
    authority: {
      projectionId: 'owned-expired-binding-projection',
      normalizerVersion: 'owned-normalizer',
      authority: 'current-store',
      epoch: 4,
    },
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    acknowledgeUntil: new Date(now + 300000).toISOString(),
  };
}
function fixture(transform: (reply: ExpiredBrowserBindingReply) => unknown = (reply) => reply, status = 200) {
  const frozen = preparation();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, options) => {
    if (typeof options?.body !== 'string') throw new Error('Expected private JSON command');
    const request = expiredBrowserBindingCommandSchema.parse(JSON.parse(options.body));
    const metadata = { expiredBrowserBindingProtocolVersion: 1 as const, requestId: request.requestId };
    const reply: ExpiredBrowserBindingReply =
      request.operation === 'prepare'
        ? {
            ...metadata,
            operation: 'prepare',
            outcome: 'prepared',
            operationToken,
            targetBindingToken: targetToken,
            preparation: frozen,
          }
        : { ...metadata, operation: request.operation, outcome: 'completed', cursor: frozen.targetCursor };
    return Response.json(transform(reply), { status });
  });
  const client = createExpiredBrowserBindingCommandClient({ environment, fetch });
  const prepareInput = { bindingToken: oldToken, expectedVersion: 3, nonceHash: frozen.nonceHash };
  const bound = { bindingToken: oldToken, targetBindingToken: targetToken, operationToken, preparation: frozen };
  return { client, fetch, frozen, prepareInput, bound };
}
describe('private expired browser binding command client', () => {
  it.each(['prepare', 'finalize', 'acknowledge'] as const)(
    'uses one fixed authenticated %s request',
    async (operation) => {
      const current = fixture();
      const reply =
        operation === 'prepare'
          ? await current.client.prepare(current.prepareInput)
          : await current.client[operation](current.bound);
      expect(reply.operation).toBe(operation);
      expect(current.fetch).toHaveBeenCalledOnce();
      expect(current.fetch.mock.calls[0]).toMatchObject([
        environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN + EXPIRED_BROWSER_BINDING_COMMAND_PATHS[operation],
        {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          headers: { Authorization: 'Bearer ' + environment.CURRENT_STORE_AUTH_RPC_SECRET },
        },
      ]);
    },
  );
  it('allows the explicit action without an earlier readable expired version', async () => {
    const current = fixture();
    expect(await current.client.prepare({ bindingToken: oldToken, nonceHash: current.frozen.nonceHash })).toMatchObject(
      { outcome: 'prepared' },
    );
  });
  it.each(['legacy', '', 'unknown', ' backend-staging'])('refuses mode %s before I/O', (mode) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() =>
      createExpiredBrowserBindingCommandClient({
        environment: { ...environment, CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE: mode },
        fetch,
      }),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['oldBindingId', 'oldVersion', 'nonceHash', 'targetBindingToken'] as const)(
    'rejects mismatched preparation %s',
    async (field) => {
      const current = fixture((reply) => {
        if (reply.outcome !== 'prepared') return reply;
        if (field === 'targetBindingToken')
          return { ...reply, targetBindingToken: Buffer.alloc(32, 20).toString('base64url') };
        return {
          ...reply,
          preparation: { ...reply.preparation, [field]: field === 'oldVersion' ? 2 : 'f'.repeat(64) },
        };
      });
      await expect(current.client.prepare(current.prepareInput)).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
      expect(current.fetch).toHaveBeenCalledOnce();
    },
  );
  it.each(['bindingToken', 'targetBindingToken'] as const)(
    'rejects the wrong actual %s before sending a finalizer',
    async (field) => {
      const current = fixture();
      await expect(
        current.client.finalize({ ...current.bound, [field]: Buffer.alloc(32, 21).toString('base64url') }),
      ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
      expect(current.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['requestId', 'operation', 'cursor', 'status'] as const)(
    'rejects mismatched completion %s without retry',
    async (field) => {
      const current = fixture(
        (reply) => {
          if (field === 'requestId') return { ...reply, requestId: 'd2d14044-9201-432b-a76e-3775c2492b18' };
          if (field === 'operation') return { ...reply, operation: 'acknowledge' };
          if (field === 'cursor' && reply.outcome === 'completed')
            return { ...reply, cursor: { ...reply.cursor, version: 1 } };
          return reply;
        },
        field === 'status' ? 409 : 200,
      );
      await expect(current.client.finalize(current.bound)).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
      expect(current.fetch).toHaveBeenCalledOnce();
    },
  );
  it('copies nested preparation before the first network await', async () => {
    const current = fixture();
    const previousStateHash = current.bound.preparation.oldStateHash;
    const pending = current.client.finalize(current.bound);
    current.bound.preparation.oldStateHash = 'a'.repeat(64);
    expect(await pending).toMatchObject({ outcome: 'completed' });
    const body = current.fetch.mock.calls[0][1]?.body;
    if (typeof body !== 'string') throw new Error('Expected captured command');
    expect(expiredBrowserBindingCommandSchema.parse(JSON.parse(body)).payload).toMatchObject({
      preparation: { oldStateHash: previousStateHash },
    });
  });
  it('redacts thrown private transport causes and never retries an uncertain finalizer', async () => {
    const current = fixture();
    current.fetch.mockRejectedValueOnce(new Error('private-cookie-and-token-should-not-escape'));
    const error = await current.client.finalize(current.bound).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ message: AUTH_BACKEND_UNAVAILABLE });
    expect(error).not.toHaveProperty('cause');
    expect(current.fetch).toHaveBeenCalledOnce();
  });
});
