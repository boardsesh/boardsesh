// @vitest-environment node
import { createHash } from 'node:crypto';
import type { NextAuthOptions } from 'next-auth';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createProviderSecurityOAuthFlowReader } from '../provider-security-flow-reader.server';
import { normalizeProviderSecurityAppleCallback } from '../provider-security-apple-transport.server';
import { captureProviderBrowserContext } from '../provider-security-selection.server';
import {
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  type ProviderSecurityFlow,
} from '../provider-security-flow.server';
import { providerSecurityResumeUrl } from '../provider-security-resume';
import { webOAuthFlowHash } from '../web-oauth-continuation.server';
import type { AdmittedBrowserSelection, PresentedBrowserSelection } from '../presented-browser-selection.server';

const origin = 'https://www.provider-flow-reader.example.test';
const secret = 'owned-provider-flow-reader-sealing-secret';
const scope = 'c'.repeat(32);
const state = 'actual-signed-nextauth-state';
const environment = {
  NEXTAUTH_URL: origin,
  NEXTAUTH_SECRET: secret,
  CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
};
const base: NextAuthOptions = {
  providers: [],
  secret,
  cookies: {
    state: { name: '__Secure-next-auth.state', options: { secure: true, httpOnly: true, sameSite: 'none' } },
    callbackUrl: {
      name: '__Secure-next-auth.callback-url',
      options: { secure: true, httpOnly: true, sameSite: 'none' },
    },
  },
};
function selected(): AdmittedBrowserSelection {
  const bindingToken = 'A'.repeat(43);
  return {
    status: 'admitted',
    bindingToken,
    actor: { version: 2, credential: { kind: 'canonical-token', token: 'actual-owned-opaque-source' } },
    cursor: {
      bindingId: createHash('sha256').update(bindingToken).digest('hex'),
      version: 2,
      bindingExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    },
    session: {
      userId: 'actual-owner',
      authSessionId: 'actual-stable-session',
      generation: 3,
      authenticatedAt: new Date(Math.floor(Date.now() / 1000) * 1000 - 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    user: { id: 'actual-owner', email: 'owned@example.test', name: 'Stored owner', image: null },
  };
}
function frame(current: AdmittedBrowserSelection): ProviderSecurityFlow {
  const captured = captureProviderBrowserContext(current);
  const issuedAt = new Date();
  return {
    version: 1,
    action: 'link',
    provider: 'apple',
    methodId: null,
    actorKind: captured.actor.kind,
    actorCredentialHash: captured.credentialHash,
    browserBindingHash: captured.browserCursor.bindingId,
    browserVersion: captured.browserCursor.version,
    browserBindingExpiresAt: captured.browserCursor.bindingExpiresAt,
    sourceCredentialProof: captured.sourceCredentialProof,
    credentialExpiresAt: captured.credentialExpiresAt,
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    recoveryToken: 'D'.repeat(43),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 900_000).toISOString(),
    reauthenticationToken: 'E'.repeat(43),
    reauthenticationExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    providerFlowHash: null,
    googleFlowHash: null,
    googleNonce: null,
  };
}
type Purpose = 'link' | 'reauthenticate-google';
async function fixture(
  phase: 'signin' | 'callback',
  purpose: Purpose = 'link',
  options: {
    readonly callbackUrl?: string;
    readonly additionalCookie?: string;
    readonly stateProvider?: string;
    readonly noCarrier?: boolean;
  } = {},
) {
  const current = selected();
  const flow = frame(current);
  const provider = purpose === 'link' ? 'apple' : 'google';
  if (purpose === 'reauthenticate-google') {
    flow.reauthenticationToken = null;
    flow.reauthenticationExpiresAt = null;
  }
  if (phase === 'callback') {
    if (purpose === 'link') flow.providerFlowHash = webOAuthFlowHash(provider, state);
    else {
      flow.googleFlowHash = webOAuthFlowHash(provider, state);
      flow.googleNonce = 'actualnonce';
    }
  }
  const key = providerSecurityOperationKey(flow.intentToken);
  const returnUrl = providerSecurityResumeUrl(origin, key, 'fr');
  const cookieParts = ['__Host-boardsesh.browser-binding=' + current.bindingToken];
  if (!options.noCarrier)
    cookieParts.push(`${providerSecurityFlowCookieName(key, true)}=${await sealProviderSecurityFlow(flow, secret)}`);
  if (options.additionalCookie) cookieParts.push(options.additionalCookie);
  if (phase === 'callback') {
    const stateCookie = await encode({
      secret,
      salt: `__Secure-next-auth.state.${scope}`,
      maxAge: 900,
      token: { provider: options.stateProvider ?? provider, value: state },
    });
    cookieParts.push(
      `__Secure-next-auth.state.${scope}=${stateCookie}`,
      `__Secure-next-auth.callback-url.${scope}=${encodeURIComponent(options.callbackUrl ?? returnUrl)}`,
    );
  }
  const form = new URLSearchParams({
    csrfToken: 'actual-framework-will-verify',
    callbackUrl: returnUrl,
    providerSecurityOperation: purpose,
    providerSecurityOperationKey: key,
  });
  const request = new NextRequest(
    `http://0.0.0.0:3000/api/auth/${phase}/${provider}${phase === 'callback' ? `?state=${state}&code=owned-code` : ''}`,
    {
      method: phase === 'signin' ? 'POST' : 'GET',
      headers: {
        Host: new URL(origin).host,
        Cookie: cookieParts.join('; '),
        ...(phase === 'signin' ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(phase === 'signin' ? { body: form } : {}),
    },
  );
  const readSelection = vi.fn(async (_header: string | null): Promise<PresentedBrowserSelection> => current);
  const reader = createProviderSecurityOAuthFlowReader({ environment, ready: () => true, readSelection });
  return { current, flow, key, returnUrl, request, form, reader, readSelection, route: { action: phase, provider } };
}
beforeEach(() => {
  vi.stubEnv('NEXTAUTH_URL', origin);
  vi.stubEnv('NEXTAUTH_SECRET', secret);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('actual signed-flow locator with separate primary source admission', () => {
  for (const phase of ['signin', 'callback'] as const)
    for (const purpose of ['link', 'reauthenticate-google'] as const) {
      it(`${phase}/${purpose}: selects only its actual sealed operation and current primary actor`, async () => {
        const current = await fixture(phase, purpose);
        const result = await current.reader.read(current.request, base, current.route);
        expect(result).toMatchObject({ status: 'explicit', purpose, flow: current.flow, returnUrl: current.returnUrl });
        expect(current.readSelection).toHaveBeenCalledWith(current.request.headers.get('cookie'));
        if (result.status !== 'explicit') throw new Error('Expected private explicit frame');
        expect(Object.isFrozen(result)).toBe(true);
        expect(result.actor.sourceCredentialProof.authenticatedAt).toBe(
          current.flow.sourceCredentialProof.authenticatedAt,
        );
      });
    }
  it('refuses a public selector without its actual encrypted operation carrier', async () => {
    const current = await fixture('signin', 'link', { noCarrier: true });
    expect(await current.reader.read(current.request, base, current.route)).toEqual({
      status: 'refused',
      reason: 'invalid_request',
    });
    expect(current.readSelection).not.toHaveBeenCalled();
  });
  it.each([
    'https://foreign.example.test/settings?providerSecurityResume=' + 'a'.repeat(64),
    `${origin}/settings?providerSecurityResume=${'a'.repeat(64)}&claimedReady=true`,
    `${origin}/settings`,
  ])('does not let a callback return locator retarget or erase a bound explicit flow %s', async (callbackUrl) => {
    const current = await fixture('callback', 'link', { callbackUrl });
    expect(await current.reader.read(current.request, base, current.route)).toEqual({
      status: 'refused',
      reason: 'invalid_request',
    });
    expect(current.readSelection).not.toHaveBeenCalled();
  });
  it('never treats a signed Google state as the Apple operation state', async () => {
    const current = await fixture('callback', 'link', { stateProvider: 'google' });
    expect(await current.reader.read(current.request, base, current.route)).toEqual({
      status: 'refused',
      reason: 'unavailable',
    });
    expect(current.readSelection).not.toHaveBeenCalled();
  });
  it('ignores an unrelated expired-evidence carrier without weakening its strict opener', async () => {
    const oldClock = new Date(Date.now() - 360_000);
    const old = frame(selected());
    old.intentToken = 'Z'.repeat(43);
    old.issuedAt = oldClock.toISOString();
    old.expiresAt = new Date(oldClock.getTime() + 900_000).toISOString();
    old.reauthenticationExpiresAt = new Date(Date.now() - 60_000).toISOString();
    const oldKey = providerSecurityOperationKey(old.intentToken);
    const additionalCookie = `${providerSecurityFlowCookieName(oldKey, true)}=${await sealProviderSecurityFlow(old, secret, oldClock)}`;
    const current = await fixture('callback', 'link', { additionalCookie });
    expect(await current.reader.read(current.request, base, current.route)).toMatchObject({
      status: 'explicit',
      flow: current.flow,
    });
  });
  it('returns only ordinary-UNQUALIFIED when no explicit frame matches; it grants no legacy fallback', async () => {
    const current = await fixture('callback', 'link', { callbackUrl: `${origin}/settings`, noCarrier: true });
    expect(await current.reader.read(current.request, base, current.route)).toEqual({ status: 'ordinary-unqualified' });
    expect(current.readSelection).not.toHaveBeenCalled();
  });
  it('resumes held Apple transport only after the exact operation and current actor return on same-WWW GET', async () => {
    const current = await fixture('callback', 'link');
    const noneCookies = (current.request.headers.get('cookie') ?? '')
      .split('; ')
      .filter((pair) => pair.startsWith('__Secure-next-auth.'))
      .join('; ');
    const incoming = new NextRequest(`http://0.0.0.0:3000/api/auth/callback/apple`, {
      method: 'POST',
      headers: { Host: new URL(origin).host, Cookie: noneCookies, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state, code: 'owned-apple-code' }),
    });
    const held = await normalizeProviderSecurityAppleCallback(
      incoming,
      { params: Promise.resolve({ nextauth: ['callback', 'apple'] }) },
      { ...base, providers: [{ id: 'apple', name: 'Apple', type: 'oauth', profile: () => ({ id: 'unused' }) }] },
      { environment, ready: () => true },
    );
    if (!held || held.status !== 303) throw new Error('Expected actual authenticated Apple transport hold');
    const continuation = held.headers
      .getSetCookie()
      .map((header) => header.split(';', 1)[0])
      .join('; ');
    const withoutLax = new NextRequest(held.headers.get('Location')!, {
      headers: { Host: new URL(origin).host, Cookie: `${noneCookies}; ${continuation}` },
    });
    expect(await current.reader.read(withoutLax, base, current.route)).toEqual({
      status: 'refused',
      reason: 'invalid_request',
    });
    expect(current.readSelection).not.toHaveBeenCalled();
    const restored = new NextRequest(held.headers.get('Location')!, {
      headers: { Host: new URL(origin).host, Cookie: `${current.request.headers.get('cookie')}; ${continuation}` },
    });
    expect(await current.reader.read(restored, base, current.route)).toMatchObject({
      status: 'explicit',
      purpose: 'link',
      flow: current.flow,
    });
    current.readSelection.mockResolvedValue({ status: 'missing-binding' });
    expect(await current.reader.read(restored, base, current.route)).toEqual({
      status: 'refused',
      reason: 'identity_changed',
    });
  });
  it('refuses two independently sealed operations for the same actual state instead of choosing the first', async () => {
    const current = await fixture('callback');
    const other = { ...current.flow, intentToken: 'Y'.repeat(43) };
    const key = providerSecurityOperationKey(other.intentToken);
    current.request.headers.set(
      'Cookie',
      `${current.request.headers.get('cookie')}; ${providerSecurityFlowCookieName(key, true)}=${await sealProviderSecurityFlow(other, secret)}`,
    );
    expect(await current.reader.read(current.request, base, current.route)).toEqual({
      status: 'refused',
      reason: 'invalid_request',
    });
    expect(current.readSelection).not.toHaveBeenCalled();
  });
  it.each(['missing-binding', 'proof-required', 'denied', 'conflict', 'anonymous', 'unavailable'] as const)(
    'does not turn primary %s into an explicit actor',
    async (status) => {
      const current = await fixture('signin');
      current.readSelection.mockResolvedValue(
        status === 'anonymous' ? { status, cursor: current.current.cursor } : { status },
      );
      expect(await current.reader.read(current.request, base, current.route)).toEqual({
        status: 'refused',
        reason: status === 'unavailable' ? 'unavailable' : 'identity_changed',
      });
    },
  );
  it.each(['UID', 'SID', 'generation', 'credential', 'version'] as const)(
    'refuses a changed current %s even when the public selector is unchanged',
    async (kind) => {
      const current = await fixture('signin');
      const after = {
        ...current.current,
        session: { ...current.current.session },
        user: { ...current.current.user },
        actor: { ...current.current.actor },
        cursor: { ...current.current.cursor },
      };
      if (kind === 'UID') {
        after.session.userId = 'new-owner';
        after.user.id = 'new-owner';
      }
      if (kind === 'SID') after.session.authSessionId = 'new-session';
      if (kind === 'generation') after.session.generation += 1;
      if (kind === 'credential') after.actor.credential = { kind: 'canonical-token', token: 'different-actual-source' };
      if (kind === 'version') {
        after.actor.version += 1;
        after.cursor.version += 1;
      }
      current.readSelection.mockResolvedValue(after);
      expect(await current.reader.read(current.request, base, current.route)).toEqual({
        status: 'refused',
        reason: 'identity_changed',
      });
    },
  );
  it('captures the actual cookie header before body and primary awaits', async () => {
    const current = await fixture('signin');
    const original = current.request.headers.get('cookie');
    const pending = current.reader.read(current.request, base, current.route);
    current.request.headers.set('cookie', 'claimed-operation=forged');
    expect(await pending).toMatchObject({ status: 'explicit', flow: current.flow });
    expect(current.readSelection).toHaveBeenCalledWith(original);
  });
  it('requires the default code-owned readiness floor before any primary read', async () => {
    const current = await fixture('signin');
    current.request.headers.set('x-provider-ready', 'true');
    const reader = createProviderSecurityOAuthFlowReader({ environment, readSelection: current.readSelection });
    expect(await reader.read(current.request, base, current.route)).toEqual({
      status: 'refused',
      reason: 'unavailable',
    });
    expect(current.readSelection).not.toHaveBeenCalled();
  });
});
