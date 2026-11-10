import { createRequire } from 'node:module';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT, SignJWT, jwtDecrypt, type JWTPayload } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  LEGACY_WEB_CLOCK_TOLERANCE_SECONDS,
  verifyLegacyNextAuthJwe,
  verifyLegacyWebCookie,
} from '../legacy-web-credentials';

// Exercise the installed legacy encoder as a fixture producer only. Runtime
// verification imports jose/HKDF, never the NextAuth framework or web modules.
const webFixtureRequire = createRequire(new URL('../../../../web/package.json', import.meta.url));
const { encode: encodeInstalledNextAuth } = webFixtureRequire('next-auth/jwt') as {
  encode(
    this: void,
    options: { token?: Record<string, unknown>; secret: string; maxAge?: number; salt?: string },
  ): Promise<string>;
};

const LEGACY_SECRET = 'boardsesh-disposable-nextauth-verification-key-6975';
const NOW = new Date('2026-11-04T20:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;
const SECURE_COOKIE = '__Secure-next-auth.session-token';
const PLAIN_COOKIE = 'next-auth.session-token';

async function installedSession(token: Record<string, unknown> = {}, maxAge = MAX_SESSION_SECONDS) {
  return encodeInstalledNextAuth({
    token: { sub: 'same-existing-user', authSessionId: 'same-established-login', ...token },
    secret: LEGACY_SECRET,
    maxAge,
  });
}

async function encryptedFixture(
  claims: Record<string, unknown> = {},
  options: {
    secret?: string;
    salt?: string;
    info?: string;
    encryption?: 'A256GCM' | 'A256CBC-HS512';
    keySize?: number;
  } = {},
) {
  const key = await hkdf(
    'sha256',
    new TextEncoder().encode(options.secret ?? LEGACY_SECRET),
    options.salt ?? '',
    options.info ?? 'NextAuth.js Generated Encryption Key',
    options.keySize ?? 32,
  );
  return new EncryptJWT({
    sub: 'same-existing-user',
    authSessionId: 'same-established-login',
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600,
    jti: 'rotating-jti',
    ...claims,
  } as JWTPayload)
    .setProtectedHeader({ alg: 'dir', enc: options.encryption ?? 'A256GCM' })
    .encrypt(key);
}

function chunkHeader(cookieName: string, credential: string, chunkSize = 29) {
  const chunks = Array.from(
    { length: Math.ceil(credential.length / chunkSize) },
    (_, index) => `${cookieName}.${index}=${credential.slice(index * chunkSize, (index + 1) * chunkSize)}`,
  );
  // Numeric ordering must not depend on browser cookie order or lexical .10/.2.
  return chunks.reverse().join('; ');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('legacy NextAuth v4 cryptographic credential proof', () => {
  it.each([SECURE_COOKIE, PLAIN_COOKIE])(
    'verifies actual installed encoder bytes under %s without changing identity',
    async (cookieName) => {
      const credential = await installedSession({ email: 'private-fixture@example.test', name: 'Private fixture' });
      const proof = await verifyLegacyWebCookie(`${cookieName}=${credential}`, LEGACY_SECRET, NOW);
      expect(proof).toMatchObject({
        kind: 'nextauth-v4-jwe',
        userId: 'same-existing-user',
        authSessionId: 'same-established-login',
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + MAX_SESSION_SECONDS * 1000),
        validUntil: new Date(NOW.getTime() + (MAX_SESSION_SECONDS + 60) * 1000),
        clockToleranceSeconds: LEGACY_WEB_CLOCK_TOLERANCE_SECONDS,
        originalAuthenticatedAt: null,
        requiresAccountCutoff: false,
        cookieNames: [cookieName],
      });
      expect(proof?.lineageId).toMatch(/^session:[a-f0-9]{64}$/);
      expect(proof?.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(proof)).not.toContain(credential);
      expect(JSON.stringify(proof)).not.toContain('private-fixture@example.test');
      expect(JSON.stringify(proof)).not.toContain('Private fixture');
    },
  );

  it.each([SECURE_COOKIE, PLAIN_COOKIE])(
    'reassembles actual encoder output from non-lexical %s chunks',
    async (cookieName) => {
      const credential = await installedSession({
        profileDisplayName: 'A fixture long enough for more than ten tiny chunks',
      });
      const proof = await verifyLegacyWebCookie(chunkHeader(cookieName, credential), LEGACY_SECRET, NOW);
      expect(proof?.userId).toBe('same-existing-user');
      expect(proof!.cookieNames.length).toBeGreaterThan(10);
      expect(proof?.cookieNames[0]).toBe(`${cookieName}.0`);
      expect(proof?.cookieNames[10]).toBe(`${cookieName}.10`);
    },
  );

  it('preserves one stable lineage through actual library iat/jti/ciphertext rotation', async () => {
    const first = await installedSession();
    vi.setSystemTime(new Date(NOW.getTime() + 3600_000));
    const renewed = await encodeInstalledNextAuth({
      token: { sub: 'same-existing-user', authSessionId: 'same-established-login' },
      secret: LEGACY_SECRET,
    });
    const laterTime = new Date(NOW.getTime() + 3600_000);
    const originalProof = await verifyLegacyNextAuthJwe(first, LEGACY_SECRET, laterTime);
    const renewedProof = await verifyLegacyNextAuthJwe(renewed, LEGACY_SECRET, laterTime);
    expect(renewed).not.toBe(first);
    expect(renewedProof?.credentialFingerprint).not.toBe(originalProof?.credentialFingerprint);
    expect(renewedProof?.lineageId).toBe(originalProof?.lineageId);
    expect(originalProof?.issuedAt).toEqual(NOW);
    expect(renewedProof?.issuedAt).toEqual(laterTime);
    expect(originalProof?.originalAuthenticatedAt).toBeNull();
    expect(renewedProof?.originalAuthenticatedAt).toBeNull();
  });

  it('does not use the encoder-regenerated jti as a stable old-session identifier', async () => {
    const first = await installedSession({ authSessionId: undefined });
    const renewed = await installedSession({ authSessionId: undefined });
    const originalProof = await verifyLegacyNextAuthJwe(first, LEGACY_SECRET, NOW);
    const renewedProof = await verifyLegacyNextAuthJwe(renewed, LEGACY_SECRET, NOW);
    expect(originalProof).toMatchObject({
      authSessionId: null,
      requiresAccountCutoff: true,
      originalAuthenticatedAt: null,
    });
    expect(originalProof?.lineageId).toMatch(/^credential:[a-f0-9]{64}$/);
    expect(renewedProof?.lineageId).not.toBe(originalProof?.lineageId);
    expect((await verifyLegacyNextAuthJwe(first, LEGACY_SECRET, NOW))?.lineageId).toBe(originalProof?.lineageId);
  });

  it('reads the sign-in time the web callback records, separately from the rolling iat', async () => {
    const signedIn = NOW_SECONDS - 3600;
    const credential = await installedSession({ auth_time: signedIn });
    expect(await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW)).toMatchObject({
      issuedAt: NOW,
      originalAuthenticatedAt: new Date(signedIn * 1000),
    });
  });

  it('has no sign-in time for a cookie from before the claim, and never takes the attribution timestamp as one', async () => {
    const credential = await installedSession({
      nativeOAuthCreationProof: { signedInAt: NOW.getTime(), authSessionId: 'same-established-login' },
    });
    const proof = await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW);
    expect(proof?.userId).toBe('same-existing-user');
    expect(proof?.originalAuthenticatedAt).toBeNull();
  });

  it.each([
    ['a fraction', NOW_SECONDS - 0.5],
    ['a string', String(NOW_SECONDS)],
    ['milliseconds', NOW.getTime()],
    ['zero', 0],
    ['negative', -60],
    ['an object', { seconds: NOW_SECONDS }],
    ['beyond the clock skew', NOW_SECONDS + 61],
  ] satisfies [string, unknown][])('treats %s auth_time as unknown and keeps the session', async (_label, authTime) => {
    const credential = await installedSession({ auth_time: authTime });
    const proof = await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW);
    expect(proof?.userId).toBe('same-existing-user');
    expect(proof?.originalAuthenticatedAt).toBeNull();
  });

  it('reports link_guarded only when the claim is exactly true', async () => {
    for (const [claim, linkGuarded] of [
      [true, true],
      ['true', false],
      [1, false],
      [undefined, false],
    ] as const) {
      const credential = await installedSession({ auth_time: NOW_SECONDS, link_guarded: claim });
      expect((await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW))?.linkGuarded).toBe(linkGuarded);
    }
  });

  it('treats a sign-in after the cookie it produced as unknown', async () => {
    const credential = await encryptedFixture({ iat: NOW_SECONDS - 600, auth_time: NOW_SECONDS - 500 });
    const proof = await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW);
    expect(proof?.userId).toBe('same-existing-user');
    expect(proof?.originalAuthenticatedAt).toBeNull();
  });

  it('does not retain a successful-token cache across expiry or verification-key changes', async () => {
    const credential = await installedSession({}, 60);
    expect(await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW)).not.toBeNull();
    expect(await verifyLegacyNextAuthJwe(credential, 'wrong-legacy-verification-key', NOW)).toBeNull();
    expect(await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, new Date(NOW.getTime() + 120_000))).toBeNull();
  });

  it.each([1, 60])('accepts actual encoder output with %s seconds between issue/expiry clock reads', async (delay) => {
    // jose v4 reads new Date() for iat; NextAuth then independently reads
    // Date.now() for exp. Model a real second boundary between those reads.
    const expiryClock = vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime() + delay * 1000);
    const credential = await installedSession();
    expiryClock.mockRestore();
    const encryptionKey = await hkdf(
      'sha256',
      new TextEncoder().encode(LEGACY_SECRET),
      '',
      'NextAuth.js Generated Encryption Key',
      32,
    );
    const { payload } = await jwtDecrypt(credential, encryptionKey, { currentDate: NOW });
    expect(payload.iat).toBe(NOW_SECONDS);
    expect(payload.exp! - payload.iat!).toBe(MAX_SESSION_SECONDS + delay);
    expect(await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW)).toMatchObject({
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + (MAX_SESSION_SECONDS + delay) * 1000),
      validUntil: new Date(NOW.getTime() + (MAX_SESSION_SECONDS + delay + 60) * 1000),
      originalAuthenticatedAt: null,
    });
  });

  it('rejects actual encoder output beyond the explicit 60-second clock-read allowance', async () => {
    const expiryClock = vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime() + 61_000);
    const credential = await installedSession();
    expiryClock.mockRestore();
    expect(await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW)).toBeNull();
  });

  it('accepts actual legacy encoder output from a node ahead by the bounded 60-second allowance', async () => {
    const aheadTime = new Date(NOW.getTime() + 60_000);
    vi.setSystemTime(aheadTime);
    const credential = await installedSession();
    expect(await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW)).toMatchObject({
      issuedAt: aheadTime,
      expiresAt: new Date(aheadTime.getTime() + MAX_SESSION_SECONDS * 1000),
      validUntil: new Date(aheadTime.getTime() + (MAX_SESSION_SECONDS + 60) * 1000),
      clockToleranceSeconds: 60,
      originalAuthenticatedAt: null,
    });
  });

  it('retains the signed expiry separately when an actual token is accepted during backend expiry grace', async () => {
    vi.setSystemTime(new Date(NOW.getTime() - 90_000));
    const credential = await installedSession({}, 60);
    expect(await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, NOW)).toMatchObject({
      expiresAt: new Date(NOW.getTime() - 30_000),
      validUntil: new Date(NOW.getTime() + 30_000),
      originalAuthenticatedAt: null,
    });
    expect(await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, new Date(NOW.getTime() + 30_000))).toBeNull();
  });

  it.each([
    ['unrelated secret', { secret: 'wrong-purpose-secret' }],
    ['cookie-name salt', { salt: SECURE_COOKIE }],
    ['Auth.js v5 key context', { info: 'Auth.js Generated Encryption Key' }],
    ['unshipped A256CBC format', { encryption: 'A256CBC-HS512', keySize: 64 }],
  ] satisfies [string, Parameters<typeof encryptedFixture>[1]][])(
    'rejects %s instead of guessing a compatible key',
    async (_name, options) => {
      expect(await verifyLegacyNextAuthJwe(await encryptedFixture({}, options), LEGACY_SECRET, NOW)).toBeNull();
    },
  );

  it.each([
    ['missing subject', { sub: undefined }],
    ['blank subject', { sub: ' ' }],
    ['wrong subject type', { sub: 123 }],
    ['missing issue time', { iat: undefined }],
    ['missing expiry', { exp: undefined }],
    ['expired beyond backend clock grace', { iat: NOW_SECONDS - 120, exp: NOW_SECONDS - 60 }],
    ['future issue time beyond backend clock allowance', { iat: NOW_SECONDS + 61 }],
    ['fractional issue time', { iat: NOW_SECONDS - 0.5 }],
    ['fractional expiry', { exp: NOW_SECONDS + 0.5 }],
    ['non-positive lifetime', { iat: NOW_SECONDS - 60, exp: NOW_SECONDS - 60 }],
    ['overlong rolling lifetime', { iat: NOW_SECONDS - 60, exp: NOW_SECONDS + MAX_SESSION_SECONDS + 1 }],
    ['malformed lineage type', { authSessionId: { untrusted: true } }],
    ['blank lineage', { authSessionId: '' }],
    ['another issuer', { iss: 'a-different-authority' }],
    ['another audience', { aud: 'partner-api' }],
    ['another purpose', { purpose: 'native-transfer' }],
    ['another token use', { token_use: 'access' }],
  ] satisfies [string, Record<string, unknown>][])(
    'rejects authenticated but unsupported %s claims',
    async (_name, claims) => {
      expect(await verifyLegacyNextAuthJwe(await encryptedFixture(claims), LEGACY_SECRET, NOW)).toBeNull();
    },
  );

  it('rejects an authentic same-key NextAuth OAuth PKCE cookie because it has no session subject', async () => {
    const pkceCookie = await encodeInstalledNextAuth({
      token: { value: 'provider-pkce-verifier' },
      secret: LEGACY_SECRET,
      maxAge: 900,
    });
    expect(await verifyLegacyWebCookie(`${SECURE_COOKIE}=${pkceCookie}`, LEGACY_SECRET, NOW)).toBeNull();
  });

  it('rejects tampered JWE bytes and a native JWS rather than widening the accepted token format', async () => {
    const credential = await installedSession();
    const parts = credential.split('.');
    parts[4] = `${parts[4][0] === 'A' ? 'B' : 'A'}${parts[4].slice(1)}`;
    expect(await verifyLegacyNextAuthJwe(parts.join('.'), LEGACY_SECRET, NOW)).toBeNull();
    const nativeToken = await new SignJWT({ sub: 'same-existing-user', iat: NOW_SECONDS, exp: NOW_SECONDS + 3600 })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(LEGACY_SECRET));
    expect(await verifyLegacyNextAuthJwe(nativeToken, LEGACY_SECRET, NOW)).toBeNull();
  });
});

