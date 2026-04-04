import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { issueNativeOAuthTransferToken, verifyNativeOAuthTransferToken } from '../native-oauth-transfer';

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
