// @vitest-environment node
import { decode, encode, type JWT } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
import type { WebCredentialProof } from '@boardsesh/auth-protocol';
import { verifyLegacyNextAuthJwe } from '../../backend/src/auth/legacy-web-credentials';
vi.mock('server-only', () => ({}));
import {
  issuePreparedProviderSecurityCredential,
  prepareProviderSecurityPublicationResponse,
  type PrepareProviderSecurityCookies,
} from '@/app/lib/auth/provider-security-publication.server';
import { providerCandidateCredentialHash } from '@/app/lib/auth/provider-security-command-client.server';

const clock = Date.UTC(2026, 10, 13, 10, 0, 0, 500);
const secret = 'owned-provider-direct-unlink-actual-jwe-secret';
const expiry = new Date(Math.floor(clock / 1000) * 1000 + 3600_000).toISOString();
function proof(known = true): WebCredentialProof {
  return {
    version: 1,
    userId: 'owned-user',
    authSessionId: 'owned-session',
    generation: 7,
    authenticatedAt: known ? '2026-10-01T00:00:00.000Z' : null,
    linkGuarded: known,
    requiresAccountCutoff: true,
  };
}
async function source(known = true) {
  const original = proof(known);
  const claims: JWT = {
    sub: original.userId,
    authSessionId: original.authSessionId,
    gen: original.generation,
    ...(original.authenticatedAt ? { auth_time: Date.parse(original.authenticatedAt) / 1000, link_guarded: true } : {}),
    legacy_no_sid: true,
    name: 'Owned climber',
    email: 'owned@example.test',
    picture: 'https://owned.example.test/avatar',
  };
  return {
    source: { kind: 'legacy-jwe' as const, credential: await encode({ token: claims, secret, maxAge: 3600 }) },
    sourceCredentialProof: original,
    credentialExpiresAt: expiry,
    prepared: {
      credentialProof: { ...original, generation: 8 },
      credentialExpiresAt: expiry,
      proposedCanonicalToken: null,
    },
  };
}
function responseInput() {
  const candidate = { kind: 'canonical-token' as const, credential: 'C'.repeat(43) };
  const cursor = { bindingId: 'a'.repeat(64), version: 4, bindingExpiresAt: expiry };
  const prepareCookiePublication: PrepareProviderSecurityCookies = (input) => ({
    cursor: input.cursor,
    candidateCredentialHash: providerCandidateCredentialHash(input.candidate),
    headers: [`__Host-owned-proof=${input.candidate.credential}; Path=/; Secure; HttpOnly; SameSite=Lax`],
  });
  return {
    candidate,
    cursor,
    credentialExpiresAt: expiry,
    preparationExpiresAt: new Date(clock + 300_000).toISOString(),
    frameworkHeaders: [],
    prepareCookiePublication,
    response: {
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json', 'Content-Length': '999' }),
      body: new TextEncoder().encode('{"outcome":"completed"}'),
    },
  };
}
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: clock }));
afterEach(() => vi.useRealTimers());

