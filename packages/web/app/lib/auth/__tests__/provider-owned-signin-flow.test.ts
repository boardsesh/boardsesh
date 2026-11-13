// @vitest-environment node
import { createHash } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
  openProviderOwnedSigninFlow,
  sealProviderOwnedSigninFlow,
  providerOwnedSigninCookieName,
  providerOwnedSigninPendingCookieName,
  providerOwnedSigninNonceHash,
  requireProviderOwnedSigninActor,
  type ProviderOwnedSigninFlow,
} from '../provider-owned-signin-flow.server';
import { captureProviderBrowserContext } from '../provider-security-selection.server';
import type { AdmittedBrowserSelection } from '../presented-browser-selection.server';

const secret = 'owned-provider-signin-flow-domain-secret-6975';
const now = Date.UTC(2026, 10, 13, 22, 0, 0);
function selected(): AdmittedBrowserSelection {
  const bindingToken = 'A'.repeat(43);
  return {
    status: 'admitted',
    bindingToken,
    actor: { version: 2, credential: { kind: 'canonical-token', token: 'actual-A-source' } },
    cursor: {
      bindingId: createHash('sha256').update(bindingToken).digest('hex'),
      version: 2,
      bindingExpiresAt: new Date(now + 7_200_000).toISOString(),
    },
    session: {
      userId: 'owner-A',
      authSessionId: 'session-A',
      generation: 3,
      authenticatedAt: null,
      expiresAt: new Date(now + 3_600_000).toISOString(),
      linkGuarded: false,
      requiresAccountCutoff: true,
    },
    user: { id: 'owner-A', email: 'stored-A@example.test', name: 'Owner A', image: null },
  };
}
function frame(prepared = false): ProviderOwnedSigninFlow {
  const context = captureProviderBrowserContext(selected());
  return {
    version: 1,
    provider: 'apple',
    actorKind: context.actor.kind,
    actorCredentialHash: context.credentialHash,
    browserBindingHash: context.browserCursor.bindingId,
    browserVersion: context.browserCursor.version,
    browserBindingExpiresAt: context.browserCursor.bindingExpiresAt,
    sourceCredentialProof: { ...context.sourceCredentialProof },
    credentialExpiresAt: context.credentialExpiresAt,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 900_000).toISOString(),
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    flowHash: 'a'.repeat(64),
    nonce: null,
    returnUrl: 'https://www.example.test/settings',
    preparationToken: prepared ? 'D'.repeat(43) : null,
    preparation: prepared
      ? {
          provider: 'apple',
          subject: 'actual-owned-B-subject',
          credentialProof: {
            version: 1,
            userId: 'owner-B',
            authSessionId: 'session-B',
            generation: 4,
            authenticatedAt: null,
            linkGuarded: false,
          },
          credentialExpiresAt: new Date(now + 3_600_000).toISOString(),
          expiresAt: new Date(now + 120_000).toISOString(),
          proposedCanonicalTokenHash: 'b'.repeat(64),
        }
      : null,
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('purpose-separated ordinary owned-provider signin carrier', () => {
  it.each([false, true])(
    'roundtrips %s preparation using actual public JWE without storing either raw credential',
    async (prepared) => {
      const input = frame(prepared);
      const sealed = await sealProviderOwnedSigninFlow(input, secret);
      expect(sealed).not.toContain(input.intentToken);
      const opened = await openProviderOwnedSigninFlow(sealed, input.flowHash, secret);
      expect(opened).toEqual(input);
      expect(Object.isFrozen(opened)).toBe(true);
      expect(Object.isFrozen(opened.sourceCredentialProof)).toBe(true);
      expect(JSON.stringify(opened)).not.toContain('actual-A-source');
      expect(opened.sourceCredentialProof.authenticatedAt).toBeNull();
      expect(opened.sourceCredentialProof.linkGuarded).toBe(false);
      if (prepared) expect(Object.isFrozen(opened.preparation?.credentialProof)).toBe(true);
    },
  );
  it('cannot use a normal NextAuth credential or another flow hash as its carrier', async () => {
    const input = frame();
    const sealed = await sealProviderOwnedSigninFlow(input, secret);
    const ordinaryKey = await encode({
      secret,
      maxAge: 900,
      token: { purpose: 'boardsesh-provider-owned-signin-flow-v1', flow: input },
    });
    await expect(openProviderOwnedSigninFlow(ordinaryKey, input.flowHash, secret)).rejects.toThrow();
    await expect(openProviderOwnedSigninFlow(sealed, 'c'.repeat(64), secret)).rejects.toThrow();
    await expect(openProviderOwnedSigninFlow(sealed, input.flowHash, `${secret}-other`)).rejects.toThrow();
  });
  it('captures nested source and B preparation before the asynchronous codec', async () => {
    const input = frame(true);
    const pending = sealProviderOwnedSigninFlow(input, secret);
    input.sourceCredentialProof.userId = 'forged-source';
    input.preparation!.credentialProof.userId = 'forged-target';
    const opened = await openProviderOwnedSigninFlow(await pending, input.flowHash, secret);
    expect(opened.sourceCredentialProof.userId).toBe('owner-A');
    expect(opened.preparation?.credentialProof.userId).toBe('owner-B');
  });
  it.each([
    'expired-flow',
    'future-issued',
    'too-long',
    'source-expired',
    'binding-expired',
    'mismatched-pair',
    'same-UID',
    'same-SID',
    'expired-preparation',
    'expired-target',
    'wrong-provider',
    'Apple-fresh-age',
    'wrong-kind',
  ] as const)('refuses %s before emission', async (fault) => {
    const input = frame(true);
    if (fault === 'expired-flow') input.expiresAt = new Date(now).toISOString();
    if (fault === 'future-issued') input.issuedAt = new Date(now + 1).toISOString();
    if (fault === 'too-long') input.expiresAt = new Date(now + 900_001).toISOString();
    if (fault === 'source-expired') input.credentialExpiresAt = new Date(now).toISOString();
    if (fault === 'binding-expired') input.browserBindingExpiresAt = new Date(now).toISOString();
    if (fault === 'mismatched-pair') input.preparationToken = null;
    if (fault === 'same-UID') input.preparation!.credentialProof.userId = input.sourceCredentialProof.userId;
    if (fault === 'same-SID')
      input.preparation!.credentialProof.authSessionId = input.sourceCredentialProof.authSessionId;
    if (fault === 'expired-preparation') input.preparation!.expiresAt = new Date(now).toISOString();
    if (fault === 'expired-target') input.preparation!.credentialExpiresAt = new Date(now).toISOString();
    if (fault === 'wrong-provider') input.preparation!.provider = 'google';
    if (fault === 'Apple-fresh-age') {
      input.preparation!.credentialProof.authenticatedAt = new Date(now).toISOString();
      input.preparation!.credentialProof.linkGuarded = true;
    }
    if (fault === 'wrong-kind') input.preparation!.proposedCanonicalTokenHash = null;
    await expect(sealProviderOwnedSigninFlow(input, secret)).rejects.toThrow();
  });
  it('bounds actual codec expiration and never treats envelope creation time as authentication age', async () => {
    const input = frame();
    const sealed = await sealProviderOwnedSigninFlow(input, secret);
    vi.setSystemTime(now + 900_001);
    await expect(openProviderOwnedSigninFlow(sealed, input.flowHash, secret)).rejects.toThrow();
  });
  it('requires exact actual source through the common source comparison without synthetic operation capabilities', () => {
    const input = frame();
    const current = captureProviderBrowserContext(selected());
    expect(() => requireProviderOwnedSigninActor(input, current)).not.toThrow();
    const changed = { ...current, credentialHash: 'f'.repeat(64) };
    expect(() => requireProviderOwnedSigninActor(input, changed)).toThrow();
  });
  it('keeps pending framework cookies separate from both source and operation families', () => {
    const hash = frame().flowHash;
    expect(providerOwnedSigninCookieName(hash)).toBe(`__Host-boardsesh.provider-signin.${hash}`);
    expect(providerOwnedSigninPendingCookieName(hash)).toBe(`__Host-boardsesh.provider-signin-pending.${hash}`);
    expect(providerOwnedSigninNonceHash(null)).toBeNull();
    expect(providerOwnedSigninNonceHash('actual-nonce')).toBe(
      createHash('sha256').update('actual-nonce').digest('hex'),
    );
  });
});
