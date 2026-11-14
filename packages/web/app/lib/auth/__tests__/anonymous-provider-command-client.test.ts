// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  anonymousProviderCommandSchema,
  type AnonymousProviderCommand,
  type AnonymousProviderReply,
} from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import { createAnonymousProviderCommandClient } from '../anonymous-provider-command-client.server';
import { providerCandidateCredentialHash } from '../provider-security-command-client.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://owned-auth.example.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-anonymous-rpc-secret-at-least-32-bytes',
  NEXTAUTH_SECRET: 'owned-distinct-nextauth-secret-at-least-32-bytes',
};
const browser = { bindingToken: 'A'.repeat(43), expectedVersion: 2 };
const identity = {
  sub: 'verified-provider-subject',
  email: 'verified@example.test',
  emailVerified: true,
  name: 'Verified Name',
  image: null,
};
function preparePayload() {
  return {
    browser,
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    flowHash: 'a'.repeat(64),
    nonceHash: 'b'.repeat(64),
    credentialKind: 'canonical-token' as const,
    providerProof: {
      provider: 'google' as const,
      identity: { ...identity },
      idToken: 'actual-verified-google-id-token',
      nonce: 'actual-nonce',
    },
  };
}
function prepared(command: AnonymousProviderCommand): Extract<AnonymousProviderReply, { outcome: 'prepared' }> {
  return {
    anonymousProviderVersion: 1,
    requestId: command.requestId,
    operation: 'prepare',
    outcome: 'prepared',
    preparationToken: 'D'.repeat(43),
    proposedCanonicalToken: 'E'.repeat(43),
    browserCursor: {
      bindingId: createHash('sha256').update(browser.bindingToken).digest('hex'),
      version: 2,
      bindingExpiresAt: '2030-01-03T00:00:00.000Z',
    },
    preparation: {
      credentialKind: 'canonical-token',
      verifiedIdentity: { ...identity },
      identityPlan: {
        kind: 'new',
        provider: 'google',
        subject: identity.sub,
        generation: 0,
        user: {
          id: 'backend-fixed-user',
          email: identity.email,
          name: identity.name,
          image: null,
          emailVerified: null,
          createdAt: '2026-11-14T12:00:00.000Z',
        },
      },
      credentialProof: {
        version: 1,
        userId: 'backend-fixed-user',
        authSessionId: 'backend-fixed-session',
        generation: 0,
        authenticatedAt: null,
        linkGuarded: false,
      },
      credentialExpiresAt: '2030-01-02T00:00:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
      proposedCanonicalTokenHash: providerCandidateCredentialHash({
        kind: 'canonical-token',
        credential: 'E'.repeat(43),
      }),
    },
  };
}
function command(settings: RequestInit | undefined) {
  if (typeof settings?.body !== 'string') throw new Error('expected JSON');
  return anonymousProviderCommandSchema.parse(JSON.parse(settings.body) as unknown);
}
describe('distinct anonymous provider private web client', () => {
  it('sends one strict source-free command and authenticates only the fixed private service', async () => {
    const send = vi.fn<typeof fetch>(async (url, settings) => {
      expect(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).toBe(
        'https://owned-auth.example.test/api/internal/auth/anonymous-provider/v1/prepare',
      );
      expect(new Headers(settings?.headers).get('authorization')).toBe(
        `Bearer ${environment.CURRENT_STORE_AUTH_RPC_SECRET}`,
      );
      expect(settings?.redirect).toBe('error');
      const captured = command(settings);
      expect(captured.payload).not.toHaveProperty('actor');
      return Response.json(prepared(captured));
    });
    const result = await createAnonymousProviderCommandClient({ environment, fetch: send }).command(
      'prepare',
      preparePayload(),
    );
    expect(result.outcome).toBe('prepared');
    expect(send).toHaveBeenCalledOnce();
  });
  it.each(['off', 'legacy', 'unexpected'] as const)('rejects mode %s before transport', (mode) => {
    const send = vi.fn<typeof fetch>();
    expect(() =>
      createAnonymousProviderCommandClient({
        environment: { ...environment, CURRENT_STORE_PROVIDER_SECURITY_MODE: mode },
        fetch: send,
      }),
    ).toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['actor', 'assertedUserId', 'database'])('refuses extra %s before fetch', async (field) => {
    const send = vi.fn<typeof fetch>();
    await expect(
      createAnonymousProviderCommandClient({ environment, fetch: send }).command(
        'prepare',
        Object.assign(preparePayload(), { [field]: null }),
      ),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    'request-id',
    'operation',
    'cursor-owner',
    'cursor-version',
    'credential-kind',
    'provider-subject',
    'verified-profile',
    'proof-user',
    'proposal',
    'expiry',
    'status',
  ])('refuses mismatched %s private replies', async (fault) => {
    const send = vi.fn<typeof fetch>(async (_url, settings) => {
      const reply = prepared(command(settings));
      if (fault === 'request-id') reply.requestId = '00000000-0000-4000-8000-000000000000';
      if (fault === 'operation') return Response.json({ ...reply, operation: 'intent' });
      if (fault === 'cursor-owner') reply.browserCursor.bindingId = 'f'.repeat(64);
      if (fault === 'cursor-version') reply.browserCursor.version += 1;
      if (fault === 'credential-kind') reply.preparation.credentialKind = 'legacy-jwe';
      if (fault === 'provider-subject') reply.preparation.identityPlan.subject = 'another-subject';
      if (fault === 'verified-profile') reply.preparation.verifiedIdentity.name = 'Unrelated profile';
      if (fault === 'proof-user') reply.preparation.credentialProof.userId = 'asserted-user';
      if (fault === 'proposal') reply.proposedCanonicalToken = 'F'.repeat(43);
      if (fault === 'expiry') reply.preparation.expiresAt = '2030-01-04T00:00:00.000Z';
      return Response.json(reply, { status: fault === 'status' ? 409 : 200 });
    });
    await expect(
      createAnonymousProviderCommandClient({ environment, fetch: send }).command('prepare', preparePayload()),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
  it('does not retry an uncertain finalizer or retain its transport cause', async () => {
    const target = prepared({
      requestId: '00000000-0000-4000-8000-000000000000',
    } as AnonymousProviderCommand).preparation;
    const send = vi.fn<typeof fetch>(async () => {
      throw new Error('SECRET_DATABASE_CAUSE');
    });
    const promise = createAnonymousProviderCommandClient({ environment, fetch: send }).command('finalize', {
      browser,
      intentToken: 'B'.repeat(43),
      browserIntentToken: 'C'.repeat(43),
      flowHash: 'a'.repeat(64),
      nonceHash: 'b'.repeat(64),
      preparationToken: 'D'.repeat(43),
      preparation: target,
      candidate: { kind: 'canonical-token', credential: 'E'.repeat(43) },
    });
    await expect(promise).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
});