describe('shared direct unlink actual-credential issuance', () => {
  it.each([true, false])(
    'preserves actual JWE metadata and exact expiry with known age=%s without OAuth callbacks',
    async (known) => {
      const input = await source(known);
      const candidate = await issuePreparedProviderSecurityCredential(input, { secret });
      const claims = await decode({ token: candidate.credential, secret });
      expect(candidate.kind).toBe('legacy-jwe');
      expect(candidate.credential).not.toBe(input.source.credential);
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(claims).toMatchObject({
        sub: 'owned-user',
        authSessionId: 'owned-session',
        gen: 8,
        legacy_no_sid: true,
        name: 'Owned climber',
        email: 'owned@example.test',
        picture: 'https://owned.example.test/avatar',
        exp: Date.parse(expiry) / 1000,
      });
      expect(claims?.auth_time).toBe(known ? Date.parse(proof().authenticatedAt!) / 1000 : undefined);
      expect(claims?.link_guarded).toBe(known ? true : undefined);
    },
  );
  it.each(['missing-sid-gen', 'unguarded-age'] as const)(
    'continues actual backend-verified historical %s without inferring authentication age',
    async (historical) => {
      const credential = await encode({
        secret,
        maxAge: 3600,
        token: {
          sub: 'owned-user',
          name: 'Historical climber',
          ...(historical === 'unguarded-age'
            ? { authSessionId: 'owned-session', gen: 7, auth_time: Date.parse('2026-10-01T00:00:00.000Z') / 1000 }
            : {}),
        },
      });
      const verified = await verifyLegacyNextAuthJwe(credential, secret, new Date(clock));
      if (!verified) throw new Error('Owned backend historical verifier refused fixture');
      const original: WebCredentialProof = {
        version: 1,
        userId: verified.userId,
        authSessionId: verified.authSessionId ?? verified.lineageId,
        generation: verified.generation,
        authenticatedAt: verified.linkGuarded ? (verified.originalAuthenticatedAt?.toISOString() ?? null) : null,
        linkGuarded: verified.linkGuarded,
        ...(verified.requiresAccountCutoff ? { requiresAccountCutoff: true } : {}),
      };
      const candidate = await issuePreparedProviderSecurityCredential(
        {
          source: { kind: 'legacy-jwe', credential },
          sourceCredentialProof: original,
          credentialExpiresAt: verified.expiresAt.toISOString(),
          prepared: {
            credentialProof: { ...original, generation: original.generation + 1 },
            credentialExpiresAt: verified.expiresAt.toISOString(),
            proposedCanonicalToken: null,
          },
        },
        { secret },
      );
      const actual = await decode({ token: candidate.credential, secret });
      expect(actual).toMatchObject({
        sub: original.userId,
        authSessionId: original.authSessionId,
        gen: original.generation + 1,
        name: 'Historical climber',
        exp: verified.expiresAt.getTime() / 1000,
      });
      expect(actual?.auth_time).toBeUndefined();
      expect(actual?.link_guarded).toBeUndefined();
      expect(actual?.legacy_no_sid).toBe(historical === 'missing-sid-gen' ? true : undefined);
      if (historical === 'missing-sid-gen') {
        const old = await decode({ token: credential, secret });
        expect(actual?.authSessionId).toBe(verified.lineageId);
        expect(actual?.authSessionId).not.toBe(old?.jti);
      }
    },
  );
  it.each(['A'.repeat(43), 'b8422d75-7960-4aee-9fd6-75cb3c0cc6a7', 'owned canonical source / é'])(
    'preserves bounded opaque canonical source %s and uses only its distinct backend proposal',
    async (credential) => {
      const original = proof();
      const input = {
        source: { kind: 'canonical-token' as const, credential },
        sourceCredentialProof: original,
        credentialExpiresAt: expiry,
        prepared: {
          credentialProof: { ...original, generation: 8 },
          credentialExpiresAt: expiry,
          proposedCanonicalToken: 'B'.repeat(43),
        },
      };
      const encoder = vi.fn(encode);
      expect(await issuePreparedProviderSecurityCredential(input, { secret, encode: encoder })).toEqual({
        kind: 'canonical-token',
        credential: 'B'.repeat(43),
      });
      expect(encoder).not.toHaveBeenCalled();
      input.prepared.proposedCanonicalToken = input.source.credential;
      await expect(issuePreparedProviderSecurityCredential(input, { secret })).rejects.toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
    },
  );
  it('rejects canonical source UTF-8 byte overflow before encoding', async () => {
    const original = proof();
    const input = {
      source: { kind: 'canonical-token' as const, credential: 'é'.repeat(2049) },
      sourceCredentialProof: original,
      credentialExpiresAt: expiry,
      prepared: {
        credentialProof: { ...original, generation: 8 },
        credentialExpiresAt: expiry,
        proposedCanonicalToken: 'B'.repeat(43),
      },
    };
    expect(input.source.credential.length).toBeLessThan(4096);
    const encoder = vi.fn(encode);
    await expect(issuePreparedProviderSecurityCredential(input, { secret, encode: encoder })).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
    expect(encoder).not.toHaveBeenCalled();
  });
  it.each(['source-proof', 'prepared-age', 'prepared-expiry', 'original-expiry'] as const)(
    'rejects %s drift before the real encoder runs',
    async (fault) => {
      const input = await source();
      if (fault === 'source-proof') input.sourceCredentialProof.generation = 6;
      if (fault === 'prepared-age') input.prepared.credentialProof.authenticatedAt = new Date(clock).toISOString();
      if (fault === 'prepared-expiry')
        input.prepared.credentialExpiresAt = new Date(Date.parse(expiry) + 1000).toISOString();
      if (fault === 'original-expiry') {
        input.credentialExpiresAt = new Date(Date.parse(expiry) - 1000).toISOString();
        input.prepared.credentialExpiresAt = input.credentialExpiresAt;
      }
      const encoder = vi.fn(encode);
      await expect(issuePreparedProviderSecurityCredential(input, { secret, encode: encoder })).rejects.toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
      expect(encoder).not.toHaveBeenCalled();
    },
  );
  it.each(['UID', 'SID', 'generation', 'marker', 'subsecond-age'] as const)(
    'rejects aligned source/prepared %s drift against the actual signed modern source',
    async (drift) => {
      const input = await source();
      if (drift === 'UID') {
        input.sourceCredentialProof.userId = 'other-user';
        input.prepared.credentialProof.userId = 'other-user';
      }
      if (drift === 'SID') {
        input.sourceCredentialProof.authSessionId = 'other-session';
        input.prepared.credentialProof.authSessionId = 'other-session';
      }
      if (drift === 'generation') {
        input.sourceCredentialProof.generation = 8;
        input.prepared.credentialProof.generation = 9;
      }
      if (drift === 'marker') {
        delete input.sourceCredentialProof.requiresAccountCutoff;
        delete input.prepared.credentialProof.requiresAccountCutoff;
      }
      if (drift === 'subsecond-age') {
        input.sourceCredentialProof.authenticatedAt = '2026-10-01T00:00:00.001Z';
        input.prepared.credentialProof.authenticatedAt = input.sourceCredentialProof.authenticatedAt;
      }
      const encoder = vi.fn(encode);
      await expect(issuePreparedProviderSecurityCredential(input, { secret, encode: encoder })).rejects.toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
      expect(encoder).not.toHaveBeenCalled();
    },
  );
});

