// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol';
import {
  BROWSER_RENEWAL_COMMAND_PATHS,
  browserRenewalCommandSchema,
  type BrowserRenewalCommand,
  type BrowserRenewalReply,
} from '@boardsesh/auth-protocol/browser-renewal-v1';
vi.mock('server-only', () => ({}));
import { browserRenewalSourceHash, createBrowserRenewalCommandClient } from '../browser-renewal-command-client.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_BROWSER_RENEWAL_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://owned-renewal-auth.example.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-renewal-private-service-secret-6975',
  NEXTAUTH_SECRET: 'owned-distinct-original-jwe-reader-secret-6975',
};
type Prepared = Extract<BrowserRenewalReply, { outcome: 'prepared' }>;
const payload = (kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe') => ({
  bindingToken: 'A'.repeat(43),
  nonceHash: 'b'.repeat(64),
  actor: {
    version: 3,
    credential:
      kind === 'legacy-jwe'
        ? { kind, credential: 'owned-original-encrypted-source' }
        : { kind, token: 'owned-original-opaque-source' },
  },
});
function prepared(command: BrowserRenewalCommand): Prepared {
  const browserCursor = {
    bindingId: createHash('sha256').update(command.payload.bindingToken).digest('hex'),
    version: command.payload.actor.version,
    bindingExpiresAt: '2030-01-02T00:00:00.000Z',
  };
  return {
    browserRenewalProtocolVersion: 1,
    requestId: command.requestId,
    operation: 'prepare',
    outcome: 'prepared',
    operationToken: 'C'.repeat(43),
    preparationToken: 'D'.repeat(43),
    preparation: {
      version: 1,
      credentialKind: command.payload.actor.credential.kind,
      sourceCredentialProof: {
        version: 1,
        userId: 'owned-user',
        authSessionId: 'original-sid',
        generation: 4,
        authenticatedAt: null,
        linkGuarded: false,
      },
      sourceCredentialHash: browserRenewalSourceHash(command.payload.actor.credential),
      sourceExpiresAt: '2030-01-01T01:00:00.000Z',
      browserCursor,
      intentRevision: 2,
      futureBrowserCursor: {
        ...browserCursor,
        version: browserCursor.version + 1,
        bindingExpiresAt: '2030-01-31T00:00:00.000Z',
      },
      targetExpiresAt: '2030-01-31T00:00:00.000Z',
      preparedAt: '2030-01-01T00:00:00.000Z',
      expiresAt: '2030-01-01T00:01:00.000Z',
    },
  };
}
function fixture(respond: (command: BrowserRenewalCommand) => Response | Promise<Response>) {
  const send = vi.fn<typeof fetch>(async (_address, options) => {
    if (typeof options?.body !== 'string') throw new Error('Owned renewal fixture requires JSON');
    return respond(browserRenewalCommandSchema.parse(JSON.parse(options.body) as unknown));
  });
  return { send, client: createBrowserRenewalCommandClient({ environment, fetch: send }) };
}
describe('private browser renewal command transport', () => {
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'binds %s preparation to actual source possession and version',
    async (kind) => {
      const current = fixture((command) => Response.json(prepared(command)));
      const result = await current.client.prepare(payload(kind));
      expect(result).toMatchObject({ outcome: 'prepared', preparation: { credentialKind: kind } });
      expect(current.send).toHaveBeenCalledOnce();
      expect(current.send.mock.calls[0]?.[0]).toBe(
        environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN + BROWSER_RENEWAL_COMMAND_PATHS.prepare,
      );
      expect(new Headers(current.send.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
        `Bearer ${environment.CURRENT_STORE_AUTH_RPC_SECRET}`,
      );
    },
  );
  it.each([
    [
      'binding',
      (reply: Prepared) => {
        reply.preparation.browserCursor.bindingId = 'e'.repeat(64);
        reply.preparation.futureBrowserCursor.bindingId = 'e'.repeat(64);
      },
    ],
    [
      'version',
      (reply: Prepared) => {
        reply.preparation.browserCursor.version++;
        reply.preparation.futureBrowserCursor.version++;
      },
    ],
    [
      'source',
      (reply: Prepared) => {
        reply.preparation.sourceCredentialHash = 'f'.repeat(64);
      },
    ],
    [
      'kind',
      (reply: Prepared) => {
        reply.preparation.credentialKind = 'canonical-token';
      },
    ],
    [
      'request',
      (reply: Prepared) => {
        reply.requestId = randomUUID();
      },
    ],
  ] as const)('refuses substituted %s in a schema-valid reply', async (_label, change) => {
    const current = fixture((command) => {
      const result = prepared(command);
      change(result);
      return Response.json(result);
    });
    await expect(current.client.prepare(payload())).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(current.send).toHaveBeenCalledOnce();
  });
  for (const operation of ['finalize', 'acknowledge'] as const) {
    it(`${operation} accepts only the exact frozen future tuple`, async () => {
      const initial = payload();
      const seed = prepared({
        browserRenewalProtocolVersion: 1,
        requestId: randomUUID(),
        issuedAt: Date.now(),
        operation: 'prepare',
        payload: initial,
      });
      const current = fixture((command) =>
        Response.json({
          browserRenewalProtocolVersion: 1,
          requestId: command.requestId,
          operation,
          outcome: 'completed',
          cursor: seed.preparation.futureBrowserCursor,
          credentialProof: seed.preparation.sourceCredentialProof,
          credentialExpiresAt: seed.preparation.targetExpiresAt,
        }),
      );
      expect(
        await current.client[operation]({
          ...initial,
          operationToken: seed.operationToken,
          preparationToken: seed.preparationToken,
          preparation: seed.preparation,
          candidate: { kind: 'legacy-jwe', credential: 'actual-frozen-candidate' },
        }),
      ).toMatchObject({ outcome: 'completed' });
    });
    it(`${operation} never retries an unknown final response`, async () => {
      const initial = payload();
      const seed = prepared({
        browserRenewalProtocolVersion: 1,
        requestId: randomUUID(),
        issuedAt: Date.now(),
        operation: 'prepare',
        payload: initial,
      });
      const current = fixture(async () => {
        throw new Error('owned-connection-lost-after-commit');
      });
      await expect(
        current.client[operation]({
          ...initial,
          operationToken: seed.operationToken,
          preparationToken: seed.preparationToken,
          preparation: seed.preparation,
          candidate: { kind: 'legacy-jwe', credential: 'actual-frozen-candidate' },
        }),
      ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
      expect(current.send).toHaveBeenCalledOnce();
    });
  }
  it('refuses default/unknown modes before creating a transport or dispatching', () => {
    const send = vi.fn<typeof fetch>();
    for (const mode of [undefined, 'legacy', 'unknown'])
      expect(() =>
        createBrowserRenewalCommandClient({
          environment: { ...environment, CURRENT_STORE_BROWSER_RENEWAL_MODE: mode },
          fetch: send,
        }),
      ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses status/operation mismatches without retry', async () => {
    const current = fixture((command) => Response.json(prepared(command), { status: 409 }));
    await expect(current.client.prepare(payload())).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(current.send).toHaveBeenCalledOnce();
  });
});
