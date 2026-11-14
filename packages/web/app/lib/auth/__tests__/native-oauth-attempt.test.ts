import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
vi.mock('server-only', () => ({}));
import {
  nativeOAuthAttemptBinding,
  readNativeOAuthAttempt,
  signNativeOAuthAttempt,
} from '../native-oauth-attempt.server';

const secret = 'owned-native-attempt-compatibility-key-6975';
const now = Date.UTC(2026, 10, 14, 15);
const attempt = { attemptId: 'a'.repeat(32), provider: 'apple' as const };
const returnUrl = `https://www.example.test/api/auth/native/callback?next=%2F&provider=apple&attemptId=${attempt.attemptId}`;

describe('shared native attempt marker and original-flow correlation', () => {
  it('preserves the installed synchronous HMAC wire bytes exactly', () => {
    const payload = Buffer.from(JSON.stringify({ ...attempt, startedAt: now, kind: 'native-oauth-attempt' })).toString(
      'base64url',
    );
    const historical = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
    expect(signNativeOAuthAttempt(attempt, secret, now)).toBe(historical);
    expect(readNativeOAuthAttempt(historical, secret, now)).toEqual({ ...attempt, startedAt: now });
  });
  it.each([-1, 120_001])('refuses a marker outside its original lifetime at offset %s', (elapsed) => {
    expect(readNativeOAuthAttempt(signNativeOAuthAttempt(attempt, secret, now), secret, now + elapsed)).toBeNull();
  });
  it('binds the exact original marker and return query without inferring creation or age', () => {
    const original = signNativeOAuthAttempt(attempt, secret, now);
    const digest = nativeOAuthAttemptBinding(original, returnUrl, 'apple', secret, now + 1);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeOAuthAttemptBinding(original, returnUrl, 'apple', secret, now + 1000)).toBe(digest);
    expect(
      nativeOAuthAttemptBinding(signNativeOAuthAttempt(attempt, secret, now + 1), returnUrl, 'apple', secret, now + 2),
    ).not.toBe(digest);
    expect(
      nativeOAuthAttemptBinding(original, returnUrl.replace('next=%2F', 'next=%2Fsettings'), 'apple', secret, now + 1),
    ).not.toBe(digest);
  });
  it.each([
    returnUrl.replace('provider=apple', 'provider=google'),
    `${returnUrl}&provider=apple`,
    `${returnUrl}&attemptId=${attempt.attemptId}`,
    returnUrl.replace('/api/auth/native/callback', '/settings'),
    returnUrl.replace('https:', 'http:'),
    `${returnUrl}#untrusted`,
  ])('refuses an ambiguous or unrelated return URL %s', (url) => {
    expect(
      nativeOAuthAttemptBinding(signNativeOAuthAttempt(attempt, secret, now), url, 'apple', secret, now),
    ).toBeNull();
  });
  it('refuses forged or another-key markers without exposing their content', () => {
    const original = signNativeOAuthAttempt(attempt, secret, now);
    expect(readNativeOAuthAttempt(`${original}x`, secret, now)).toBeNull();
    expect(readNativeOAuthAttempt(original, `${secret}-other`, now)).toBeNull();
  });
});
