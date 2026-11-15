// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
vi.mock('server-only', () => ({}));
import {
  BROWSER_PASSWORD_CUSTODY_LIMITS,
  browserPasswordCustodySchema,
  browserPasswordCustodyCookieName,
  buildBrowserPasswordCustodyCookies,
  buildObservedBrowserPasswordCustodyClears,
  observedBrowserPasswordOperationKeys,
  openBrowserPasswordCustody,
  readBrowserPasswordCustody,
  sealBrowserPasswordCustody,
} from '../browser-password-custody.server';
import { browserPasswordFixture, passwordTestEnvironment } from './fixtures/browser-password';

function fixture(kind: 'legacy-jwe' | 'canonical-token' = 'canonical-token') {
  const now = new Date(),
    current = browserPasswordFixture(kind, true, now.getTime());
  const custody = browserPasswordCustodySchema.parse({
    version: 1,
    purpose: 'boardsesh-browser-password-candidate-custody-v1',
    operationKey: current.preparation.nonceHash,
    canonicalOrigin: passwordTestEnvironment.NEXTAUTH_URL,
    source: current.source,
    operationToken: current.operationToken,
    browserIntentToken: current.browserIntentToken,
    preparation: current.preparation,
    candidate: current.candidate,
    destination: 'https://www.boardsesh.test/settings',
  });
  const sealed = sealBrowserPasswordCustody(custody, passwordTestEnvironment.NEXTAUTH_SECRET, now);
  const headers = buildBrowserPasswordCustodyCookies(custody, sealed, null, now);
  const cookieHeader = headers.map((header) => header.split(';', 1)[0]).join('; ');
  return { custody, sealed, headers, cookieHeader, now };
}
describe('password candidate custody before physical finalization', () => {
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'retains exact %s bytes and capabilities only inside authenticated encryption',
    (kind) => {
      const current = fixture(kind);
      const opened = openBrowserPasswordCustody(
        current.sealed,
        current.custody.operationKey,
        current.custody.canonicalOrigin,
        passwordTestEnvironment.NEXTAUTH_SECRET,
        current.now,
      );
      expect(opened.status).toBe('live');
      expect(opened.custody).toEqual(current.custody);
      for (const secret of [
        current.custody.operationToken,
        current.custody.browserIntentToken,
        current.custody.source.bindingToken,
        current.custody.candidate.kind === 'canonical-token'
          ? current.custody.candidate.token
          : current.custody.candidate.credential,
      ])
        expect(current.sealed).not.toContain(secret);
      expect(readBrowserPasswordCustody(current.cookieHeader, current.custody.operationKey)).toBe(current.sealed);
      expect(current.headers.every((header) => header.includes('; Path=/; HttpOnly; Secure; SameSite=Lax'))).toBe(true);
    },
  );
  it.each(['key', 'origin', 'operation', 'ciphertext'] as const)(
    'refuses changed %s without decoder details',
    (change) => {
      const current = fixture();
      const sealed = change === 'ciphertext' ? Buffer.from(current.sealed, 'base64url') : null;
      if (sealed) sealed[15] ^= 1;
      expect(() =>
        openBrowserPasswordCustody(
          sealed?.toString('base64url') ?? current.sealed,
          change === 'operation' ? 'a'.repeat(64) : current.custody.operationKey,
          change === 'origin' ? 'https://other.boardsesh.test' : current.custody.canonicalOrigin,
          change === 'key' ? 'a-different-strong-cookie-key-owned-6975' : passwordTestEnvironment.NEXTAUTH_SECRET,
          current.now,
        ),
      ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    },
  );
  it('keeps exact completed recovery available after the old source/preparation expires', () => {
    const current = fixture();
    if (current.custody.preparation.source.state !== 'selected') throw new Error('Expected selected fixture');
    const expiry = new Date(current.now.getTime() + 10_000).toISOString();
    current.custody.preparation.source.expiresAt = expiry;
    current.custody.preparation.expiresAt = expiry;
    const sealed = sealBrowserPasswordCustody(current.custody, passwordTestEnvironment.NEXTAUTH_SECRET, current.now);
    const afterSource = new Date(current.now.getTime() + 11_000);
    expect(
      openBrowserPasswordCustody(
        sealed,
        current.custody.operationKey,
        current.custody.canonicalOrigin,
        passwordTestEnvironment.NEXTAUTH_SECRET,
        afterSource,
      ).status,
    ).toBe('live');
    expect(() =>
      sealBrowserPasswordCustody(current.custody, passwordTestEnvironment.NEXTAUTH_SECRET, afterSource),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    const atAckDeadline = new Date(current.custody.preparation.acknowledgeUntil);
    expect(
      openBrowserPasswordCustody(
        sealed,
        current.custody.operationKey,
        current.custody.canonicalOrigin,
        passwordTestEnvironment.NEXTAUTH_SECRET,
        atAckDeadline,
      ).status,
    ).toBe('expired');
  });
  it('rejects nonfinite clocks and never moves fixed credential or ACK deadlines', () => {
    const current = fixture();
    expect(() =>
      openBrowserPasswordCustody(
        current.sealed,
        current.custody.operationKey,
        current.custody.canonicalOrigin,
        passwordTestEnvironment.NEXTAUTH_SECRET,
        new Date(NaN),
      ),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    const opened = openBrowserPasswordCustody(
      current.sealed,
      current.custody.operationKey,
      current.custody.canonicalOrigin,
      passwordTestEnvironment.NEXTAUTH_SECRET,
      new Date(current.now.getTime() + 1000),
    );
    expect(opened.custody.preparation.credentialProof.authenticatedAt).toBe(
      current.custody.preparation.credentialProof.authenticatedAt,
    );
    expect(opened.custody.preparation.credentialExpiresAt).toBe(current.custody.preparation.credentialExpiresAt);
    expect(opened.custody.preparation.acknowledgeUntil).toBe(current.custody.preparation.acknowledgeUntil);
  });
  it('clears only the complete observed operation family, preserving other custody and old proofs', () => {
    const current = fixture(),
      otherName = browserPasswordCustodyCookieName('a'.repeat(64));
    const observed = `${otherName}=unrelated; __Host-boardsesh.browser-proof.old.7=original-proof; ${current.cookieHeader}`;
    const clears = buildObservedBrowserPasswordCustodyClears(observed, current.custody.operationKey);
    expect(clears).toEqual(
      current.headers.map((header) => header.split('=', 1)[0] + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'),
    );
    expect(clears.join('; ')).not.toContain(otherName);
    expect(clears.join('; ')).not.toContain('original-proof');
    expect(buildObservedBrowserPasswordCustodyClears(null, current.custody.operationKey)).toEqual([]);
  });
  it.each(['missing-chunk', 'duplicate', 'mixed-base', 'oversize-chunk', 'extra-suffix'] as const)(
    'refuses %s rather than partially reading or clearing a family',
    (fault) => {
      const current = fixture(),
        base = browserPasswordCustodyCookieName(current.custody.operationKey);
      let observed = current.cookieHeader;
      if (fault === 'missing-chunk') observed = `${base}.1=chunk`;
      if (fault === 'duplicate') observed += '; ' + current.cookieHeader;
      if (fault === 'mixed-base') observed = `${base}=chunk; ${base}.0=chunk`;
      if (fault === 'oversize-chunk')
        observed = `${base}=${'a'.repeat(BROWSER_PASSWORD_CUSTODY_LIMITS.chunkBytes + 1)}`;
      if (fault === 'extra-suffix') observed = `${base}.x=chunk`;
      expect(() => readBrowserPasswordCustody(observed, current.custody.operationKey)).toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
      expect(() => buildObservedBrowserPasswordCustodyClears(observed, current.custody.operationKey)).toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
    },
  );
  it('refuses creating a fifth custody family before any finalizer', () => {
    const current = fixture();
    const observed = ['1', '2', '3', '4']
      .map((character) => browserPasswordCustodyCookieName(character.repeat(64)) + '=opaque')
      .join('; ');
    expect(() => buildBrowserPasswordCustodyCookies(current.custody, current.sealed, observed, current.now)).toThrow();
  });
  it('bounds the operation scan and never accepts a bearer in metadata', () => {
    const current = fixture();
    expect(observedBrowserPasswordOperationKeys(current.cookieHeader)).toEqual([current.custody.operationKey]);
    const many = Array.from(
      { length: 5 },
      (_, index) => `${browserPasswordCustodyCookieName(String(index).repeat(64))}=opaque`,
    ).join('; ');
    expect(() => observedBrowserPasswordOperationKeys(many)).toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(() =>
      browserPasswordCustodySchema.parse({ ...current.custody, password: 'never retain the password' }),
    ).toThrow();
  });
});
