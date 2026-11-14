// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_BACKEND_UNAVAILABLE,
  PROVIDER_SECURITY_COMMAND_PATHS,
  PROVIDER_SECURITY_RESPONSE_BYTES,
  providerSecurityCommandSchema,
  type ProviderSecurityActor,
  type ProviderSecurityCommand,
  type ProviderSecurityReply,
} from '@boardsesh/auth-protocol';

vi.mock('server-only', () => ({}));
import {
  createProviderSecurityCommandClient,
  providerCandidateCredentialHash,
} from '../provider-security-command-client.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://owned-auth.example.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-provider-rpc-secret-at-least-32-bytes',
  NEXTAUTH_SECRET: 'owned-distinct-nextauth-secret-at-least-32-bytes',
};
const actor = (): ProviderSecurityActor => ({
  kind: 'legacy-jwe',
  credential: 'owned-current-source-credential',
  expectedUserId: 'owned-user',
  expectedAuthSessionId: 'owned-session',
  browserBindingToken: 'A'.repeat(43),
  browserVersion: 2,
});
const bound = () => ({ actor: actor(), intentToken: 'B'.repeat(43), browserIntentToken: 'C'.repeat(43) });
const preparePayload = () => ({
  ...bound(),
  reauthenticationToken: 'D'.repeat(43),
  flowHash: 'a'.repeat(64),
  providerProof: {
    provider: 'google' as const,
    subject: 'owned-subject',
    email: 'owner@example.test',
    emailVerified: true,
  },
});
type PreparedReply = Extract<ProviderSecurityReply, { outcome: 'prepared' }>;
function prepared(command: ProviderSecurityCommand): PreparedReply {
  return {
    providerSecurityVersion: 1,
    operation: 'prepare',
    requestId: command.requestId,
    outcome: 'prepared',
    preparationToken: 'E'.repeat(43),
    credentialProof: {
      version: 1,
      userId: 'owned-user',
      authSessionId: 'owned-session',
      generation: 4,
      authenticatedAt: '2020-01-02T03:04:05.000Z',
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    credentialExpiresAt: '2030-01-02T03:04:05.000Z',
    expiresAt: '2030-01-01T00:01:00.000Z',
    browserCursor: {
      bindingId: createHash('sha256').update(command.payload.actor.browserBindingToken).digest('hex'),
      version: command.payload.actor.browserVersion,
      bindingExpiresAt: '2030-01-02T03:04:05.000Z',
    },
    proposedCanonicalToken: command.payload.actor.kind === 'canonical-token' ? 'F'.repeat(43) : null,
    user: {
      id: 'owned-user',
      email: 'owner@example.test',
      name: null,
      image: null,
      emailVerified: null,
      createdAt: '2019-01-01T00:00:00.000Z',
    },
  };
}
function parsedRequest(settings: RequestInit | undefined): ProviderSecurityCommand {
  if (typeof settings?.body !== 'string') throw new Error('Owned fixture expected JSON');
  return providerSecurityCommandSchema.parse(JSON.parse(settings.body) as unknown);
}
function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}
function fixture(reply: (command: ProviderSecurityCommand) => Response | Promise<Response>) {
  const send = vi.fn<typeof fetch>(async (_input, settings) => reply(parsedRequest(settings)));
  return { send, client: createProviderSecurityCommandClient({ environment, fetch: send }) };
}

