// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeConsentCookieValue, type ConsentRecord, type ConsentSyncInput } from '@boardsesh/consent';

type GraphqlRequest = { signal: AbortSignal; variables?: { input: ConsentSyncInput } };
type GraphqlResponse = { myAnalyticsConsent: ConsentRecord | null } | { setAnalyticsConsent: ConsentRecord };
type Identity = { userId: string; authSessionId: string };

const fixtures = vi.hoisted(() => ({
  preferences: new Map<string, unknown>(),
  request: vi.fn<(request: GraphqlRequest) => Promise<GraphqlResponse>>(),
  identityReadStarted: vi.fn(),
  identityReadGate: null as Promise<void> | null,
}));

vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: fixtures.request }) }));
vi.mock('../../lib/posthog-client', () => ({
  initializePosthogClient: async () => {},
  applyPosthogConsent: async () => {},
}));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../lib/preference-store', () => ({
  getPreference: async (key: string) => fixtures.preferences.get(key) ?? null,
  setPreference: async (key: string, preference: unknown) => {
    fixtures.preferences.set(key, structuredClone(preference));
  },
  removePreference: async (key: string) => {
    fixtures.preferences.delete(key);
  },
}));

// A compact encrypted token, including the empty encrypted-key segment used by
// direct encryption. Its identity comes from the validated endpoint pair.
const browserJwe =
  'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2Q0JDLUhTNTEyIn0..MDEyMzQ1Njc4OWFiY2RlZg.ZW5jcnlwdGVkLXNlc3Npb24.YXV0aGVudGljYXRpb24tdGFn';
const grant: ConsentRecord = { analytics: 'granted', version: 1, decidedAt: '2026-10-08T12:00:00.123Z', source: 'web' };
const denial: ConsentRecord = { ...grant, analytics: 'denied', decidedAt: '2026-10-08T12:01:00.456Z' };
let cookieIdentity: Identity;
let accountRecord: ConsentRecord | null;
let offline: boolean;

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function loadBrowserConsent() {
  vi.resetModules();
  // Vitest does not apply Metro's platform resolution. Redirect only those
  // imports; the browser credential store, identity reader, and invalidation
  // subscription all remain real and share the same module instances.
  vi.doMock('../../lib/auth-store', async () => import('../../lib/auth-store.web'));
  vi.doMock('../../lib/local-user-id', async () => {
    const browserIdentity = await import('../../lib/local-user-id.web');
    return {
      readLocalUserId: async (token?: string) => {
        const userId = await browserIdentity.readLocalUserId(token);
        fixtures.identityReadStarted();
        await fixtures.identityReadGate;
        return userId;
      },
    };
  });
  vi.doMock('../../lib/consent-storage', async () => import('../../lib/consent-storage.web'));
  const provider = await import('../consent-provider');
  const state = await import('../../lib/consent-state');
  const auth = await import('../../lib/auth-store.web');
  await provider.initializeConsent();
  const coordinator = provider.getConsentCoordinator()!;
  function settleAccount(accountId = cookieIdentity.userId) {
    state.updateConsentState({ authSettled: true, accountId, accountResolved: false });
    coordinator.setAccount(accountId);
  }
  async function signIn() {
    const result = await auth.synchronizeWebSession();
    expect(result.status).toBe('authenticated');
    settleAccount();
  }
  return { provider, state, auth, coordinator, settleAccount, signIn };
}

