import { randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

type Provider = 'google' | 'apple';
type JwksFailure = 'network' | 'http' | 'malformed' | null;
const pinnedJwks = {
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  apple: 'https://appleid.apple.com/auth/keys',
} as const;
const issuers = { google: 'https://accounts.google.com', apple: 'https://appleid.apple.com' } as const;

/** Real signed provider fixtures. Only external-provider HTTP I/O is replaced. */
export async function createNativeOAuthProviderFixture(options: { googleAudience: string; appleAudience: string }) {
  const pairs = { google: await generateKeyPair('RS256'), apple: await generateKeyPair('RS256') };
  const wrongPair = await generateKeyPair('RS256');
  const hmacKey = randomBytes(32);
  const kids = { google: `owned-google-${randomUUID()}`, apple: `owned-apple-${randomUUID()}` };
  const publicKeys = {
    google: { ...(await exportJWK(pairs.google.publicKey)), kid: kids.google, use: 'sig', alg: 'RS256' },
    apple: { ...(await exportJWK(pairs.apple.publicKey)), kid: kids.apple, use: 'sig', alg: 'RS256' },
  };
  const failures: Record<Provider, JwksFailure> = { google: null, apple: null };
  const counters = { google: 0, apple: 0, loopback: 0, blocked: 0 };
  let restoreActive: (() => void) | undefined;

  return {
    counters,
    failJwks(provider: Provider, failure: JwksFailure) {
      failures[provider] = failure;
    },
    async sign(
      provider: Provider,
      claims: Record<string, unknown>,
      overrides: {
        issuer?: string;
        audience?: string | string[];
        expiresAt?: string | number | Date;
        algorithm?: 'RS256' | 'HS256';
        wrongKey?: boolean;
        unknownKid?: boolean;
        omitExpiry?: boolean;
      } = {},
    ) {
      const payload = { ...claims };
      if (overrides.issuer !== undefined || payload.iss === undefined)
        payload.iss = overrides.issuer ?? issuers[provider];
      if (overrides.audience !== undefined || payload.aud === undefined)
        payload.aud = overrides.audience ?? (provider === 'google' ? options.googleAudience : options.appleAudience);
      if (payload.iat === undefined) payload.iat = Math.floor(Date.now() / 1000);
      if (overrides.omitExpiry) delete payload.exp;
      let token = new SignJWT(payload).setProtectedHeader({
        alg: overrides.algorithm ?? 'RS256',
        kid: overrides.unknownKid ? `owned-unknown-${randomUUID()}` : kids[provider],
        typ: 'JWT',
      });
      if (!overrides.omitExpiry && (overrides.expiresAt !== undefined || payload.exp === undefined))
        token = token.setExpirationTime(overrides.expiresAt ?? '10m');
      return token.sign(
        overrides.algorithm === 'HS256'
          ? hmacKey
          : overrides.wrongKey
            ? wrongPair.privateKey
            : pairs[provider].privateKey,
      );
    },
    installFetch(allowedLoopbackOrigins: string[]) {
      if (restoreActive) throw new Error('Owned provider HTTP shim already installed');
      const allowed = new Set(
        allowedLoopbackOrigins.map((origin) => {
          const parsed = new URL(origin);
          if (
            parsed.protocol !== 'http:' ||
            !parsed.port ||
            !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
            parsed.username ||
            parsed.password ||
            parsed.pathname !== '/' ||
            parsed.search ||
            parsed.hash
          )
            throw new Error('Provider fixture requires exact owned loopback origins');
          return parsed.origin;
        }),
      );
      const realFetch = globalThis.fetch;
      const replacement: typeof fetch = async (input, init) => {
        const address = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        const provider =
          address.href === pinnedJwks.google ? 'google' : address.href === pinnedJwks.apple ? 'apple' : null;
        if (provider) {
          const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
          if (method.toUpperCase() !== 'GET') {
            counters.blocked += 1;
            throw new Error('Unexpected provider fixture method');
          }
          if (init?.signal?.aborted) throw new DOMException('Owned provider request aborted', 'AbortError');
          counters[provider] += 1;
          if (failures[provider] === 'network') throw new TypeError('Owned provider HTTP unavailable');
          if (failures[provider] === 'http')
            return Response.json({ error: 'owned-provider-unavailable' }, { status: 503 });
          if (failures[provider] === 'malformed') return Response.json({ keys: 'invalid-owned-fixture' });
          return Response.json(
            { keys: [publicKeys[provider]] },
            { headers: { 'Cache-Control': 'public, max-age=600' } },
          );
        }
        if (!allowed.has(address.origin) || address.username || address.password) {
          counters.blocked += 1;
          throw new Error('Unowned provider fixture fetch refused');
        }
        counters.loopback += 1;
        return realFetch(input, { ...init, redirect: 'error' });
      };
      globalThis.fetch = replacement;
      const restore = () => {
        if (globalThis.fetch === replacement) globalThis.fetch = realFetch;
        restoreActive = undefined;
      };
      restoreActive = restore;
      return restore;
    },
  };
}
