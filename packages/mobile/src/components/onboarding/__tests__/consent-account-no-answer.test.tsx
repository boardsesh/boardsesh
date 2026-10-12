// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET_MY_ANALYTICS_CONSENT, SET_ANALYTICS_CONSENT } from '@boardsesh/graphql/operations/analytics-consent';

/** A signed-in launch with no answer, using the real provider and coordinator. */

const network = vi.hoisted(() => ({
  request: vi.fn(),
  accountReads: 0,
  writes: 0,
}));
const router = vi.hoisted(() => ({ push: vi.fn(), dismiss: vi.fn(), navigate: vi.fn() }));
const store = vi.hoisted(() => ({ values: new Map<string, unknown>() }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('expo-router', () => ({ useRouter: () => router, useSegments: () => ['(tabs)', 'climbs'] }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true, isLoading: false }) }));
vi.mock('../../../providers/party-profile-provider', () => ({
  usePartyProfile: () => ({ authenticatedUserId: 'account-a' }),
}));
vi.mock('../../../providers/launch-ready-context', () => ({ useLaunchReady: () => true }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlagsResolved: () => true,
  useFeatureFlag: () => false,
}));
vi.mock('../../../lib/consent-auth-invalidation', () => ({}));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 0,
  isAuthCredentialGenerationCurrent: () => true,
  getAuthToken: async () => `header.${btoa(JSON.stringify({ sub: 'account-a' }))}.signature`,
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: network.request }) }));
vi.mock('../../../lib/posthog-client', () => ({
  initializePosthogClient: async () => {},
  applyPosthogConsent: async () => {},
  setPosthogFlagIdentity: () => {},
  subscribePosthogInitialized: () => () => {},
}));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../../lib/preference-store', () => ({
  getPreference: async (key: string) => (store.values.has(key) ? structuredClone(store.values.get(key)) : null),
  setPreference: async (key: string, payload: unknown) => {
    store.values.set(key, structuredClone(payload));
  },
  removePreference: async (key: string) => {
    store.values.delete(key);
  },
}));

/** Fresh modules per test: the coordinator and consent state are per launch. */
async function launchApp() {
  const { ConsentProvider } = await import('../../../providers/consent-provider');
  const { ConsentGate } = await import('../ConsentGate');
  const consentState = await import('../../../lib/consent-state');
  render(createElement(ConsentProvider, null, createElement(ConsentGate)));
  return consentState;
}

beforeEach(() => {
  vi.resetModules();
  store.values.clear();
  router.push.mockReset();
  network.accountReads = 0;
  network.writes = 0;
  network.request.mockReset().mockImplementation(async ({ document }: { document: string }) => {
    if (document === GET_MY_ANALYTICS_CONSENT) {
      network.accountReads += 1;
      // A read loop would never yield to the test. Past 20 reads, stop answering,
      // which ends the loop, so the count below reports it.
      if (network.accountReads > 20) return new Promise<never>(() => {});
      return { myAnalyticsConsent: null };
    }
    if (document === SET_ANALYTICS_CONSENT) network.writes += 1;
    throw new Error('unexpected operation');
  });
});

afterEach(() => {
  cleanup();
});

async function letLoopsShow() {
  for (let turn = 0; turn < 20; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

it('signed in with no answer: the prompt opens and account reads stop', async () => {
  const { getConsentSnapshot, isConsentAuthorityGranted } = await launchApp();

  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/privacy-consent'));
  const readsWhenPrompted = network.accountReads;
  await letLoopsShow();
  expect(network.accountReads).toBe(readsWhenPrompted);
  expect(network.accountReads).toBeLessThanOrEqual(2);
  expect(network.writes).toBe(0);
  expect(getConsentSnapshot().record).toBeNull();
  expect(isConsentAuthorityGranted()).toBe(false);
});
