import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  issueAccountLinkIntentToken,
  verifyAccountLinkIntentToken,
  ACCOUNT_LINK_INTENT_COOKIE,
} from '../account-link-intent';

describe('account-link-intent', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = 'test-secret-for-unit-tests';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issueAccountLinkIntentToken creates a valid token that can be verified', () => {
    const token = issueAccountLinkIntentToken('user-123');
    expect(token).toBeTruthy();
    expect(token.split('.').length).toBe(2);

    const result = verifyAccountLinkIntentToken(token);
    expect(result).not.toBeNull();
  });

  it('verifyAccountLinkIntentToken returns userId from a valid token', () => {
    const token = issueAccountLinkIntentToken('user-456');
    const result = verifyAccountLinkIntentToken(token);
    expect(result).toEqual({ userId: 'user-456' });
  });

  it('verifyAccountLinkIntentToken returns null for tampered signature', () => {
    const token = issueAccountLinkIntentToken('user-789');
    const [payload] = token.split('.');
    const tamperedToken = `${payload}.tampered-signature`;

    const result = verifyAccountLinkIntentToken(tamperedToken);
    expect(result).toBeNull();
  });

  it('verifyAccountLinkIntentToken returns null for expired tokens', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const token = issueAccountLinkIntentToken('user-expired');

    // Advance time by 6 minutes (360 seconds) — well past the 5-minute TTL + 5s skew
    vi.setSystemTime(now + 6 * 60 * 1000);

    const result = verifyAccountLinkIntentToken(token);
    expect(result).toBeNull();
  });

  it('verifyAccountLinkIntentToken returns null for empty/malformed tokens', () => {
    expect(verifyAccountLinkIntentToken('')).toBeNull();
    expect(verifyAccountLinkIntentToken('not-a-token')).toBeNull();
    expect(verifyAccountLinkIntentToken('a.b.c')).toBeNull();
    expect(verifyAccountLinkIntentToken('.')).toBeNull();
  });

  it('verifyAccountLinkIntentToken returns null when NEXTAUTH_SECRET is not set', () => {
    const token = issueAccountLinkIntentToken('user-no-secret');
    delete process.env.NEXTAUTH_SECRET;

    const result = verifyAccountLinkIntentToken(token);
    expect(result).toBeNull();
  });

  it('verifyAccountLinkIntentToken returns null for token with future iat beyond clock skew', () => {
    vi.useFakeTimers();
    const now = Date.now();

    // Issue token at a time 30 seconds in the future
    vi.setSystemTime(now + 30_000);
    const token = issueAccountLinkIntentToken('user-future');

    // Verify at "now" — iat is 30s ahead, well beyond the 5s tolerance
    vi.setSystemTime(now);
    const result = verifyAccountLinkIntentToken(token);
    expect(result).toBeNull();
  });

  it('ACCOUNT_LINK_INTENT_COOKIE equals "account-link-intent"', () => {
    expect(ACCOUNT_LINK_INTENT_COOKIE).toBe('account-link-intent');
  });
});
