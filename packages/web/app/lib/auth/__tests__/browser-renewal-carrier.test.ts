// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import {
  BROWSER_RENEWAL_CARRIER_PREFIX,
  browserRenewalCarrierExpiry,
  browserRenewalOperationKey,
  observedBrowserRenewalOperationKeys,
  prepareBrowserRenewalCarrierCookies,
  readBrowserRenewalCarrier,
  sealBrowserRenewalCarrier,
  type BrowserRenewalCarrier,
} from '../browser-renewal-carrier.server';
import { browserRenewalSourceHash } from '../browser-renewal-command-client.server';

const origin = 'https://www.renewal-custody.example.test';
const secret = 'owned-renewal-custody-distinct-cookie-key-6975';
const now = Math.floor(Date.now() / 1000) * 1000;
function fixture(
  kind: 'canonical-token' | 'legacy-jwe' = 'canonical-token',
  operationToken = 'A'.repeat(43),
): BrowserRenewalCarrier {
  const source =
    kind === 'canonical-token'
      ? { kind, token: 'B'.repeat(43) }
      : { kind, credential: 'owned-actual-old-credential-' + 'x'.repeat(900) };
  const candidate =
    kind === 'canonical-token' ? { ...source } : { kind, credential: 'owned-actual-new-credential-' + 'y'.repeat(900) };
  const target = new Date(now + 30 * 86400000).toISOString();
  const browserCursor = {
    bindingId: createHash('sha256').update('actual-correlation-token').digest('hex'),
    version: 3,
    bindingExpiresAt: new Date(now + 20000).toISOString(),
  };
  const preparation = {
    version: 1 as const,
    credentialKind: kind,
    sourceCredentialProof: {
      version: 1 as const,
      userId: 'actual-owner',
      authSessionId: 'original-SID',
      generation: 4,
      authenticatedAt: new Date(now - 86400000).toISOString(),
      linkGuarded: true,
    },
    sourceCredentialHash: browserRenewalSourceHash(source),
    sourceExpiresAt: new Date(now + 10000).toISOString(),
    browserCursor,
    intentRevision: 2,
    futureBrowserCursor: { ...browserCursor, version: 4, bindingExpiresAt: target },
    targetExpiresAt: target,
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10000).toISOString(),
  };
  return {
    version: 1,
    operationToken,
    preparationToken: 'C'.repeat(43),
    nonceHash: 'd'.repeat(64),
    actor: { version: 3, credential: source },
    candidate,
    preparation,
    expiresAt: browserRenewalCarrierExpiry(preparation),
  };
}
function published(kind: 'canonical-token' | 'legacy-jwe' = 'canonical-token') {
  const carrier = fixture(kind);
  const sealed = sealBrowserRenewalCarrier(carrier, secret, origin, now);
  const plan = prepareBrowserRenewalCarrierCookies({ ...sealed, observedCookieHeader: 'unrelated=retained', now });
  return { carrier, sealed, plan, header: plan.projectedCookieHeader };
}
describe('unique operation-named actual renewal credential custody', () => {
  it.each(['canonical-token', 'legacy-jwe'] as const)(
    'round-trips actual old and candidate %s bytes through physical cookies',
    (kind) => {
      const current = published(kind);
      expect(readBrowserRenewalCarrier(current.header, current.sealed.operationKey, secret, origin, now)).toEqual(
        current.carrier,
      );
      expect(observedBrowserRenewalOperationKeys(current.header)).toEqual([current.sealed.operationKey]);
      expect(current.sealed.operationKey).toBe(browserRenewalOperationKey(current.carrier.operationToken));
      expect(
        current.plan.headers.every((header) => header.includes('Path=/; Secure; HttpOnly; SameSite=Lax; Expires=')),
      ).toBe(true);
      expect(current.plan.headers.every((header) => header.startsWith(BROWSER_RENEWAL_CARRIER_PREFIX))).toBe(true);
      expect(current.header).not.toContain('browser-proof.');
      expect(current.header).not.toContain('actual-owner');
      expect(current.header).not.toContain(current.carrier.operationToken);
      expect(current.header).not.toContain(
        kind === 'canonical-token' ? 'B'.repeat(43) : 'owned-actual-old-credential-',
      );
      if (kind === 'legacy-jwe') expect(current.plan.headers.length).toBeGreaterThan(1);
    },
  );
  it('retains both actual credentials after parent/preparation expiry only for bounded read-only recovery', () => {
    const current = published('legacy-jwe');
    const afterParent = now + 30000;
    expect(readBrowserRenewalCarrier(current.header, current.sealed.operationKey, secret, origin, afterParent)).toEqual(
      current.carrier,
    );
    expect(() => sealBrowserRenewalCarrier(current.carrier, secret, origin, afterParent)).toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
    expect(() =>
      readBrowserRenewalCarrier(
        current.header,
        current.sealed.operationKey,
        secret,
        origin,
        Date.parse(current.carrier.expiresAt),
      ),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
  });
  it.each(['secret', 'host', 'selector', 'ciphertext'] as const)('refuses swapped %s custody', (fault) => {
    const current = published();
    let header = current.header,
      selector = current.sealed.operationKey,
      key = secret,
      host = origin;
    if (fault === 'secret') key += '-rotated';
    if (fault === 'host') host = 'https://other.renewal-custody.example.test';
    if (fault === 'selector') {
      selector = 'f'.repeat(64);
      header = header.replace(current.sealed.operationKey, selector);
    }
    if (fault === 'ciphertext') {
      const pieces = current.sealed.sealed.split('.');
      pieces[2] = (pieces[2][0] === 'x' ? 'y' : 'x') + pieces[2].slice(1);
      header = header.replace(current.sealed.sealed, pieces.join('.'));
    }
    expect(() => readBrowserRenewalCarrier(header, selector, key, host, now)).toThrow(AUTH_BACKEND_UNAVAILABLE);
  });
  it.each(['missing', 'duplicate', 'mixed', 'hole', 'alias', 'leading-zero'] as const)(
    'refuses %s physical chunks instead of reconstructing absent custody',
    (fault) => {
      const current = published('legacy-jwe');
      const pairs = current.plan.headers.map((header) => header.split(';', 1)[0]);
      const base = BROWSER_RENEWAL_CARRIER_PREFIX + current.sealed.operationKey;
      if (fault === 'missing') pairs.pop();
      if (fault === 'duplicate') pairs.push(pairs[0]);
      if (fault === 'mixed') pairs.push(`${base}=${current.sealed.sealed.slice(0, 100)}`);
      if (fault === 'hole') pairs[0] = pairs[0].replace(`${base}.0=`, `${base}.7=`);
      if (fault === 'alias') pairs.splice(0, pairs.length, `${base}.0=${current.sealed.sealed.slice(0, 100)}`);
      if (fault === 'leading-zero') pairs[0] = pairs[0].replace(`${base}.0=`, `${base}.00=`);
      expect(() =>
        readBrowserRenewalCarrier(pairs.join('; '), current.sealed.operationKey, secret, origin, now),
      ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    },
  );
  it.each(['source-hash', 'version', 'kind', 'canonical-token', 'lifetime'] as const)(
    'refuses internally inconsistent %s before sealing',
    (fault) => {
      const current = fixture();
      if (fault === 'source-hash') current.preparation.sourceCredentialHash = 'e'.repeat(64);
      if (fault === 'version') current.actor.version++;
      if (fault === 'kind') current.candidate = { kind: 'legacy-jwe', credential: 'different-kind' };
      if (fault === 'canonical-token') current.candidate = { kind: 'canonical-token', token: 'Z'.repeat(43) };
      if (fault === 'lifetime') current.expiresAt = new Date(Date.parse(current.expiresAt) + 1).toISOString();
      expect(() => sealBrowserRenewalCarrier(current, secret, origin, now)).toThrow(AUTH_BACKEND_UNAVAILABLE);
    },
  );
  it('keeps current-operation names unique rather than overwriting earlier preparation headers', () => {
    const first = published();
    expect(() =>
      prepareBrowserRenewalCarrierCookies({ ...first.sealed, observedCookieHeader: first.header, now }),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    const other = fixture('canonical-token', 'E'.repeat(43));
    const sealed = sealBrowserRenewalCarrier(other, secret, origin, now);
    const plan = prepareBrowserRenewalCarrierCookies({ ...sealed, observedCookieHeader: first.header, now });
    expect(observedBrowserRenewalOperationKeys(plan.projectedCookieHeader)).toEqual([
      first.sealed.operationKey,
      sealed.operationKey,
    ]);
    expect(
      readBrowserRenewalCarrier(plan.projectedCookieHeader, first.sealed.operationKey, secret, origin, now),
    ).toEqual(first.carrier);
  });
  it('budgets complete next-request cookie pairs, including unrelated duplicates', () => {
    const sealed = sealBrowserRenewalCarrier(fixture(), secret, origin, now);
    const allowed = Array.from({ length: 127 }, (_, index) => `p${index}=x`).join('; ');
    const plan = prepareBrowserRenewalCarrierCookies({ ...sealed, observedCookieHeader: allowed, now });
    expect(plan.projectedCookieHeader.split(';')).toHaveLength(128);
    expect(
      readBrowserRenewalCarrier(plan.projectedCookieHeader, sealed.operationKey, secret, origin, now).actor.version,
    ).toBe(3);
    const full = allowed + '; p0=another';
    expect(() => prepareBrowserRenewalCarrierCookies({ ...sealed, observedCookieHeader: full, now })).toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });
  it('refuses byte overflow and a fifth operation without clearing existing cookies', () => {
    const sealed = sealBrowserRenewalCarrier(fixture(), secret, origin, now);
    expect(() =>
      prepareBrowserRenewalCarrierCookies({ ...sealed, observedCookieHeader: 'unrelated=' + 'x'.repeat(8000), now }),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    const four = ['1', '2', '3', '4']
      .map((digit) => `${BROWSER_RENEWAL_CARRIER_PREFIX}${digit.repeat(64)}=v1.unrelated.custody.tag`)
      .join('; ');
    expect(() => prepareBrowserRenewalCarrierCookies({ ...sealed, observedCookieHeader: four, now })).toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });
  it('reserves the other response cookies before publishing any carrier chunks', () => {
    const current = published('legacy-jwe');
    const exactBytes = current.plan.headers.reduce(
      (total, header) => total + Buffer.byteLength(`Set-Cookie: ${header}\r\n`),
      0,
    );
    expect(
      prepareBrowserRenewalCarrierCookies({
        ...current.sealed,
        observedCookieHeader: null,
        now,
        responseHeaderBudgetBytes: exactBytes,
        responseHeaderCountBudget: current.plan.headers.length,
      }).headers,
    ).toEqual(current.plan.headers);
    expect(() =>
      prepareBrowserRenewalCarrierCookies({
        ...current.sealed,
        observedCookieHeader: null,
        now,
        responseHeaderBudgetBytes: exactBytes - 1,
      }),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(() =>
      prepareBrowserRenewalCarrierCookies({
        ...current.sealed,
        observedCookieHeader: null,
        now,
        responseHeaderCountBudget: current.plan.headers.length - 1,
      }),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
  });
  it('keeps physical cookie expiry at or after its exact server custody deadline', () => {
    const carrier = fixture();
    carrier.preparation.expiresAt = new Date(now + 9999).toISOString();
    carrier.expiresAt = browserRenewalCarrierExpiry(carrier.preparation);
    const sealed = sealBrowserRenewalCarrier(carrier, secret, origin, now);
    const plan = prepareBrowserRenewalCarrierCookies({ ...sealed, observedCookieHeader: null, now });
    const actual = /Expires=([^;]+)/.exec(plan.headers[0]);
    expect(actual).not.toBeNull();
    const milliseconds = Date.parse(actual![1]) - Date.parse(carrier.expiresAt);
    expect(milliseconds).toBeGreaterThanOrEqual(0);
    expect(milliseconds).toBeLessThan(1000);
  });
});
