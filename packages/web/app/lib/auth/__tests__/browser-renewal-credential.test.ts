// @vitest-environment node
import { decode, encode, type JWT, type JWTEncodeParams } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AUTH_BACKEND_UNAVAILABLE, type WebCredentialProof } from '@boardsesh/auth-protocol';
import type { BrowserSourceCredential } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { BrowserRenewalPreparation } from '@boardsesh/auth-protocol/browser-renewal-v1';
vi.mock('server-only', () => ({}));
import { issuePreparedBrowserRenewalCredential } from '../browser-renewal-credential.server';
import { browserRenewalSourceHash } from '../browser-renewal-command-client.server';

const secret = 'owned-actual-nextauth-renewal-issuer-secret-6975';
let milliseconds: number;
let clock: MockInstance<() => number>;
beforeEach(() => {
  milliseconds = Math.floor(Date.now() / 1000) * 1000;
  clock = vi.spyOn(Date, 'now').mockReturnValue(milliseconds);
});
afterEach(() => vi.restoreAllMocks());
async function fixture(
  kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe',
  known = true,
  noSid = false,
  unguardedAge = false,
) {
  const proof: WebCredentialProof = {
    version: 1,
    userId: 'actual-owner',
    authSessionId: 'original-admitted-SID',
    generation: 4,
    authenticatedAt: known ? new Date(milliseconds - 3 * 86400000).toISOString() : null,
    linkGuarded: known,
    ...(noSid ? { requiresAccountCutoff: true } : {}),
  };
  const claims: JWT = {
    sub: proof.userId,
    gen: proof.generation,
    name: 'Actual profile',
    email: 'actual@example.test',
    ...(noSid ? {} : { authSessionId: proof.authSessionId }),
    ...(known || unguardedAge ? { auth_time: (milliseconds - 3 * 86400000) / 1000 } : {}),
    ...(known ? { link_guarded: true } : {}),
  };
  const source: BrowserSourceCredential =
    kind === 'canonical-token'
      ? { kind, token: 'A'.repeat(43) }
      : { kind, credential: await encode({ secret, token: claims, maxAge: 3600 }) };
  const target = new Date(milliseconds + 30 * 86400000).toISOString();
  const browserCursor = {
    bindingId: 'b'.repeat(64),
    version: 3,
    bindingExpiresAt: new Date(milliseconds + 86400000).toISOString(),
  };
  const preparation: BrowserRenewalPreparation = {
    version: 1,
    credentialKind: kind,
    sourceCredentialProof: structuredClone(proof),
    sourceCredentialHash: browserRenewalSourceHash(source),
    sourceExpiresAt: new Date(milliseconds + 3600000).toISOString(),
    browserCursor,
    intentRevision: 2,
    futureBrowserCursor: { ...browserCursor, version: 4, bindingExpiresAt: target },
    targetExpiresAt: target,
    preparedAt: new Date(milliseconds).toISOString(),
    expiresAt: new Date(milliseconds + 60000).toISOString(),
  };
  return { source, sourceCredentialProof: proof, sourceExpiresAt: preparation.sourceExpiresAt, preparation };
}
describe('actual NextAuth ordinary renewal issuer', () => {
  for (const known of [false, true])
    it.each([false, true])(`retains original age known=${known} and no-SID ancestry=%s`, async (noSid) => {
      const current = await fixture('legacy-jwe', known, noSid);
      const result = await issuePreparedBrowserRenewalCredential(current, { secret });
      if (result.kind !== 'legacy-jwe') throw new Error('Owned actual JWE candidate expected');
      const actual = await decode({ secret, token: result.credential });
      expect(actual).toMatchObject({
        sub: 'actual-owner',
        authSessionId: 'original-admitted-SID',
        gen: 4,
        name: 'Actual profile',
        email: 'actual@example.test',
        exp: Date.parse(current.preparation.targetExpiresAt) / 1000,
      });
      expect(actual?.auth_time).toBe(
        known ? Date.parse(current.sourceCredentialProof.authenticatedAt!) / 1000 : undefined,
      );
      expect(actual?.link_guarded).toBe(known ? true : undefined);
      expect(actual?.legacy_no_sid).toBe(noSid ? true : undefined);
      expect(Object.isFrozen(result)).toBe(true);
    });
  it.each([false, true])('retains the actual canonical token unchanged, known age=%s', async (known) => {
    const current = await fixture('canonical-token', known);
    const encoder = vi.fn<typeof encode>();
    expect(await issuePreparedBrowserRenewalCredential(current, { secret: '', encode: encoder })).toEqual(
      current.source,
    );
    expect(encoder).not.toHaveBeenCalled();
  });
  it('drops unguarded historical age instead of making renewal fresh', async () => {
    const current = await fixture('legacy-jwe', false, false, true);
    const result = await issuePreparedBrowserRenewalCredential(current, { secret });
    if (result.kind !== 'legacy-jwe') throw new Error('Owned actual JWE candidate expected');
    const actual = await decode({ secret, token: result.credential });
    expect(actual).not.toHaveProperty('auth_time');
    expect(actual).not.toHaveProperty('link_guarded');
    expect(actual?.gen).toBe(4);
  });
  it.each(['owner', 'sid', 'generation', 'age', 'ancestry'] as const)(
    'refuses coherent forged %s before encoding',
    async (field) => {
      const current = await fixture();
      if (field === 'owner') current.sourceCredentialProof.userId = 'foreign-owner';
      if (field === 'sid') current.sourceCredentialProof.authSessionId = 'different-SID';
      if (field === 'generation') current.sourceCredentialProof.generation++;
      if (field === 'age') current.sourceCredentialProof.authenticatedAt = new Date(milliseconds - 30000).toISOString();
      if (field === 'ancestry') current.sourceCredentialProof.requiresAccountCutoff = true;
      current.preparation.sourceCredentialProof = structuredClone(current.sourceCredentialProof);
      const encoder = vi.fn<typeof encode>(encode);
      await expect(issuePreparedBrowserRenewalCredential(current, { secret, encode: encoder })).rejects.toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
      expect(encoder).not.toHaveBeenCalled();
    },
  );
  it.each(['kind', 'hash', 'source-expiry', 'proof', 'target'] as const)(
    'refuses changed %s metadata',
    async (field) => {
      const current = await fixture();
      if (field === 'kind') current.preparation.credentialKind = 'canonical-token';
      if (field === 'hash') current.preparation.sourceCredentialHash = 'e'.repeat(64);
      if (field === 'source-expiry')
        current.preparation.sourceExpiresAt = new Date(milliseconds + 3700000).toISOString();
      if (field === 'proof') current.preparation.sourceCredentialProof.generation++;
      if (field === 'target')
        current.preparation.targetExpiresAt = new Date(
          Date.parse(current.preparation.targetExpiresAt) + 1000,
        ).toISOString();
      await expect(issuePreparedBrowserRenewalCredential(current, { secret })).rejects.toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
    },
  );
  it('refuses a source whose actual decoded expiry differs from frozen metadata', async () => {
    const current = await fixture();
    current.sourceExpiresAt = new Date(milliseconds + 3700000).toISOString();
    current.preparation.sourceExpiresAt = current.sourceExpiresAt;
    await expect(issuePreparedBrowserRenewalCredential(current, { secret })).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });
  it('refuses a second-boundary mismatch from the actual installed encoder', async () => {
    const current = await fixture();
    const encoder = vi.fn<typeof encode>(async (parameters) => {
      clock.mockReturnValue(milliseconds + 1000);
      return encode(parameters);
    });
    await expect(issuePreparedBrowserRenewalCredential(current, { secret, encode: encoder })).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
    expect(encoder).toHaveBeenCalledOnce();
  });
  it('refuses expiry after encoding even when actual target claims remain exact', async () => {
    const current = await fixture();
    const encoder = vi.fn<typeof encode>(async (parameters) => {
      const actual = await encode(parameters);
      clock.mockReturnValue(milliseconds + 61000);
      return actual;
    });
    await expect(issuePreparedBrowserRenewalCredential(current, { secret, encode: encoder })).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });
  it.each(['sub', 'authSessionId', 'gen', 'auth_time', 'legacy_no_sid', 'exp'] as const)(
    'checks actual emitted %s rather than trusting the encoder',
    async (field) => {
      const current = await fixture();
      const encoder = vi.fn<typeof encode>(async (parameters) => {
        const changed: JWTEncodeParams = { ...parameters, token: { ...parameters.token } };
        if (field === 'sub') changed.token!.sub = 'foreign-owner';
        if (field === 'authSessionId') changed.token!.authSessionId = 'foreign-SID';
        if (field === 'gen') changed.token!.gen = 5;
        if (field === 'auth_time') changed.token!.auth_time = milliseconds / 1000;
        if (field === 'legacy_no_sid') changed.token!.legacy_no_sid = true;
        if (field === 'exp') changed.maxAge = (parameters.maxAge ?? 0) + 1;
        return encode(changed);
      });
      await expect(issuePreparedBrowserRenewalCredential(current, { secret, encode: encoder })).rejects.toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
    },
  );
  it('captures nested caller evidence before an awaited encoder can mutate it', async () => {
    const current = await fixture();
    const encoder = vi.fn<typeof encode>(async (parameters) => {
      current.sourceCredentialProof.generation = 99;
      current.preparation.sourceCredentialProof.generation = 99;
      current.preparation.targetExpiresAt = new Date(milliseconds + 9999999999).toISOString();
      return encode(parameters);
    });
    const result = await issuePreparedBrowserRenewalCredential(current, { secret, encode: encoder });
    if (result.kind !== 'legacy-jwe') throw new Error('Owned actual JWE candidate expected');
    expect((await decode({ secret, token: result.credential }))?.gen).toBe(4);
  });
});
