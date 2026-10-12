// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import {
  createConsentRegionLookup,
  createRegionDefaultConsent,
  type ConsentRecord,
  type ConsentSource,
} from '@boardsesh/consent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getConsentSnapshot,
  isConsentAuthorityGranted,
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
// promptRequired from the backend: true (e.g. DE), false (e.g. US), null (unknown or failed).
const region = vi.hoisted(() => ({
  lookup: vi.fn<() => Promise<boolean | null>>(),
  // True when a completed answer can be refreshed on foreground resume.
  expire: vi.fn<() => boolean>(),
  isCurrent: vi.fn<(answer: Promise<boolean | null>) => boolean>(),
  globalPrivacyControl: false,
}));
const regionDefault = vi.hoisted(() => ({
  apply: vi.fn<(source: ConsentSource) => void>(),
  clear: vi.fn<() => void>(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
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
    // Stand-ins for the real provider: the coordinator publishes the record,
    // and the provider mirrors it into the consent state.
    applyRegionDefaultConsent: (source: ConsentSource) => {
      regionDefault.apply(source);
      consent.updateConsentState({ record: createRegionDefaultConsent(source) });
    },
    clearRegionDefaultConsent: () => {
      regionDefault.clear();
      consent.updateConsentState({ record: null });
    },
    useConsentSettled: () =>
      useSyncExternalStore(consent.subscribeConsent, consent.getConsentSnapshot, consent.getConsentSnapshot).settled,
  };
});
vi.mock('../../../lib/consent-storage', () => ({ readLocalConsent: localConsent.read }));
vi.mock('../../../lib/consent-region', () => ({
  lookUpConsentRegion: region.lookup,
  expireConsentRegionLookup: region.expire,
  isConsentRegionLookupCurrent: region.isCurrent,
  isGlobalPrivacyControlEnabled: () => region.globalPrivacyControl,
}));
vi.mock('../../../lib/posthog-client', () => ({
  setPosthogFlagIdentity: posthog.setFlagIdentity,
  subscribePosthogInitialized: posthog.subscribeInitialized,
}));

import { ConsentGate, resetRegionDefaultGuard } from '../ConsentGate';

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
  region.lookup.mockReset().mockResolvedValue(true);
  region.expire.mockReset().mockReturnValue(false);
  region.isCurrent.mockReset().mockReturnValue(true);
  region.globalPrivacyControl = false;
  resetRegionDefaultGuard();
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
    regionConfirmed: false,
  });
  consumeConsentDestination();
});

afterEach(() => {
  // Restore real timers and env first, so a failed assertion below (or in the
  // test) cannot leave the fake clock from the five-second tests running.
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanup();
  consumeConsentDestination();
  expect(appState.listeners.size).toBe(0);
});

