import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
vi.mock('server-only', () => ({}));
import {
  EXPIRED_BROWSER_BINDING_CARRIER_PREFIX,
  expiredBrowserBindingOperationKey,
  observedExpiredBrowserBindingOperationKeys,
  prepareExpiredBrowserBindingCarrierCookies,
  readExpiredBrowserBindingCarrier,
  sealExpiredBrowserBindingCarrier,
  type ExpiredBrowserBindingCarrier,
} from '../expired-browser-binding-carrier.server';

const origin = 'https://www.owned-expired-binding.example.test';
const secret = 'owned-expired-binding-cookie-secret-6975';
const now = Date.parse('2026-11-15T15:00:00.123Z');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
function fixture(index = 1): ExpiredBrowserBindingCarrier {
  const bindingToken = Buffer.alloc(32, index).toString('base64url');
  const targetBindingToken = Buffer.alloc(32, index + 30).toString('base64url');
  return {
    version: 1,
    bindingToken,
    targetBindingToken,
    operationToken: Buffer.alloc(32, index + 60).toString('base64url'),
    preparation: {
      version: 1,
      purpose: 'expired-browser-binding-retirement-v1',
      oldBindingId: hash(bindingToken),
      oldVersion: 2,
      oldIntentRevision: 3,
      oldStateHash: 'c'.repeat(64),
      oldExpiresAt: new Date(now - 1_000).toISOString(),
      targetCursor: {
        bindingId: hash(targetBindingToken),
        version: 0,
        bindingExpiresAt: new Date(now + 30 * 86_400_000).toISOString(),
      },
      nonceHash: 'd'.repeat(64),
      authority: {
        projectionId: 'owned-projection',
        normalizerVersion: 'owned-normalizer',
        authority: 'current-store',
        epoch: 1,
      },
      preparedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      acknowledgeUntil: new Date(now + 300_000).toISOString(),
    },
    expiresAt: new Date(now + 300_000).toISOString(),
  };
}
function issued(carrier = fixture(), header: string | null = null) {
  const sealed = sealExpiredBrowserBindingCarrier(carrier, secret, origin, now);
  const plan = prepareExpiredBrowserBindingCarrierCookies({ ...sealed, observedCookieHeader: header, now });
  return { carrier, sealed, plan };
}
describe('expired-binding actual token custody', () => {
  it('keeps actual old/target/capability encrypted and freezes restored preparation', () => {
    const { carrier, sealed, plan } = issued();
    for (const token of [carrier.bindingToken, carrier.targetBindingToken, carrier.operationToken])
      expect(plan.projectedCookieHeader).not.toContain(token);
    const opened = readExpiredBrowserBindingCarrier(
      plan.projectedCookieHeader,
      sealed.operationKey,
      secret,
      origin,
      now,
    );
    expect(opened).toEqual(carrier);
    expect(Object.isFrozen(opened.preparation.authority)).toBe(true);
    expect(Object.isFrozen(opened.preparation.targetCursor)).toBe(true);
    expect(sealed.operationKey).toBe(hash(carrier.operationToken));
    expect(plan.headers.every((header) => header.includes('; Path=/; Secure; HttpOnly; SameSite=Lax;'))).toBe(true);
  });
  it.each(['bindingToken', 'targetBindingToken', 'expiresAt'] as const)('refuses mismatched %s', (field) => {
    const carrier = fixture();
    const changed =
      field === 'expiresAt' ? new Date(now + 299_999).toISOString() : Buffer.alloc(32, 99).toString('base64url');
    expect(() => issued({ ...carrier, [field]: changed })).toThrow();
  });
  it.each(['secret', 'origin', 'operation', 'ciphertext'] as const)('refuses changed %s', (field) => {
    const { sealed, plan } = issued();
    const header =
      field === 'ciphertext' ? plan.projectedCookieHeader.replace('=v1.', '=v1.A') : plan.projectedCookieHeader;
    expect(() =>
      readExpiredBrowserBindingCarrier(
        header,
        field === 'operation' ? 'f'.repeat(64) : sealed.operationKey,
        field === 'secret' ? secret + 'wrong' : secret,
        field === 'origin' ? 'https://app.owned-expired-binding.example.test' : origin,
        now,
      ),
    ).toThrow();
  });
  it('retains ACK custody after preparation closes, without allowing fresh sealing', () => {
    const { carrier, sealed, plan } = issued();
    expect(() => sealExpiredBrowserBindingCarrier(carrier, secret, origin, now + 60_000)).toThrow();
    expect(
      readExpiredBrowserBindingCarrier(plan.projectedCookieHeader, sealed.operationKey, secret, origin, now + 60_001),
    ).toEqual(carrier);
    expect(() =>
      readExpiredBrowserBindingCarrier(plan.projectedCookieHeader, sealed.operationKey, secret, origin, now + 300_000),
    ).toThrow();
  });
  it.each(['short', ' ' + secret, secret + ' ', ''])('refuses invalid key configuration', (key) => {
    expect(() => sealExpiredBrowserBindingCarrier(fixture(), key, origin, now)).toThrow();
  });
  it('chunks large frozen authority metadata, keeping all unrelated cookies', () => {
    const carrier = fixture();
    carrier.preparation.authority.projectionId = '界'.repeat(1_024);
    const { sealed, plan } = issued(carrier, 'ordinary=kept; other=same');
    expect(plan.headers.length).toBeGreaterThan(1);
    expect(plan.projectedCookieHeader).toContain('ordinary=kept; other=same');
    expect(
      readExpiredBrowserBindingCarrier(plan.projectedCookieHeader, sealed.operationKey, secret, origin, now),
    ).toEqual(carrier);
    const pairs = plan.projectedCookieHeader.split('; ');
    expect(() =>
      readExpiredBrowserBindingCarrier(pairs.slice(0, -1).join('; '), sealed.operationKey, secret, origin, now),
    ).toThrow();
  });
  it('refuses duplicate, malformed and mixed reserved families', () => {
    const { sealed, plan } = issued();
    for (const header of [
      plan.projectedCookieHeader + '; ' + plan.projectedCookieHeader,
      plan.projectedCookieHeader + `; ${EXPIRED_BROWSER_BINDING_CARRIER_PREFIX}${sealed.operationKey}.0=extra`,
      `${EXPIRED_BROWSER_BINDING_CARRIER_PREFIX}invalid=extra`,
    ])
      expect(() => readExpiredBrowserBindingCarrier(header, sealed.operationKey, secret, origin, now)).toThrow();
  });
  it('retains four distinct operations and refuses a fifth or overwrite', () => {
    let header: string | null = 'ordinary=kept';
    for (let index = 1; index <= 4; index++) header = issued(fixture(index), header).plan.projectedCookieHeader;
    expect(observedExpiredBrowserBindingOperationKeys(header)).toHaveLength(4);
    expect(() => issued(fixture(5), header)).toThrow();
    expect(() => issued(fixture(1), header)).toThrow();
  });
  it('counts the entire next request including unrelated duplicate pairs', () => {
    const unrelated = Array.from({ length: 128 }, () => 'ordinary=kept').join('; ');
    expect(() => issued(fixture(), unrelated)).toThrow();
    expect(() => issued(fixture(), 'ordinary=' + 'x'.repeat(8_100))).toThrow();
    const sealed = sealExpiredBrowserBindingCarrier(fixture(), secret, origin, now);
    expect(() =>
      prepareExpiredBrowserBindingCarrierCookies({
        ...sealed,
        observedCookieHeader: null,
        responseHeaderBudgetBytes: 1,
        now,
      }),
    ).toThrow();
  });
  it('does not reinterpret browser-visible selectors as private operation capabilities', () => {
    expect(() => expiredBrowserBindingOperationKey('a'.repeat(64))).toThrow();
  });
});