describe('private provider security command client', () => {
  it('uses only the fixed private path and service credential and retains original proof metadata', async () => {
    const current = fixture((command) => json(prepared(command)));
    const reply = await current.client.command('prepare', preparePayload());
    expect(reply.outcome).toBe('prepared');
    if (reply.outcome !== 'prepared') throw new Error('Owned fixture did not prepare');
    expect(reply.credentialProof).toMatchObject({
      generation: 4,
      authenticatedAt: '2020-01-02T03:04:05.000Z',
      requiresAccountCutoff: true,
    });
    const [destination, settings] = current.send.mock.calls[0];
    expect(destination).toBe(
      `${environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN}${PROVIDER_SECURITY_COMMAND_PATHS.prepare}`,
    );
    expect(settings).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${environment.CURRENT_STORE_AUTH_RPC_SECRET}`,
        'Content-Type': 'application/json',
      },
    });
    expect(new Headers(settings?.headers).has('Cookie')).toBe(false);
  });

  it.each(['legacy', 'misspelled', ''] as const)('refuses the %s mode before transport', (mode) => {
    const send = vi.fn<typeof fetch>();
    expect(() =>
      createProviderSecurityCommandClient({
        environment: { ...environment, CURRENT_STORE_PROVIDER_SECURITY_MODE: mode },
        fetch: send,
      }),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [
      'user',
      (reply: PreparedReply) => {
        reply.user.id = 'other-user';
      },
    ],
    [
      'proof user',
      (reply: PreparedReply) => {
        reply.credentialProof.userId = 'other-user';
      },
    ],
    [
      'SID',
      (reply: PreparedReply) => {
        reply.credentialProof.authSessionId = 'other-session';
      },
    ],
    [
      'binding',
      (reply: PreparedReply) => {
        reply.browserCursor.bindingId = 'f'.repeat(64);
      },
    ],
    [
      'version',
      (reply: PreparedReply) => {
        reply.browserCursor.version += 1;
      },
    ],
    [
      'kind proposal',
      (reply: PreparedReply) => {
        reply.proposedCanonicalToken = 'F'.repeat(43);
      },
    ],
  ] as const)('rejects a reply with a mismatched %s', async (_description, mutate) => {
    const current = fixture((command) => {
      const reply = prepared(command);
      mutate(reply);
      return json(reply);
    });
    await expect(current.client.command('prepare', preparePayload())).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(current.send).toHaveBeenCalledTimes(1);
  });

  it('requires the canonical proposal when the admitted source kind is canonical', async () => {
    const current = fixture((command) => json({ ...prepared(command), proposedCanonicalToken: null }));
    const payload = preparePayload();
    payload.actor.kind = 'canonical-token';
    await expect(current.client.command('prepare', payload)).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });

  it.each(['request', 'operation', 'status'] as const)('rejects a mismatched %s correlation', async (mismatch) => {
    const current = fixture((command) => {
      if (mismatch === 'operation')
        return json({
          providerSecurityVersion: 1,
          operation: 'abort',
          requestId: command.requestId,
          outcome: 'aborted',
        });
      const reply = prepared(command);
      if (mismatch === 'request') reply.requestId = randomUUID();
      return json(reply, mismatch === 'status' ? 503 : 200);
    });
    await expect(current.client.command('prepare', preparePayload())).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });

  it('captures nested actor and exact candidate before caller mutation while awaiting the finalizer', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = fixture(async (command) => {
      if (command.operation !== 'finalize') throw new Error('Owned fixture expected finalize');
      await gate;
      return json({
        providerSecurityVersion: 1,
        operation: 'finalize',
        requestId: command.requestId,
        outcome: 'committed',
        candidateCredentialHash: providerCandidateCredentialHash(command.payload.candidate),
        browserCursor: { ...prepared(command).browserCursor, version: command.payload.actor.browserVersion + 1 },
      });
    });
    const payload = {
      ...bound(),
      reauthenticationToken: 'D'.repeat(43),
      preparationToken: 'E'.repeat(43),
      candidate: { kind: 'legacy-jwe' as const, credential: 'owned-exact-candidate' },
    };
    const pending = current.client.command('finalize', payload);
    payload.actor.expectedUserId = 'hostile-new-user';
    payload.actor.browserVersion = 123;
    payload.candidate.credential = 'hostile-new-candidate';
    release();
    await expect(pending).resolves.toMatchObject({
      outcome: 'committed',
      candidateCredentialHash: providerCandidateCredentialHash({
        kind: 'legacy-jwe',
        credential: 'owned-exact-candidate',
      }),
    });
    expect(current.send).toHaveBeenCalledTimes(1);
  });

  it('rejects a finalizer hash for different credential bytes without retrying', async () => {
    const current = fixture((command) =>
      json({
        providerSecurityVersion: 1,
        operation: 'finalize',
        requestId: command.requestId,
        outcome: 'committed',
        candidateCredentialHash: 'f'.repeat(64),
        browserCursor: { ...prepared(command).browserCursor, version: 3 },
      }),
    );
    await expect(
      current.client.command('finalize', {
        ...bound(),
        reauthenticationToken: 'D'.repeat(43),
        preparationToken: 'E'.repeat(43),
        candidate: { kind: 'legacy-jwe', credential: 'owned-candidate' },
      }),
    ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(current.send).toHaveBeenCalledTimes(1);
  });

  it('enforces the larger explicit UTF-8 request budget before any network call', async () => {
    const current = fixture((command) => json(prepared(command)));
    const payload = {
      ...bound(),
      reauthenticationToken: 'D'.repeat(43),
      preparationToken: 'E'.repeat(43),
      candidate: { kind: 'legacy-jwe' as const, credential: '😀'.repeat(32_768) },
    };
    payload.actor.credential = '😀'.repeat(32_768);
    await expect(current.client.command('finalize', payload)).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(current.send).not.toHaveBeenCalled();
  });

  it('refuses oversized reply bytes without retaining their private content', async () => {
    const privateContent = 'owned-private-server-content';
    const current = fixture(
      () =>
        new Response(privateContent.repeat(PROVIDER_SECURITY_RESPONSE_BYTES), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(current.client.command('prepare', preparePayload())).rejects.toMatchObject({
      message: AUTH_BACKEND_UNAVAILABLE,
    });
    expect(current.send).toHaveBeenCalledTimes(1);
  });
});
