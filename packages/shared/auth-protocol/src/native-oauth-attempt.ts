/** Shared marker policy with platform crypto injected. This correlates a browser attempt; it never proves
 * an account, session, account creation, or authentication freshness. */
export const NATIVE_OAUTH_ATTEMPT_COOKIE = 'boardsesh-native-oauth-attempt';
export const NATIVE_OAUTH_ATTEMPT_LIFETIME_MS = 120_000;
export type NativeOAuthAttempt = { attemptId: string; provider: 'apple' | 'google'; startedAt: number };

export interface NativeOAuthAttemptCrypto {
  encode(text: string): string;
  decode(encoded: string): string;
  hmac(text: string, secret: string): string;
  equal(actual: string, expected: string): boolean;
  hash(text: string): string;
}

export function createNativeOAuthAttemptCodec(crypto: NativeOAuthAttemptCrypto) {
  function signNativeOAuthAttempt(attempt: Omit<NativeOAuthAttempt, 'startedAt'>, secret: string, now: number): string {
    if (!secret) throw new Error('Native OAuth marker key unavailable');
    const payload = crypto.encode(JSON.stringify({ ...attempt, startedAt: now, kind: 'native-oauth-attempt' }));
    return `${payload}.${crypto.hmac(payload, secret)}`;
  }

  function readNativeOAuthAttempt(token: string | undefined, secret: string, now: number): NativeOAuthAttempt | null {
    if (!token || token.length > 2048 || !secret || !Number.isSafeInteger(now)) return null;
    try {
      const segments = token.split('.');
      if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
      const expected = crypto.hmac(segments[0], secret);
      if (!crypto.equal(segments[1], expected)) return null;
      const decoded: unknown = JSON.parse(crypto.decode(segments[0]));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
      const attempt = decoded as Record<string, unknown>;
      if (
        attempt.kind !== 'native-oauth-attempt' ||
        typeof attempt.attemptId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(attempt.attemptId) ||
        (attempt.provider !== 'apple' && attempt.provider !== 'google') ||
        typeof attempt.startedAt !== 'number' ||
        !Number.isSafeInteger(attempt.startedAt) ||
        attempt.startedAt > now ||
        now - attempt.startedAt > NATIVE_OAUTH_ATTEMPT_LIFETIME_MS
      )
        return null;
      return { attemptId: attempt.attemptId, provider: attempt.provider, startedAt: attempt.startedAt };
    } catch {
      return null;
    }
  }

  /** Freeze the original marker and exact return query into the durable provider
   * flow. A later still-valid marker or another return URL cannot reuse it. The
   * return URL is correlation material, never an authentication authority. */
  function nativeOAuthAttemptBinding(
    token: string | undefined,
    returnUrl: string,
    provider: 'google' | 'apple',
    secret: string,
    now: number,
  ): string | null {
    const attempt = readNativeOAuthAttempt(token, secret, now);
    if (!attempt || attempt.provider !== provider) return null;
    try {
      const callback = new URL(returnUrl);
      if (
        callback.protocol !== 'https:' ||
        callback.username ||
        callback.password ||
        callback.hash ||
        callback.href.length > 4096 ||
        callback.pathname !== '/api/auth/native/callback' ||
        callback.searchParams.getAll('attemptId').length !== 1 ||
        callback.searchParams.get('attemptId') !== attempt.attemptId ||
        callback.searchParams.getAll('provider').length !== 1 ||
        callback.searchParams.get('provider') !== provider
      )
        return null;
      return crypto.hash(JSON.stringify(['native-oauth-original-attempt-v1', token, callback.href]));
    } catch {
      return null;
    }
  }

  return Object.freeze({ signNativeOAuthAttempt, readNativeOAuthAttempt, nativeOAuthAttemptBinding });
}
