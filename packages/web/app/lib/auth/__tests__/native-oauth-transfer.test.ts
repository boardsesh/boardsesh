import { createHmac } from 'node:crypto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
vi.mock('server-only', () => ({}));
import {
  issueNativeOAuthTransferToken,
  verifyNativeOAuthTransferToken,
  issueNativeOAuthAttempt,
  verifyNativeOAuthAttempt,
} from '../native-oauth-transfer';

describe('native OAuth transfer token', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'));
    vi.stubEnv('NEXTAUTH_SECRET', 'test-nextauth-secret');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('issues and verifies a valid token', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: '/settings',
    });

    expect(verifyNativeOAuthTransferToken(token)).toEqual({ generation: 0, userId: 'user_123', nextPath: '/settings' });
  });

  it('signs the supplied login generation without introducing authentication age', () => {
    const transfer = issueNativeOAuthTransferToken({
      userId: 'transfer-generation-fixture',
      nextPath: '/',
      generation: 5,
    });
    const claims = JSON.parse(Buffer.from(transfer.split('.')[0], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(claims.gen).toBe(5);
    expect(claims).not.toHaveProperty('auth_time');
    expect(verifyNativeOAuthTransferToken(transfer)).toEqual({
      generation: 5,
      userId: 'transfer-generation-fixture',
      nextPath: '/',
    });
    const legacy = issueNativeOAuthTransferToken({ userId: 'transfer-generation-fixture', nextPath: '/' });
    const legacyClaims = JSON.parse(Buffer.from(legacy.split('.')[0], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(legacyClaims.gen).toBe(0);
  });

  it('carries the source SID without an account-creation receipt or fresh authentication age', () => {
    const transfer = issueNativeOAuthTransferToken({
      userId: 'transfer-source-fixture',
      authSessionId: 'source-session-fixture',
      generation: 5,
      nextPath: '/',
    });
    const claims = JSON.parse(Buffer.from(transfer.split('.')[0], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(claims.authSessionId).toBe('source-session-fixture');
    expect(claims.gen).toBe(5);
    expect(claims).not.toHaveProperty('auth_time');
    expect(claims).not.toHaveProperty('accountCreation');
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses invalid generation %s', (generation) => {
    expect(() =>
      issueNativeOAuthTransferToken({ userId: 'transfer-generation-fixture', nextPath: '/', generation }),
    ).toThrow('Invalid native OAuth transfer generation');
  });

  it('keeps a creation receipt bound to its signed user, provider, session and attempt', () => {
    const userId = '602c83bf-e090-4c90-9f7e-08ca0b6b5dad';
    const accountCreation = {
      userId,
      accountCreated: true,
      provider: 'google' as const,
      createdAt: '2026-04-03T12:00:00.000Z',
    };
    const options = {
      userId,
      nextPath: '/',
      accountCreation,
      authSessionId: 'login-1',
      attemptId: 'a'.repeat(32),
      provider: 'google' as const,
    };
    const credentialProof = {
      version: 1,
      userId,
      authSessionId: 'login-1',
      generation: 0,
      authenticatedAt: null,
      linkGuarded: false,
    };
    expect(verifyNativeOAuthTransferToken(issueNativeOAuthTransferToken(options))).toEqual({
      generation: 0,
      userId,
      nextPath: '/',
      accountCreation,
      credentialProof,
    });
    expect(
      verifyNativeOAuthTransferToken(issueNativeOAuthTransferToken({ ...options, userId: 'another-user' })),
    ).toEqual({
      generation: 0,
      userId: 'another-user',
      nextPath: '/',
      credentialProof: { ...credentialProof, userId: 'another-user' },
    });
    expect(verifyNativeOAuthTransferToken(issueNativeOAuthTransferToken({ ...options, provider: 'apple' }))).toEqual({
      generation: 0,
      userId,
      nextPath: '/',
      credentialProof,
    });
  });

  it('validates the signed anonymous attempt without treating it as a login token', () => {
    const attemptId = 'a'.repeat(32);
    const token = issueNativeOAuthAttempt({ attemptId, provider: 'apple' });
    expect(verifyNativeOAuthAttempt(token)).toEqual({ attemptId, provider: 'apple', startedAt: Date.now() });
    expect(verifyNativeOAuthTransferToken(token)).toBeNull();
    expect(verifyNativeOAuthAttempt(`${token}x`)).toBeNull();
    vi.setSystemTime(new Date('2026-04-03T12:02:01Z'));
    expect(verifyNativeOAuthAttempt(token)).toBeNull();
  });

  it('normalizes unsafe paths to root', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: 'https://evil.example',
    });

    expect(verifyNativeOAuthTransferToken(token)).toEqual({ generation: 0, userId: 'user_123', nextPath: '/' });
  });

  it('rejects expired tokens', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: '/feed',
    });

    vi.setSystemTime(new Date('2026-04-03T12:03:01Z'));

    expect(verifyNativeOAuthTransferToken(token)).toBeNull();
  });

  it('rejects tampered tokens', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: '/feed',
    });

    const [payload, signature] = token.split('.');
    const tamperedPayload = `${payload}x`;
    const tamperedToken = `${tamperedPayload}.${signature}`;

    expect(verifyNativeOAuthTransferToken(tamperedToken)).toBeNull();
  });

  it('rejects tokens with extra segments', () => {
    const token = issueNativeOAuthTransferToken({ userId: 'user_123', nextPath: '/' });
    expect(verifyNativeOAuthTransferToken(`${token}.extra`)).toBeNull();
  });

  it('rejects tokens with empty segments', () => {
    expect(verifyNativeOAuthTransferToken('.')).toBeNull();
    expect(verifyNativeOAuthTransferToken('.sig')).toBeNull();
    expect(verifyNativeOAuthTransferToken('payload.')).toBeNull();
  });

  it('accepts tokens with iat up to 5 seconds in the future (clock skew)', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: '/feed',
    });

    // Rewind time by 4 seconds — iat is 4s in the future, within tolerance
    vi.setSystemTime(new Date('2026-04-03T11:59:56Z'));

    expect(verifyNativeOAuthTransferToken(token)).toEqual({ generation: 0, userId: 'user_123', nextPath: '/feed' });
  });

  it('accepts tokens up to 5 seconds after exp (clock skew)', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: '/feed',
    });

    // Advance time to 4 seconds past expiry (120s TTL + 4s = 124s)
    vi.setSystemTime(new Date('2026-04-03T12:02:04Z'));

    expect(verifyNativeOAuthTransferToken(token)).toEqual({ generation: 0, userId: 'user_123', nextPath: '/feed' });
  });

  it('rejects tokens more than 5 seconds after exp', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: '/feed',
    });

    // Advance time to 6 seconds past expiry (120s TTL + 6s = 126s)
    vi.setSystemTime(new Date('2026-04-03T12:02:06Z'));

    expect(verifyNativeOAuthTransferToken(token)).toBeNull();
  });

  it('rejects tokens with iat in the future', () => {
    // Issue a token, then rewind time so iat is in the future
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: '/feed',
    });

    // Rewind time by 30 seconds — iat is now 30s in the future
    vi.setSystemTime(new Date('2026-04-03T11:59:30Z'));

    expect(verifyNativeOAuthTransferToken(token)).toBeNull();
  });

  it('returns null when NEXTAUTH_SECRET is missing during verification', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: '/feed',
    });

    vi.unstubAllEnvs();

    expect(verifyNativeOAuthTransferToken(token)).toBeNull();
  });
  it('preserves source SID, generation and old authentication time without treating transfer iat as a login', () => {
    const authenticatedAt = '2026-04-03T11:00:00.000Z';
    const proof = {
      version: 1 as const,
      userId: 'synthetic-source',
      authSessionId: 'source-login',
      generation: 4,
      authenticatedAt,
      linkGuarded: true,
    };
    const token = issueNativeOAuthTransferToken({
      userId: proof.userId,
      nextPath: '/settings',
      generation: 9,
      credentialProof: proof,
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as {
      authSessionId: string;
      gen: number;
      auth_time: number;
      iat: number;
    };
    expect(payload.authSessionId).toBe(proof.authSessionId);
    expect(payload.gen).toBe(4);
    expect(payload.auth_time).toBe(Date.parse(authenticatedAt) / 1000);
    expect(payload.auth_time).toBeLessThan(payload.iat);
    expect(verifyNativeOAuthTransferToken(token)?.credentialProof).toEqual(proof);
    expect(() =>
      issueNativeOAuthTransferToken({ userId: 'other-owner', nextPath: '/', credentialProof: proof }),
    ).toThrow();
  });

  it('retains unknown login ancestry through signed trusted-proof transfer serialization', () => {
    const proof = {
      version: 1 as const,
      userId: 'historical-owner',
      authSessionId: 'historical-child',
      generation: 0,
      authenticatedAt: null,
      linkGuarded: false,
      requiresAccountCutoff: true as const,
    };
    const token = issueNativeOAuthTransferToken({ userId: proof.userId, nextPath: '/', credentialProof: proof });
    expect(verifyNativeOAuthTransferToken(token)?.credentialProof).toEqual(proof);
  });
});

