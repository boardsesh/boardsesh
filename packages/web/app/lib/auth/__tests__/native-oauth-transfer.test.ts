import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
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

    expect(verifyNativeOAuthTransferToken(token)).toEqual({
      userId: 'user_123',
      nextPath: '/settings',
    });
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
    expect(verifyNativeOAuthTransferToken(issueNativeOAuthTransferToken(options))).toEqual({
      userId,
      nextPath: '/',
      accountCreation,
    });
    expect(
      verifyNativeOAuthTransferToken(issueNativeOAuthTransferToken({ ...options, userId: 'another-user' })),
    ).toEqual({ userId: 'another-user', nextPath: '/' });
    expect(verifyNativeOAuthTransferToken(issueNativeOAuthTransferToken({ ...options, provider: 'apple' }))).toEqual({
      userId,
      nextPath: '/',
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

    expect(verifyNativeOAuthTransferToken(token)).toEqual({
      userId: 'user_123',
      nextPath: '/',
    });
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

    expect(verifyNativeOAuthTransferToken(token)).toEqual({
      userId: 'user_123',
      nextPath: '/feed',
    });
  });

  it('accepts tokens up to 5 seconds after exp (clock skew)', () => {
    const token = issueNativeOAuthTransferToken({
      userId: 'user_123',
      nextPath: '/feed',
    });

    // Advance time to 4 seconds past expiry (120s TTL + 4s = 124s)
    vi.setSystemTime(new Date('2026-04-03T12:02:04Z'));

    expect(verifyNativeOAuthTransferToken(token)).toEqual({
      userId: 'user_123',
      nextPath: '/feed',
    });
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
});