beforeEach(() => {
  document.cookie = 'boardsesh-consent=; Path=/; Max-Age=0';
  fixtures.preferences.clear();
  fixtures.identityReadStarted.mockClear();
  fixtures.identityReadGate = null;
  cookieIdentity = { userId: 'account-a', authSessionId: 'login-a' };
  accountRecord = null;
  offline = false;
  // Node's BroadcastChannel would leave real cross-test process handles open.
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(requestUrl, location.origin).pathname;
      if (pathname === '/api/auth/session')
        return new Response(
          JSON.stringify({ user: { id: cookieIdentity.userId }, authSessionId: cookieIdentity.authSessionId }),
        );
      if (pathname === '/api/internal/ws-auth')
        return new Response(JSON.stringify({ authenticated: true, token: browserJwe, ...cookieIdentity }));
      throw new Error(`Unexpected authentication URL: ${pathname}`);
    }),
  );
  fixtures.request.mockReset();
  fixtures.request.mockImplementation(async ({ variables }) => {
    if (offline) throw new Error('offline');
    if (!variables) return { myAnalyticsConsent: accountRecord };
    accountRecord = { ...variables.input, decidedAt: new Date().toISOString() };
    return { setAnalyticsConsent: accountRecord };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser consent with real encrypted-session credentials', () => {
  it('resolves the account denial instead of leaving browser consent unresolved', async () => {
    document.cookie = `boardsesh-consent=${serializeConsentCookieValue(grant)}; Path=/`;
    accountRecord = denial;
    const browser = await loadBrowserConsent();
    await browser.signIn();
    expect(await browser.auth.getAuthToken()).toBe(browserJwe);
    expect(browserJwe.split('.')).toHaveLength(5);
    await browser.coordinator.sync();
    expect(fixtures.request).toHaveBeenCalledOnce();
    expect(browser.state.getConsentSnapshot()).toMatchObject({
      accountResolved: true,
      record: { analytics: 'denied', ownerAccountId: 'account-a' },
    });
  });

  it('writes Allow, No thanks, and withdrawal under the authenticated browser account', async () => {
    const browser = await loadBrowserConsent();
    await browser.signIn();
    await browser.coordinator.sync();
    for (const choice of ['granted', 'denied', 'granted', 'denied'] as const) {
      await browser.provider.decideAnalyticsConsent(choice, 'web');
      expect(accountRecord?.analytics).toBe(choice);
      expect(browser.state.getConsentSnapshot().record).toMatchObject({
        analytics: choice,
        ownerAccountId: 'account-a',
      });
      expect(browser.coordinator.getSnapshot()).toMatchObject({ pending: false, accountResolved: true });
    }
    expect(fixtures.request.mock.calls.filter(([request]) => request.variables)).toHaveLength(4);
    expect(fixtures.preferences.has('analyticsConsentPending:account-a')).toBe(false);
  });

  it('persists an offline withdrawal and sends it after a browser restart', async () => {
    accountRecord = grant;
    const browser = await loadBrowserConsent();
    await browser.signIn();
    await browser.coordinator.sync();
    offline = true;
    await browser.provider.decideAnalyticsConsent('denied', 'web');
    expect(browser.coordinator.getSnapshot()).toMatchObject({ pending: true, record: { analytics: 'denied' } });
    expect(fixtures.preferences.get('analyticsConsentPending:account-a')).toMatchObject({
      record: { analytics: 'denied' },
    });
    expect(browser.state.isProductAnalyticsGranted()).toBe(false);
    offline = false;
    fixtures.request.mockClear();
    const restarted = await loadBrowserConsent();
    await restarted.signIn();
    await restarted.coordinator.sync();
    expect(fixtures.request).toHaveBeenCalledOnce();
    expect(fixtures.request.mock.calls[0][0].variables?.input).toMatchObject({
      analytics: 'denied',
      basedOnDecidedAt: null,
    });
    expect(accountRecord?.analytics).toBe('denied');
    expect(restarted.coordinator.getSnapshot()).toMatchObject({ pending: false, accountResolved: true });
    expect(fixtures.preferences.has('analyticsConsentPending:account-a')).toBe(false);
  });

  it('does not send with retained identity after credential clearing or a mismatched owner', async () => {
    const browser = await loadBrowserConsent();
    await browser.signIn();
    await browser.auth.clearTokens();
    expect(browser.auth.captureConfirmedWebAuthIdentity()).toEqual(cookieIdentity);
    browser.settleAccount();
    await browser.coordinator.sync();
    expect(fixtures.request).not.toHaveBeenCalled();
    expect(fixtures.identityReadStarted).not.toHaveBeenCalled();
    expect(browser.coordinator.getSnapshot().accountResolved).toBe(false);
    await browser.signIn();
    browser.settleAccount('account-b');
    await browser.coordinator.sync();
    expect(fixtures.request).not.toHaveBeenCalled();
    expect(browser.coordinator.getSnapshot().accountResolved).toBe(false);
  });

  it('does not send if credentials change while the real browser identity read is pending', async () => {
    const browser = await loadBrowserConsent();
    await browser.signIn();
    const identityRead = deferred<void>();
    fixtures.identityReadGate = identityRead.promise;
    const synchronization = browser.coordinator.sync();
    await vi.waitFor(() => expect(fixtures.identityReadStarted).toHaveBeenCalledOnce());
    await browser.auth.clearTokens();
    expect(browser.state.getConsentSnapshot()).toMatchObject({ authSettled: false, accountId: null });
    identityRead.resolve();
    await synchronization;
    expect(fixtures.request).not.toHaveBeenCalled();
  });

  it.each([
    { userId: 'account-b', authSessionId: 'login-b' },
    { userId: 'account-a', authSessionId: 'new-login-a' },
  ])('aborts and discards a late response after switching to $userId / $authSessionId', async (nextIdentity) => {
    const browser = await loadBrowserConsent();
    await browser.signIn();
    const oldResponse = deferred<GraphqlResponse>();
    // Deliberately ignores AbortSignal to prove late-response rejection as well
    // as cancellation. A transport may resolve after its signal is aborted.
    fixtures.request.mockImplementationOnce(() => oldResponse.promise);
    const oldSynchronization = browser.coordinator.sync();
    await vi.waitFor(() => expect(fixtures.request).toHaveBeenCalledOnce());
    const oldSignal = fixtures.request.mock.calls[0][0].signal;
    cookieIdentity = nextIdentity;
    const replacement = await browser.auth.synchronizeWebSession();
    expect(replacement.status).toBe('authenticated');
    expect(oldSignal.aborted).toBe(true);
    expect(browser.state.getConsentSnapshot()).toMatchObject({ authSettled: false, accountId: null });
    browser.settleAccount();
    accountRecord = grant;
    await browser.coordinator.sync();
    oldResponse.resolve({ myAnalyticsConsent: denial });
    await oldSynchronization;
    expect(browser.coordinator.getAccountId()).toBe(nextIdentity.userId);
    expect(browser.state.getConsentSnapshot()).toMatchObject({
      accountResolved: true,
      record: { analytics: 'granted', ownerAccountId: nextIdentity.userId },
    });
  });
});
