// @vitest-environment node
import { createHash } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
  anonymousProviderFlowCookieName,
  anonymousProviderPendingCookieName,
  captureAnonymousProviderBrowserContext,
  openAnonymousProviderFlow,
  requireAnonymousProviderBrowser,
  sealAnonymousProviderFlow,
  type AnonymousProviderFlow,
} from '../anonymous-provider-flow.server';
import { BROWSER_CORRELATION_COOKIE } from '../browser-proof-cookies.server';
import type { PresentedBrowserSelection } from '../presented-browser-selection.server';

const now = Date.UTC(2026, 10, 14, 12);
const secret = 'owned-anonymous-provider-flow-secret-6975';
const token = 'A'.repeat(43);
const bindingId = createHash('sha256').update(token).digest('hex');
function anonymous(): PresentedBrowserSelection {
  return {
    status: 'anonymous',
    cursor: { bindingId, version: 2, bindingExpiresAt: new Date(now + 3_600_000).toISOString() },
  };
}
function flow(): AnonymousProviderFlow {
  return {
    version: 1,
    provider: 'google',
    credentialKind: 'canonical-token',
    browserBindingHash: bindingId,
    browserVersion: 2,
    browserBindingExpiresAt: new Date(now + 3_600_000).toISOString(),
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    flowHash: 'a'.repeat(64),
    nonce: 'actual-verified-oidc-nonce',
    returnUrl: 'https://www.example.test/settings',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(),
    preparationToken: null,
    preparation: null,
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now });
});
afterEach(() => {
  vi.useRealTimers();
});
describe('purpose-separated anonymous provider carrier', () => {
  it.each(['google', 'apple'] as const)(
    'round-trips %s with both credential kinds and no source actor',
    async (provider) => {
      for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
        const input = {
          ...flow(),
          provider,
          credentialKind: kind,
          nonce: provider === 'google' ? 'actual-oidc-nonce' : null,
        };
        const sealed = await sealAnonymousProviderFlow(input, secret);
        expect(await openAnonymousProviderFlow(sealed, input.flowHash, secret)).toEqual(input);
        expect(Buffer.byteLength(sealed)).toBeLessThanOrEqual(3800);
        expect(anonymousProviderFlowCookieName(input.flowHash)).toBe(
          `__Host-boardsesh.anonymous-provider.${input.flowHash}`,
        );
        expect(anonymousProviderPendingCookieName(input.flowHash)).not.toBe(
          anonymousProviderFlowCookieName(input.flowHash),
        );
      }
    },
  );
  it('rejects altered selector, wrong secret, raw credential and a changed ciphertext', async () => {
    const sealed = await sealAnonymousProviderFlow(flow(), secret);
    await expect(openAnonymousProviderFlow(sealed, 'b'.repeat(64), secret)).rejects.toThrow();
    await expect(openAnonymousProviderFlow(sealed, flow().flowHash, `${secret}other`)).rejects.toThrow();
    await expect(
      openAnonymousProviderFlow(await encode({ secret, token: { sub: 'asserted-user' } }), flow().flowHash, secret),
    ).rejects.toThrow();
    await expect(openAnonymousProviderFlow(`${sealed.slice(0, -3)}abc`, flow().flowHash, secret)).rejects.toThrow();
  });
  it.each([
    { nonce: null },
    { provider: 'apple', nonce: 'not-an-apple-nonce' },
    { expiresAt: new Date(now + 901_000).toISOString() },
    { browserBindingExpiresAt: new Date(now + 1000).toISOString() },
    { preparationToken: 'D'.repeat(43) },
    { assertedUserId: 'attacker-chosen' },
    { returnUrl: 'https://www.example.test/settings#bearer' },
  ])('refuses incoherent or asserted carrier fields %j', async (changed) => {
    await expect(sealAnonymousProviderFlow({ ...flow(), ...changed }, secret)).rejects.toThrow();
  });
  it('never extends the absolute deadline when reopened', async () => {
    const input = flow();
    const sealed = await sealAnonymousProviderFlow(input, secret);
    vi.setSystemTime(now + 301_000);
    await expect(openAnonymousProviderFlow(sealed, input.flowHash, secret)).rejects.toThrow();
  });
  it('requires positive primary anonymous state plus the actual exact correlation cookie', () => {
    const actual = captureAnonymousProviderBrowserContext(`${BROWSER_CORRELATION_COOKIE}=${token}`, anonymous());
    expect(actual.browser).toEqual({ bindingToken: token, expectedVersion: 2 });
    requireAnonymousProviderBrowser(flow(), actual);
    expect(() => captureAnonymousProviderBrowserContext(null, anonymous())).toThrow();
    expect(() =>
      captureAnonymousProviderBrowserContext(`${BROWSER_CORRELATION_COOKIE}=${'Z'.repeat(43)}`, anonymous()),
    ).toThrow();
    expect(() => requireAnonymousProviderBrowser({ ...flow(), browserVersion: 3 }, actual)).toThrow();
    expect(() =>
      captureAnonymousProviderBrowserContext(
        `${BROWSER_CORRELATION_COOKIE}=${token}; ${BROWSER_CORRELATION_COOKIE}=${token}`,
        anonymous(),
      ),
    ).toThrow();
  });
  it.each(['missing-binding', 'proof-required', 'denied', 'conflict', 'unavailable'] as const)(
    'does not coerce %s into anonymous',
    (status) => {
      expect(() =>
        captureAnonymousProviderBrowserContext(`${BROWSER_CORRELATION_COOKIE}=${token}`, { status }),
      ).toThrow();
    },
  );
  it('captures the cursor before the primary result can be changed', () => {
    const selection = anonymous();
    if (selection.status !== 'anonymous') throw new Error('fixture');
    const captured = captureAnonymousProviderBrowserContext(`${BROWSER_CORRELATION_COOKIE}=${token}`, selection);
    Object.assign(selection.cursor, { version: 9 });
    expect(captured.cursor.version).toBe(2);
  });
});
