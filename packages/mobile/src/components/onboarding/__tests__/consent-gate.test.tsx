// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import type { ConsentRecord } from '@boardsesh/consent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getConsentSnapshot,
  isProductAnalyticsGranted,
  setBrowserConsentReader,
  updateConsentState,
} from '../../../lib/consent-state';
import { consumeConsentDestination, deferConsentDestination } from '../../../lib/consent-navigation';

const auth = vi.hoisted(() => ({ isAuthenticated: false, isLoading: false }));
const profile = vi.hoisted(() => ({ authenticatedUserId: null as string | null }));
const launch = vi.hoisted(() => ({ ready: true }));
const flags = vi.hoisted(() => ({ resolved: true, killed: false }));
const route = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as string[] }));
const router = vi.hoisted(() => ({ push: vi.fn(), dismiss: vi.fn(), navigate: vi.fn() }));
const localConsent = vi.hoisted(() => ({ read: vi.fn<() => Promise<ConsentRecord | null>>() }));
const coordinator = vi.hoisted(() => ({
  snapshot: { accountResolved: true, syncing: false },
  setAccount: vi.fn<(accountId: string | null) => void>(),
  replaceLocalRecord: vi.fn<(record: ConsentRecord | null) => void>(),
  sync: vi.fn<() => Promise<void>>(),
  getSnapshot() {
    return coordinator.snapshot;
  },
}));
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
const posthog = vi.hoisted(() => ({ setFlagIdentity: vi.fn(), subscribeInitialized: vi.fn(() => () => {}) }));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));
vi.mock('expo-router', () => ({ useRouter: () => router, useSegments: () => route.segments }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('../../../providers/party-profile-provider', () => ({ usePartyProfile: () => profile }));
vi.mock('../../../providers/launch-ready-context', () => ({ useLaunchReady: () => launch.ready }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlagsResolved: () => flags.resolved,
  useFeatureFlag: (key: string) => key === 'privacy-consent-step-kill' && flags.killed,
}));
vi.mock('../../../providers/consent-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  const consent = await import('../../../lib/consent-state');
  return {
    getConsentCoordinator: () => coordinator,
    useConsentSettled: () =>
      useSyncExternalStore(consent.subscribeConsent, consent.getConsentSnapshot, consent.getConsentSnapshot).settled,
  };
});
vi.mock('../../../lib/consent-storage', () => ({ readLocalConsent: localConsent.read }));
vi.mock('../../../lib/posthog-client', () => ({
  setPosthogFlagIdentity: posthog.setFlagIdentity,
  subscribePosthogInitialized: posthog.subscribeInitialized,
}));

import { ConsentGate } from '../ConsentGate';

const granted: ConsentRecord = {
  analytics: 'granted',
  version: 1,
  decidedAt: '2026-10-08T12:00:00.123Z',
  source: 'ios',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
  auth.isAuthenticated = false;
  auth.isLoading = false;
  profile.authenticatedUserId = null;
  launch.ready = true;
  flags.resolved = true;
  flags.killed = false;
  route.segments = ['(tabs)', 'climbs'];
  coordinator.snapshot = { accountResolved: true, syncing: false };
  coordinator.sync.mockReset().mockResolvedValue(undefined);
  localConsent.read.mockReset().mockImplementation(async () => getConsentSnapshot().record);
  setBrowserConsentReader(() => getConsentSnapshot().record);
  updateConsentState({
    record: null,
    loaded: true,
    settled: false,
    killed: false,
    authSettled: false,
    accountResolved: false,
    authEpoch: 0,
    accountId: null,
    sdkReady: false,
    flagsResolved: false,
  });
  consumeConsentDestination();
});

afterEach(() => {
  cleanup();
  consumeConsentDestination();
  expect(appState.listeners.size).toBe(0);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ConsentGate', () => {
  it('opens the privacy choice for a fresh signed-out launch', async () => {
    render(<ConsentGate />);
    await flushEffects();

    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith('/privacy-consent');
    expect(coordinator.setAccount).toHaveBeenCalledWith(null);
    expect(getConsentSnapshot().settled).toBe(false);
    expect(isProductAnalyticsGranted()).toBe(false);
  });

  it('opens the choice after five seconds when signed-in account consent stays unresolved', async () => {
    vi.useFakeTimers();
    auth.isAuthenticated = true;
    profile.authenticatedUserId = 'account-a';
    coordinator.snapshot = { accountResolved: false, syncing: true };
    coordinator.sync.mockImplementation(() => new Promise<void>(() => {}));
    render(<ConsentGate />);
    await flushEffects();

    expect(coordinator.setAccount).toHaveBeenCalledWith('account-a');
    expect(getConsentSnapshot().accountResolved).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(router.push).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith('/privacy-consent');
    expect(isProductAnalyticsGranted()).toBe(false);
  });

  it.each(['granted', 'denied'] as const)(
    'settles a known %s answer without reopening the prompt',
    async (analytics) => {
      updateConsentState({ record: { ...granted, analytics } });
      render(<ConsentGate />);
      await flushEffects();

      expect(getConsentSnapshot().settled).toBe(true);
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it.each([null, granted])('the kill switch skips the prompt and blocks tracking with answer %j', async (record) => {
    flags.killed = true;
    if (record) {
      updateConsentState({
        record,
        settled: true,
        authSettled: true,
        accountResolved: true,
        flagsResolved: true,
        sdkReady: true,
      });
      expect(isProductAnalyticsGranted()).toBe(true);
    }
    render(<ConsentGate />);
    await flushEffects();

    expect(getConsentSnapshot().killed).toBe(true);
    expect(getConsentSnapshot().settled).toBe(true);
    expect(isProductAnalyticsGranted()).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('opens a pending destination once after the answer and privacy route dismissal', async () => {
    expect(deferConsentDestination('com.boardsesh.app://climb/123?board=kilter')).toBe(true);
    const view = render(<ConsentGate />);
    await flushEffects();
    expect(router.navigate).not.toHaveBeenCalled();

    route.segments = ['privacy-consent'];
    view.rerender(<ConsentGate />);
    await act(async () => {
      updateConsentState({ record: { ...granted, analytics: 'denied' }, settled: true });
    });
    expect(router.dismiss).toHaveBeenCalledOnce();
    expect(router.navigate).not.toHaveBeenCalled();

    route.segments = ['(tabs)', 'climbs'];
    view.rerender(<ConsentGate />);
    expect(router.navigate).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith('/climb/123?board=kilter');
    route.segments = ['(tabs)', 'you'];
    view.rerender(<ConsentGate />);
    expect(router.navigate).toHaveBeenCalledOnce();
    expect(consumeConsentDestination()).toBeNull();
  });
});