describe('legacy web cookie ownership and bounded parsing', () => {
  it('accepts identical secure/plain credentials and duplicate identical host/domain cookie values', async () => {
    const credential = await installedSession();
    const proof = await verifyLegacyWebCookie(
      `${SECURE_COOKIE}=${credential}; ${PLAIN_COOKIE}=${credential}; ${SECURE_COOKIE}=${credential}`,
      LEGACY_SECRET,
      NOW,
    );
    expect(proof?.userId).toBe('same-existing-user');
    expect(proof?.cookieNames).toEqual([SECURE_COOKIE, PLAIN_COOKIE]);
  });

  it('combines rotations only when both decrypted user and explicit session lineage match', async () => {
    const first = await installedSession({}, 3600);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const second = await encodeInstalledNextAuth({
      token: { sub: 'same-existing-user', authSessionId: 'same-established-login' },
      secret: LEGACY_SECRET,
    });
    const laterTime = new Date(NOW.getTime() + 60_000);
    const forward = await verifyLegacyWebCookie(
      `${SECURE_COOKIE}=${first}; ${PLAIN_COOKIE}=${second}`,
      LEGACY_SECRET,
      laterTime,
    );
    const reverse = await verifyLegacyWebCookie(
      `${PLAIN_COOKIE}=${second}; ${SECURE_COOKIE}=${first}`,
      LEGACY_SECRET,
      laterTime,
    );
    expect(forward).not.toBeNull();
    expect(reverse).toEqual(forward);
    expect(forward?.issuedAt).toEqual(NOW);
    expect(forward?.expiresAt).toEqual(new Date(NOW.getTime() + 3600_000));
    expect(forward?.originalAuthenticatedAt).toBeNull();
  });

  it('combines link_guarded conservatively: guarded only if every copy is', async () => {
    const guarded = await installedSession({ auth_time: NOW_SECONDS - 60, link_guarded: true });
    const unguarded = await installedSession({ auth_time: NOW_SECONDS - 60 });
    const both = await verifyLegacyWebCookie(
      `${SECURE_COOKIE}=${guarded}; ${PLAIN_COOKIE}=${guarded}`,
      LEGACY_SECRET,
      NOW,
    );
    expect(both?.linkGuarded).toBe(true);
    const mixed = await verifyLegacyWebCookie(
      `${SECURE_COOKIE}=${guarded}; ${PLAIN_COOKIE}=${unguarded}`,
      LEGACY_SECRET,
      NOW,
    );
    expect(mixed?.userId).toBe('same-existing-user');
    expect(mixed?.linkGuarded).toBe(false);
  });

  it('combines sign-in times conservatively: the earliest, and unknown if either copy lacks one', async () => {
    const earlier = await installedSession({ auth_time: NOW_SECONDS - 7200 });
    const later = await installedSession({ auth_time: NOW_SECONDS - 60 });
    const unknown = await installedSession();
    const both = await verifyLegacyWebCookie(
      `${SECURE_COOKIE}=${later}; ${PLAIN_COOKIE}=${earlier}`,
      LEGACY_SECRET,
      NOW,
    );
    expect(both?.originalAuthenticatedAt).toEqual(new Date((NOW_SECONDS - 7200) * 1000));
    const oneUnknown = await verifyLegacyWebCookie(
      `${SECURE_COOKIE}=${later}; ${PLAIN_COOKIE}=${unknown}`,
      LEGACY_SECRET,
      NOW,
    );
    expect(oneUnknown?.userId).toBe('same-existing-user');
    expect(oneUnknown?.originalAuthenticatedAt).toBeNull();
  });

  it.each([
    ['different user', { sub: 'another-account' }],
    ['another login for the same user', { authSessionId: 'a-later-login' }],
    ['unknown lineage', { authSessionId: undefined }],
  ] satisfies [string, Record<string, unknown>][])(
    'rejects conflicting %s instead of selecting cookie order',
    async (_name, claims) => {
      const first = await installedSession();
      const second = await installedSession(claims);
      for (const cookies of [
        `${SECURE_COOKIE}=${first}; ${PLAIN_COOKIE}=${second}`,
        `${PLAIN_COOKIE}=${second}; ${SECURE_COOKIE}=${first}`,
      ])
        expect(await verifyLegacyWebCookie(cookies, LEGACY_SECRET, NOW)).toBeNull();
    },
  );

  it('rejects two distinct credentials without explicit lineage even when their user IDs match', async () => {
    const first = await installedSession({ authSessionId: undefined });
    const second = await installedSession({ authSessionId: undefined });
    expect(
      await verifyLegacyWebCookie(`${SECURE_COOKIE}=${first}; ${PLAIN_COOKIE}=${second}`, LEGACY_SECRET, NOW),
    ).toBeNull();
  });

  it.each([
    [
      'conflicting duplicate name',
      (credential: string) => `${SECURE_COOKIE}=${credential}; ${SECURE_COOKIE}=conflicting-value`,
    ],
    ['base and chunks', (credential: string) => `${SECURE_COOKIE}=${credential}; ${SECURE_COOKIE}.0=${credential}`],
    ['missing first chunk', (credential: string) => `${SECURE_COOKIE}.1=${credential}`],
    [
      'non-contiguous chunks',
      (credential: string) =>
        `${SECURE_COOKIE}.0=${credential.slice(0, 20)}; ${SECURE_COOKIE}.2=${credential.slice(20)}`,
    ],
    ['malformed chunk suffix', (credential: string) => `${SECURE_COOKIE}.not-a-number=${credential}`],
    ['non-canonical chunk suffix', (credential: string) => `${SECURE_COOKIE}.00=${credential}`],
    ['empty first chunk', (credential: string) => `${SECURE_COOKIE}.0=; ${SECURE_COOKIE}.1=${credential}`],
    ['invalid URI encoding', (_credential: string) => `${SECURE_COOKIE}=%ZZ`],
    ['empty value', (_credential: string) => `${SECURE_COOKIE}=`],
    ['excessive chunk index', (credential: string) => `${SECURE_COOKIE}.64=${credential}`],
  ] satisfies [string, (credential: string) => string][])('rejects %s', async (_name, cookies) => {
    expect(await verifyLegacyWebCookie(cookies(await installedSession()), LEGACY_SECRET, NOW)).toBeNull();
  });

  it('ignores cryptographically invalid alternate cookies while retaining exact names for cleanup', async () => {
    const credential = await installedSession();
    expect(
      await verifyLegacyWebCookie(`${SECURE_COOKIE}=${credential}; ${PLAIN_COOKIE}=invalid`, LEGACY_SECRET, NOW),
    ).toMatchObject({ userId: 'same-existing-user', cookieNames: [SECURE_COOKIE, PLAIN_COOKIE] });
  });

  it('ignores an expired alternate beside a valid session without trusting its different account claims', async () => {
    const credential = await installedSession();
    vi.setSystemTime(new Date(NOW.getTime() - 120_000));
    const staleOtherAccount = await installedSession({ sub: 'expired-other-account' }, 30);
    expect(
      await verifyLegacyWebCookie(
        `${SECURE_COOKIE}=${credential}; ${PLAIN_COOKIE}=${staleOtherAccount}`,
        LEGACY_SECRET,
        NOW,
      ),
    ).toMatchObject({ userId: 'same-existing-user', cookieNames: [SECURE_COOKIE, PLAIN_COOKIE] });
  });

  it('ignores unrelated cookies and refuses similarly prefixed backup-cookie names', async () => {
    const credential = await installedSession();
    expect(
      (
        await verifyLegacyWebCookie(
          `theme=dark; ${SECURE_COOKIE}=${credential}; next-auth.callback-url=ignored`,
          LEGACY_SECRET,
          NOW,
        )
      )?.userId,
    ).toBe('same-existing-user');
    expect(await verifyLegacyWebCookie(`${SECURE_COOKIE}-backup=${credential}`, LEGACY_SECRET, NOW)).toBeNull();
  });

  it('bounds header/token sizes and handles absence or invalid server clock without throwing', async () => {
    expect(await verifyLegacyWebCookie(null, LEGACY_SECRET, NOW)).toBeNull();
    expect(await verifyLegacyWebCookie('', LEGACY_SECRET, NOW)).toBeNull();
    expect(await verifyLegacyWebCookie(`${SECURE_COOKIE}=${'a'.repeat(128 * 1024)}`, LEGACY_SECRET, NOW)).toBeNull();
    expect(await verifyLegacyNextAuthJwe('a'.repeat(64 * 1024 + 1), LEGACY_SECRET, NOW)).toBeNull();
    const credential = await installedSession();
    expect(await verifyLegacyNextAuthJwe(credential, '', NOW)).toBeNull();
    expect(await verifyLegacyNextAuthJwe(credential, LEGACY_SECRET, new Date(Number.NaN))).toBeNull();
  });
});