describe('signed transfer compatibility and proof completeness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'));
    vi.stubEnv('NEXTAUTH_SECRET', 'owned-transfer-completeness-fixture');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function signedClaims(claims: Record<string, unknown>): string {
    const encoded = Buffer.from(
      JSON.stringify({
        userId: 'signed-source',
        nextPath: '/',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        ...claims,
      }),
    ).toString('base64url');
    return `${encoded}.${createHmac('sha256', 'owned-transfer-completeness-fixture').update(encoded).digest('base64url')}`;
  }

  it.each([
    { claims: {}, generation: 0 },
    { claims: { gen: 7 }, generation: 7 },
  ])(
    'inherits generation-only legacy bytes without inventing age or a complete proof: $generation',
    ({ claims, generation }) => {
      expect(verifyNativeOAuthTransferToken(signedClaims(claims))).toEqual({
        userId: 'signed-source',
        nextPath: '/',
        generation,
      });
    },
  );
  it('carries source SID without an analytics receipt and inherits unknown age', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'signed-source',
      nextPath: '/',
      generation: 7,
      authSessionId: 'stable-source',
    });
    expect(verifyNativeOAuthTransferToken(token)).toEqual({
      userId: 'signed-source',
      nextPath: '/',
      generation: 7,
      credentialProof: {
        version: 1,
        userId: 'signed-source',
        authSessionId: 'stable-source',
        generation: 7,
        authenticatedAt: null,
        linkGuarded: false,
      },
    });
  });
  it.each([-1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 1])('refuses invalid signed legacy generation %s', (gen) => {
    expect(verifyNativeOAuthTransferToken(signedClaims({ gen }))).toBeNull();
  });
  it.each([
    { gen: 3, auth_time: 1775214000 },
    { gen: 3, link_guarded: true },
    { authSessionId: 'source', auth_time: 1775214000 },
    { authSessionId: 'source', link_guarded: true },
  ])('refuses partial freshness claims without a complete signed source: %j', (claims) => {
    expect(verifyNativeOAuthTransferToken(signedClaims(claims))).toBeNull();
  });
});
