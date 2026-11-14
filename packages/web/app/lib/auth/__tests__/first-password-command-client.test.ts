// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol';
import {
  FIRST_PASSWORD_COMMAND_PATHS,
  firstPasswordCommandSchema,
  type FirstPasswordCommand,
  type FirstPasswordReply,
} from '@boardsesh/auth-protocol';

vi.mock('server-only', () => ({}));
import { createFirstPasswordCommandClient } from '../first-password-command-client.server';
import { providerCandidateCredentialHash } from '../provider-security-command-client.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_FIRST_PASSWORD_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://owned-auth.example.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-first-password-rpc-secret-at-least-32-bytes',
  NEXTAUTH_SECRET: 'owned-distinct-nextauth-secret-at-least-32-bytes',
};
const actor = (kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe') => ({
  kind,
  credential: 'actual-owned-source',
  expectedUserId: 'owned-user',
  expectedAuthSessionId: 'original-sid',
  browserBindingToken: 'A'.repeat(43),
  browserVersion: 2,
});
const bound = (kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe') => ({
  actor: actor(kind),
  challengeToken: 'B'.repeat(43),
  browserIntentToken: 'C'.repeat(43),
});
const preparePayload = (kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe') => ({
  ...bound(kind),
  confirmationToken: 'D'.repeat(43),
  password: ' exact password ',
  confirmPassword: ' exact password ',
});
const cursor = (command: FirstPasswordCommand, increment = 0) => ({
  bindingId: createHash('sha256').update(command.payload.actor.browserBindingToken).digest('hex'),
  version: command.payload.actor.browserVersion + increment,
  bindingExpiresAt: '2030-01-02T03:04:05.000Z',
});
type Prepared = Extract<FirstPasswordReply, { operation: 'prepare'; outcome: 'prepared' }>;
function prepared(command: FirstPasswordCommand): Prepared {
  return {
    firstPasswordVersion: 1,
    requestId: command.requestId,
    operation: 'prepare',
    outcome: 'prepared',
    preparationToken: 'E'.repeat(43),
    credentialProof: {
      version: 1,
      userId: 'owned-user',
      authSessionId: 'original-sid',
      generation: 4,
      authenticatedAt: null,
      linkGuarded: false,
      requiresAccountCutoff: true,
    },
    credentialExpiresAt: '2030-01-02T03:04:05.000Z',
    expiresAt: '2030-01-01T00:01:00.000Z',
    browserCursor: cursor(command),
    proposedCanonicalToken: command.payload.actor.kind === 'canonical-token' ? 'F'.repeat(43) : null,
    user: {
      id: 'owned-user',
      email: 'existing-owner@example.test',
      name: null,
      image: null,
      emailVerified: null,
      createdAt: '2019-01-01T00:00:00.000Z',
    },
  };
}
function fixture(reply: (command: FirstPasswordCommand) => Response | Promise<Response>) {
  const send = vi.fn<typeof fetch>(async (_input, options) => {
    if (typeof options?.body !== 'string') throw new Error('Owned fixture requires JSON');
    return reply(firstPasswordCommandSchema.parse(JSON.parse(options.body) as unknown));
  });
  return { send, client: createFirstPasswordCommandClient({ environment, fetch: send }) };
}

