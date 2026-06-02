import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { verifyKeycloakToken } from './keycloak';

/**
 * Tests for the JWKS-verifying Keycloak token check (Batch B).
 *
 * The keycloak module caches the `createRemoteJWKSet` instance at module
 * scope (`cachedJwks`), which means the JWKS URL is captured once and the
 * cache reuses fetched keys keyed by `kid`. To keep tests independent we:
 *   - Give every test key a unique `kid`, so the cache never returns a
 *     stale key when a different test signs with a fresh pair.
 *   - Stub `fetch` so the JWKS endpoint returns whichever key set we want
 *     for the current test.
 */

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

const DEFAULT_ISSUER = 'https://idp.kiltergrips.com/realms/kilter';
const JWKS_URL = `${DEFAULT_ISSUER}/protocol/openid-connect/certs`;

// jose's `createRemoteJWKSet` is constructed once at module scope inside
// keycloak.ts and caches by `kid`. It also enforces an internal cooldown
// (~30s by default) between JWKS re-fetches when a `kid` miss happens —
// generating a fresh `kid` per test would hit that cooldown and fail with
// "no applicable key found" even though our fetch mock is fresh. To stay
// independent of jose's cache, every test reuses the same realm key pair
// + `kid`, and the "different key" tests sign with a different private
// key while keeping the same `kid` (which is the realistic attack: the
// attacker forges the header to look legitimate). The signature check
// still catches it because jose verifies the public key, not the kid.
const REALM_KID = 'realm-key';
let realmKeyPair: KeyPair | null = null;
let realmJwk: JWK | null = null;

async function getRealmKey(): Promise<{ pair: KeyPair; jwk: JWK; kid: string }> {
  if (!realmKeyPair || !realmJwk) {
    realmKeyPair = await generateKeyPair('RS256', { extractable: true });
    realmJwk = await exportJWK(realmKeyPair.publicKey);
    realmJwk.kid = REALM_KID;
    realmJwk.alg = 'RS256';
    realmJwk.use = 'sig';
  }
  return { pair: realmKeyPair, jwk: realmJwk, kid: REALM_KID };
}

function stubJwks(jwks: JWK[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.toString();
      if (href === JWKS_URL || href.startsWith(JWKS_URL)) {
        return new Response(JSON.stringify({ keys: jwks }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not stubbed', { status: 500 });
    }),
  );
}

async function sign(args: {
  pair: KeyPair;
  kid: string;
  payload: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  notBefore?: string | number;
}): Promise<string> {
  let jwt = new SignJWT(args.payload).setProtectedHeader({ alg: 'RS256', kid: args.kid }).setIssuedAt();
  if (args.issuer !== null) jwt = jwt.setIssuer(args.issuer ?? DEFAULT_ISSUER);
  if (args.audience) jwt = jwt.setAudience(args.audience);
  jwt = jwt.setExpirationTime(args.expiresIn ?? '5m');
  if (args.notBefore !== undefined) jwt = jwt.setNotBefore(args.notBefore);
  return jwt.sign(args.pair.privateKey);
}

describe('verifyKeycloakToken', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns sub + payload for a JWT signed by the realm JWKS key', async () => {
    const { pair, jwk, kid } = await getRealmKey();
    stubJwks([jwk]);
    const jwt = await sign({ pair, kid, payload: { sub: 'user-abc' } });

    const result = await verifyKeycloakToken(jwt);

    expect(result.sub).toBe('user-abc');
    expect(result.payload.iss).toBe(DEFAULT_ISSUER);
  });

  it('exposes preferred_username when present in the payload', async () => {
    const { pair, jwk, kid } = await getRealmKey();
    stubJwks([jwk]);
    const jwt = await sign({
      pair,
      kid,
      payload: { sub: 'user-abc', preferred_username: 'climber-1' },
    });

    const result = await verifyKeycloakToken(jwt);

    expect(result.preferredUsername).toBe('climber-1');
  });

  it('rejects a JWT signed by a DIFFERENT key', async () => {
    // Realm has key A published; token is signed by attacker key B with the
    // same kid as A — jose verifies against the cached public key for that
    // kid, so the signature check fails even though the header matches.
    const realm = await getRealmKey();
    const attacker = await generateKeyPair('RS256', { extractable: true });
    stubJwks([realm.jwk]);
    const forged = await sign({
      pair: { privateKey: attacker.privateKey, publicKey: attacker.publicKey } as KeyPair,
      kid: realm.kid,
      payload: { sub: 'user-abc' },
    });

    await expect(verifyKeycloakToken(forged)).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'unauthorized',
    });
  });

  it('rejects a JWT with the wrong issuer', async () => {
    const { pair, jwk, kid } = await getRealmKey();
    stubJwks([jwk]);
    const jwt = await sign({
      pair,
      kid,
      payload: { sub: 'user-abc' },
      issuer: 'https://evil.example.com/realms/kilter',
    });

    await expect(verifyKeycloakToken(jwt)).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'unauthorized',
    });
  });

  it('rejects when expectedAudience is given and the JWT aud does not match', async () => {
    const { pair, jwk, kid } = await getRealmKey();
    stubJwks([jwk]);
    const jwt = await sign({
      pair,
      kid,
      payload: { sub: 'user-abc' },
      audience: 'some-other-client',
    });

    await expect(verifyKeycloakToken(jwt, { expectedAudience: 'kilter-web' })).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'unauthorized',
    });
  });

  it('rejects an expired JWT', async () => {
    const { pair, jwk, kid } = await getRealmKey();
    stubJwks([jwk]);
    const jwt = await new SignJWT({ sub: 'user-abc' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(DEFAULT_ISSUER)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(pair.privateKey);

    await expect(verifyKeycloakToken(jwt)).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'unauthorized',
    });
  });

  it('rejects a malformed JWT (wrong number of segments)', async () => {
    const realm = await getRealmKey();
    stubJwks([realm.jwk]);

    await expect(verifyKeycloakToken('not.a.real.jwt.token')).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'unauthorized',
    });
    await expect(verifyKeycloakToken('only.two')).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'unauthorized',
    });
    await expect(verifyKeycloakToken('plain-garbage')).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'unauthorized',
    });
  });

  it('rejects a JWT missing a sub claim', async () => {
    const { pair, jwk, kid } = await getRealmKey();
    stubJwks([jwk]);
    // No sub in the payload.
    const jwt = await sign({ pair, kid, payload: { preferred_username: 'someone' } });

    await expect(verifyKeycloakToken(jwt)).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'unauthorized',
    });
  });
});