describe('shared synchronous response preflight before provider finalization', () => {
  it('builds an independent complete unlink response and captured cookie plan before mutation', async () => {
    const input = responseInput();
    const publication = prepareProviderSecurityPublicationResponse(input);
    input.response.body.fill(0);
    input.response.headers.set('Content-Type', 'text/plain');
    input.cursor.version = 99;
    expect(await publication.response.json()).toEqual({ outcome: 'completed' });
    expect(publication.response.headers.get('Content-Type')).toBe('application/json');
    expect(publication.response.headers.has('Content-Length')).toBe(false);
    expect(publication.response.headers.getSetCookie()).toHaveLength(1);
    expect(publication.plan.cursor.version).toBe(4);
    expect(Object.isFrozen(publication.plan.headers)).toBe(true);
  });
  it.each([
    'wrong-hash',
    'wrong-version',
    'correlation',
    'utf8-cookie',
    'aggregate-headers',
    'header-count',
    'legacy-cookie',
    'retained-correlation',
  ] as const)('refuses %s before caller finalization can begin', (fault) => {
    const input = responseInput();
    const original = input.prepareCookiePublication;
    input.prepareCookiePublication = (request) => {
      const plan = original(request);
      if (fault === 'wrong-hash') return { ...plan, candidateCredentialHash: 'f'.repeat(64) };
      if (fault === 'wrong-version') return { ...plan, cursor: { ...plan.cursor, version: plan.cursor.version + 1 } };
      if (fault === 'correlation') return { ...plan, headers: ['__Host-boardsesh.browser-binding=cleared; Max-Age=0'] };
      if (fault === 'utf8-cookie') return { ...plan, headers: [`__Host-owned-proof=${'é'.repeat(2100)}`] };
      if (fault === 'header-count')
        return { ...plan, headers: Array.from({ length: 33 }, (_, index) => `owned-${index}=x`) };
      return plan;
    };
    if (fault === 'aggregate-headers') input.response.headers.set('x-owned-metadata', 'é'.repeat(16_385));
    if (fault === 'legacy-cookie') input.response.headers.append('Set-Cookie', '__Secure-next-auth.session-token=old');
    if (fault === 'retained-correlation')
      input.response.headers.append('Set-Cookie', '__Host-boardsesh.browser-binding=old; Max-Age=0');
    const finalize = vi.fn();
    expect(() => {
      prepareProviderSecurityPublicationResponse(input);
      finalize();
    }).toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(finalize).not.toHaveBeenCalled();
  });
});