async function flushEffects() {
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('ConsentGate', () => {
  it('reloads guest flags once auth settles even when the selected identity stays null', async () => {
    auth.isLoading = true;
    const view = render(<ConsentGate />);
    await flushEffects();
    expect(getConsentSnapshot().authSettled).toBe(false);
    expect(posthog.setFlagIdentity).toHaveBeenCalledWith(null);
    posthog.setFlagIdentity.mockClear();

    auth.isLoading = false;
    view.rerender(<ConsentGate />);
    await flushEffects();
    expect(getConsentSnapshot().authSettled).toBe(true);
    expect(posthog.setFlagIdentity).toHaveBeenCalledExactlyOnceWith(null);

    view.rerender(<ConsentGate />);
    await flushEffects();
    expect(posthog.setFlagIdentity).toHaveBeenCalledTimes(1);
  });

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

  it.each([
    ['signed out', null],
    ['under another account', 'account-b'],
  ])('waits for the account read before trusting an answer given %s, then asks again', async (_description, owner) => {
    auth.isAuthenticated = true;
    profile.authenticatedUserId = 'account-a';
    coordinator.snapshot = { accountResolved: false, syncing: true };
    let finishRead!: () => void;
    const accountRead = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    coordinator.sync.mockReturnValue(accountRead);
    updateConsentState({ record: { ...granted, ownerAccountId: owner } });
    render(<ConsentGate />);
    await flushEffects();

    expect(getConsentSnapshot().settled).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(isProductAnalyticsGranted()).toBe(false);

    // The account has no answer of its own: the coordinator clears the device answer.
    await act(async () => {
      updateConsentState({ record: null, accountResolved: true });
      finishRead();
    });
    expect(router.push).toHaveBeenCalledWith('/privacy-consent');
    expect(getConsentSnapshot().settled).toBe(false);
    expect(isProductAnalyticsGranted()).toBe(false);
  });

  it('settles at once on an answer this account gave, before the account read returns', async () => {
    auth.isAuthenticated = true;
    profile.authenticatedUserId = 'account-a';
    coordinator.snapshot = { accountResolved: false, syncing: true };
    coordinator.sync.mockImplementation(() => new Promise<void>(() => {}));
    updateConsentState({ record: { ...granted, ownerAccountId: 'account-a' } });
    render(<ConsentGate />);
    await flushEffects();

    expect(getConsentSnapshot().settled).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
    expect(isProductAnalyticsGranted()).toBe(false);
  });

  it('waits on an answer with no owner while the profile id is still loading', async () => {
    auth.isAuthenticated = true;
    profile.authenticatedUserId = null;
    coordinator.snapshot = { accountResolved: false, syncing: true };
    updateConsentState({ record: granted });
    const view = render(<ConsentGate />);
    await flushEffects();
    expect(getConsentSnapshot().settled).toBe(false);
    expect(router.push).not.toHaveBeenCalled();

    // The id arrives and the account read finds no answer of its own: ask.
    profile.authenticatedUserId = 'account-a';
    coordinator.snapshot = { accountResolved: true, syncing: false };
    coordinator.sync.mockResolvedValue(undefined);
    await act(async () => {
      updateConsentState({ record: null, accountResolved: true });
      view.rerender(<ConsentGate />);
    });
    expect(router.push).toHaveBeenCalledWith('/privacy-consent');
  });

  it('settles at once on an answer bound to an account while the profile id is still loading', async () => {
    auth.isAuthenticated = true;
    profile.authenticatedUserId = null;
    coordinator.snapshot = { accountResolved: false, syncing: true };
    updateConsentState({ record: { ...granted, ownerAccountId: 'account-a' } });
    render(<ConsentGate />);
    await flushEffects();
    expect(getConsentSnapshot().settled).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
    expect(isProductAnalyticsGranted()).toBe(false);
  });

  it('settles on a signed-out answer after five seconds offline without asking or tracking', async () => {
    vi.useFakeTimers();
    auth.isAuthenticated = true;
    profile.authenticatedUserId = 'account-a';
    coordinator.snapshot = { accountResolved: false, syncing: true };
    coordinator.sync.mockImplementation(() => new Promise<void>(() => {}));
    updateConsentState({ record: granted });
    render(<ConsentGate />);
    await flushEffects();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(getConsentSnapshot().settled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getConsentSnapshot().settled).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
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

describe('ConsentGate regions', () => {
  it('asks a launch in a prompt region such as Germany', async () => {
    region.lookup.mockResolvedValue(true);
    render(<ConsentGate />);
    await flushEffects();

    expect(router.push).toHaveBeenCalledExactlyOnceWith('/privacy-consent');
    expect(regionDefault.apply).not.toHaveBeenCalled();
    expect(getConsentSnapshot().settled).toBe(false);
  });

  it('skips the prompt outside the prompt regions and writes the region default', async () => {
    region.lookup.mockResolvedValue(false);
    render(<ConsentGate />);
    await flushEffects();

    expect(router.push).not.toHaveBeenCalled();
    expect(regionDefault.apply).toHaveBeenCalledExactlyOnceWith('ios');
    expect(getConsentSnapshot().record).toMatchObject({ analytics: 'granted', basis: 'region_default' });
    expect(getConsentSnapshot().settled).toBe(true);
  });

  it('asks when the region lookup fails or runs out of time', async () => {
    region.lookup.mockResolvedValue(null);
    render(<ConsentGate />);
    await flushEffects();

    expect(router.push).toHaveBeenCalledExactlyOnceWith('/privacy-consent');
    expect(regionDefault.apply).not.toHaveBeenCalled();
    expect(isProductAnalyticsGranted()).toBe(false);
  });

  it('waits on a slow region lookup instead of guessing', async () => {
    let answer!: (promptRequired: boolean | null) => void;
    region.lookup.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    render(<ConsentGate />);
    await flushEffects();
    expect(router.push).not.toHaveBeenCalled();
    expect(regionDefault.apply).not.toHaveBeenCalled();

    await act(async () => {
      answer(null);
    });
    await flushEffects();
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/privacy-consent');
  });

  it('lets an account denial win over the region default', async () => {
    region.lookup.mockResolvedValue(false);
    auth.isAuthenticated = true;
    profile.authenticatedUserId = 'account-a';
    coordinator.snapshot = { accountResolved: false, syncing: true };
    coordinator.sync.mockImplementation(async () => {
      updateConsentState({ record: { ...granted, analytics: 'denied' }, accountResolved: true });
    });
    render(<ConsentGate />);
    await flushEffects();

    expect(regionDefault.apply).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(getConsentSnapshot().record?.analytics).toBe('denied');
    expect(getConsentSnapshot().settled).toBe(true);
  });

  it('leaves an account answer alone in any region', async () => {
    region.lookup.mockResolvedValue(true);
    updateConsentState({ record: granted });
    render(<ConsentGate />);
    await flushEffects();

    expect(regionDefault.clear).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(getConsentSnapshot().record).toEqual(granted);
  });

  it('drops a region default and asks once this launch is in a prompt region', async () => {
    region.lookup.mockResolvedValue(true);
    updateConsentState({ record: createRegionDefaultConsent('ios') });
    render(<ConsentGate />);
    await flushEffects();

    expect(regionDefault.clear).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/privacy-consent');
  });

  it('keeps a region default when an offline launch cannot tell the region, but sends nothing', async () => {
    region.lookup.mockResolvedValue(null);
    updateConsentState({ record: createRegionDefaultConsent('android') });
    render(<ConsentGate />);
    await flushEffects();

    expect(regionDefault.clear).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(getConsentSnapshot().settled).toBe(true);
    expect(getConsentSnapshot().regionConfirmed).toBe(false);
    expect(isConsentAuthorityGranted()).toBe(false);
  });

  it('sends nothing on a stored region default until this launch confirms the region', async () => {
    let answer!: (promptRequired: boolean | null) => void;
    region.lookup.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    updateConsentState({ record: createRegionDefaultConsent('ios') });
    render(<ConsentGate />);
    await flushEffects();

    // Settled (no prompt, deep links proceed), but the default is not "on" yet.
    expect(getConsentSnapshot().settled).toBe(true);
    expect(isConsentAuthorityGranted()).toBe(false);
    expect(isProductAnalyticsGranted()).toBe(false);

    await act(async () => {
      answer(false);
    });
    await flushEffects();
    expect(getConsentSnapshot().regionConfirmed).toBe(true);
    expect(isConsentAuthorityGranted()).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('confirms a region default it just applied, so a fresh install outside Europe tracks', async () => {
    region.lookup.mockResolvedValue(false);
    render(<ConsentGate />);
    await flushEffects();

    expect(regionDefault.apply).toHaveBeenCalledOnce();
    expect(isConsentAuthorityGranted()).toBe(true);
  });

  it('re-checks a fresh region answer on resume, holding capture before asking in a prompt region', async () => {
    region.lookup.mockResolvedValue(false);
    updateConsentState({ record: createRegionDefaultConsent('ios') });
    render(<ConsentGate />);
    await flushEffects();
    expect(region.lookup).toHaveBeenCalledTimes(1);
    expect(isConsentAuthorityGranted()).toBe(true);

    // The next foreground resume is already in Germany: hold capture until it answers.
    let answer!: (promptRequired: boolean | null) => void;
    region.lookup.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    region.expire.mockReturnValue(true);
    await act(async () => {
      for (const listener of [...appState.listeners]) listener('active');
    });
    await flushEffects();
    expect(region.lookup).toHaveBeenCalledTimes(2);
    expect(isConsentAuthorityGranted()).toBe(false);

    await act(async () => {
      answer(true);
    });
    await flushEffects();
    expect(regionDefault.clear).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/privacy-consent');
    expect(isConsentAuthorityGranted()).toBe(false);
  });

  it.each([
    ['stored default', true, false],
    ['no answer', false, false],
    ['settled default answer before its UI callback', true, true],
    ['settled first answer before its UI callback', false, true],
  ])(
    'holds %s through resume until the fresh location arrives',
    async (_scenario, storedDefault, settleBeforeResume) => {
      let oldAnswer!: (promptRequired: boolean | null) => void;
      let freshAnswer!: (promptRequired: boolean | null) => void;
      const request = vi
        .fn<() => Promise<boolean | null>>()
        .mockReturnValueOnce(
          new Promise((resolve) => {
            oldAnswer = resolve;
          }),
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            freshAnswer = resolve;
          }),
        );
      const lookup = createConsentRegionLookup(request);
      region.lookup.mockImplementation(lookup.lookUp);
      region.expire.mockImplementation(lookup.expire);
      region.isCurrent.mockImplementation(lookup.isCurrent);
      if (storedDefault) updateConsentState({ record: createRegionDefaultConsent('ios') });
      render(<ConsentGate />);
      await flushEffects();
      expect(request).toHaveBeenCalledOnce();

      await act(async () => {
        if (settleBeforeResume) {
          oldAnswer(false);
          // The cache settles before either gate callback consumes the answer.
          await Promise.resolve();
        }
        for (const listener of appState.listeners) listener('active');
        for (const listener of appState.listeners) listener('active');
      });
      expect(isConsentAuthorityGranted()).toBe(false);
      if (!settleBeforeResume)
        await act(async () => {
          oldAnswer(false);
        });
      await flushEffects();
      expect(request).toHaveBeenCalledTimes(2);
      expect(getConsentSnapshot().regionConfirmed).toBe(false);
      expect(isConsentAuthorityGranted()).toBe(false);
      expect(regionDefault.clear).not.toHaveBeenCalled();
      expect(regionDefault.apply).not.toHaveBeenCalled();

      await act(async () => {
        freshAnswer(true);
      });
      await flushEffects();
      expect(regionDefault.clear).toHaveBeenCalledTimes(storedDefault ? 1 : 0);
      expect(router.push).toHaveBeenCalledExactlyOnceWith('/privacy-consent');
      expect(isConsentAuthorityGranted()).toBe(false);
    },
  );

  it('applies the region default once per launch even when an account read drops it', async () => {
    region.lookup.mockResolvedValue(false);
    auth.isAuthenticated = true;
    profile.authenticatedUserId = 'account-a';
    render(<ConsentGate />);
    await flushEffects();
    expect(regionDefault.apply).toHaveBeenCalledOnce();

    // Something (an older merge rule) clears the default after the account read.
    await act(async () => {
      updateConsentState({ record: null, accountResolved: true });
    });
    await flushEffects();
    expect(regionDefault.apply).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    expect(getConsentSnapshot().settled).toBe(true);
    expect(isConsentAuthorityGranted()).toBe(false);
  });

  it('holds tracking on a default applied at the five-second cap until the account read, then lets a denial win', async () => {
    vi.useFakeTimers();
    region.lookup.mockResolvedValue(false);
    auth.isAuthenticated = true;
    profile.authenticatedUserId = 'account-a';
    coordinator.snapshot = { accountResolved: false, syncing: true };
    let finishRead!: () => void;
    coordinator.sync.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRead = resolve;
      }),
    );
    render(<ConsentGate />);
    await flushEffects();
    expect(regionDefault.apply).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(regionDefault.apply).toHaveBeenCalledOnce();
    expect(getConsentSnapshot().regionConfirmed).toBe(true);
    expect(getConsentSnapshot().accountResolved).toBe(false);
    expect(isConsentAuthorityGranted()).toBe(false);

    await act(async () => {
      updateConsentState({
        record: { ...granted, analytics: 'denied', ownerAccountId: 'account-a' },
        accountResolved: true,
      });
      finishRead();
    });
    await flushEffects();
    expect(getConsentSnapshot().record?.analytics).toBe('denied');
    expect(isConsentAuthorityGranted()).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('treats Global Privacy Control as a no on the browser app: no default, no prompt', async () => {
    region.lookup.mockResolvedValue(false);
    region.globalPrivacyControl = true;
    render(<ConsentGate />);
    await flushEffects();

    expect(regionDefault.apply).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(getConsentSnapshot().settled).toBe(true);
    expect(isConsentAuthorityGranted()).toBe(false);
  });

  it('drops a stored region default under Global Privacy Control', async () => {
    region.lookup.mockResolvedValue(false);
    region.globalPrivacyControl = true;
    updateConsentState({ record: createRegionDefaultConsent('web') });
    render(<ConsentGate />);
    await flushEffects();

    expect(regionDefault.clear).toHaveBeenCalledOnce();
    expect(regionDefault.apply).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('never looks up the region in screenshot mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    render(<ConsentGate />);
    await flushEffects();

    expect(region.lookup).not.toHaveBeenCalled();
    expect(regionDefault.apply).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
});