describe('first-password service transport', () => {
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'binds %s preparation to the fixed UID, original SID and browser view',
    async (kind) => {
      const current = fixture((command) => Response.json(prepared(command)));
      const result = await current.client.command('prepare', preparePayload(kind));
      expect(result).toMatchObject({
        outcome: 'prepared',
        credentialProof: { userId: 'owned-user', authSessionId: 'original-sid', authenticatedAt: null },
      });
      expect(current.send.mock.calls[0]?.[0]).toBe(
        `${environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN}${FIRST_PASSWORD_COMMAND_PATHS.prepare}`,
      );
      const options = current.send.mock.calls[0]?.[1];
      expect(options?.body).toContain(' exact password ');
      expect(new Headers(options?.headers).get('Authorization')).toBe(
        `Bearer ${environment.CURRENT_STORE_AUTH_RPC_SECRET}`,
      );
    },
  );
  it.each([
    [
      'request ID',
      (reply: Prepared) => {
        reply.requestId = randomUUID();
      },
    ],
    [
      'profile UID',
      (reply: Prepared) => {
        reply.user.id = 'different-user';
      },
    ],
    [
      'credential UID',
      (reply: Prepared) => {
        reply.credentialProof.userId = 'different-user';
      },
    ],
    [
      'original SID',
      (reply: Prepared) => {
        reply.credentialProof.authSessionId = 'new-session';
      },
    ],
    [
      'binding',
      (reply: Prepared) => {
        reply.browserCursor.bindingId = 'e'.repeat(64);
      },
    ],
    [
      'version',
      (reply: Prepared) => {
        reply.browserCursor.version++;
      },
    ],
    [
      'proposal kind',
      (reply: Prepared) => {
        reply.proposedCanonicalToken = 'F'.repeat(43);
      },
    ],
  ] as const)('refuses changed %s before exposing a candidate', async (_label, change) => {
    const current = fixture((command) => {
      const reply = prepared(command);
      change(reply);
      return Response.json(reply);
    });
    await expect(current.client.command('prepare', preparePayload())).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });
  it('preserves an original credential lifetime longer than its browser binding', async () => {
    const current = fixture((command) =>
      Response.json({
        ...prepared(command),
        credentialExpiresAt: '2031-01-01T00:00:00.000Z',
      }),
    );
    expect(await current.client.command('prepare', preparePayload())).toMatchObject({
      credentialExpiresAt: '2031-01-01T00:00:00.000Z',
    });
  });
  it('keeps the recipient and confirmation token in the service-only mail plan', async () => {
    const current = fixture((command) =>
      Response.json({
        firstPasswordVersion: 1,
        requestId: command.requestId,
        operation: 'request',
        outcome: 'issued',
        challengeToken: 'B'.repeat(43),
        recoveryToken: 'C'.repeat(43),
        browserIntentToken: 'D'.repeat(43),
        browserCursor: cursor(command),
        expiresAt: '2030-01-01T00:01:00.000Z',
        mailPlan: {
          kind: 'uid-first-password-v1',
          recipient: 'existing-owner@example.test',
          token: 'E'.repeat(43),
          expiresAt: '2030-01-01T00:01:00.000Z',
        },
      }),
    );
    expect(await current.client.command('request', { actor: actor() })).toMatchObject({
      outcome: 'issued',
      mailPlan: { kind: 'uid-first-password-v1', recipient: 'existing-owner@example.test' },
    });
    expect(current.send.mock.calls[0]?.[1]?.body).not.toContain('existing-owner@example.test');
  });
  it.each(['finalize', 'recover'] as const)(
    'admits only the exact %s candidate and generation+1 view',
    async (operation) => {
      const candidate = { kind: 'canonical-token' as const, credential: 'F'.repeat(43) };
      const current = fixture((command) =>
        Response.json({
          firstPasswordVersion: 1,
          requestId: command.requestId,
          operation,
          outcome: operation === 'finalize' ? 'committed' : 'recovered',
          candidateCredentialHash: providerCandidateCredentialHash(candidate),
          browserCursor: cursor(command, 1),
        }),
      );
      const payload = { ...bound('canonical-token'), preparationToken: 'E'.repeat(43), candidate };
      const result =
        operation === 'finalize'
          ? await current.client.command(operation, payload)
          : await current.client.command(operation, { ...payload, recoveryToken: 'G'.repeat(43) });
      expect(result.outcome).toBe(operation === 'finalize' ? 'committed' : 'recovered');
      expect(current.send).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects an ACK for another candidate', async () => {
    const current = fixture((command) =>
      Response.json({
        firstPasswordVersion: 1,
        requestId: command.requestId,
        operation: 'finalize',
        outcome: 'committed',
        candidateCredentialHash: 'e'.repeat(64),
        browserCursor: cursor(command, 1),
      }),
    );
    await expect(
      current.client.command('finalize', {
        ...bound(),
        preparationToken: 'E'.repeat(43),
        candidate: { kind: 'legacy-jwe', credential: 'actual-candidate' },
      }),
    ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });
  it('does not retry after a lost finalization response', async () => {
    const current = fixture(async () => {
      throw new Error('Owned post-commit reply loss');
    });
    await expect(
      current.client.command('finalize', {
        ...bound(),
        preparationToken: 'E'.repeat(43),
        candidate: { kind: 'legacy-jwe', credential: 'actual-candidate' },
      }),
    ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(current.send).toHaveBeenCalledTimes(1);
  });
  it('refuses disabled mode before connecting', () => {
    const send = vi.fn<typeof fetch>();
    expect(() =>
      createFirstPasswordCommandClient({
        environment: { ...environment, CURRENT_STORE_FIRST_PASSWORD_MODE: 'legacy' },
        fetch: send,
      }),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(send).not.toHaveBeenCalled();
  });
});
