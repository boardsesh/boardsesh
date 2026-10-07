// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MobileStoreRelease } from '@boardsesh/shared-schema/mobile-store-release';
import { useStoreUpdateNudge } from '../use-store-update-nudge';
import { DAY_MS } from '../nudge-policy';

const controls = vi.hoisted(() => ({
  focused: true,
  active: true,
  launchReady: true,
  sessionId: null as string | null,
  platform: 'ios',
  nativeVersion: '2.6.0' as string | null,
  productionBuild: true,
  preferences: new Map<string, unknown>(),
}));
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  openURL: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return controls.platform;
    },
  },
  Linking: { openURL: mocks.openURL },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => controls.focused }));
vi.mock('../../app-visibility', () => ({ useIsAppActive: () => controls.active }));
vi.mock('../../../providers/launch-ready-context', () => ({ useLaunchReady: () => controls.launchReady }));
vi.mock('../../../providers/queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: controls.sessionId }) }));
vi.mock('../../onboarding/connect-step-build', () => ({
  readConnectStepBuild: () => ({ nativeVersion: controls.nativeVersion, productionBuild: controls.productionBuild }),
}));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../preference-store', () => ({ getPreference: mocks.getPreference, setPreference: mocks.setPreference }));

const NOW = Date.parse('2026-10-06T00:00:00.000Z');
const ACK_KEY = 'storeUpdateAcknowledgmentV1';
const REMINDERS_OFF_KEY = 'storeUpdateRemindersOffV1';
let nowMs = NOW;
let client: QueryClient;
function serverRelease(): MobileStoreRelease {
  return {
    latestVersion: '2.7.0',
    firstNewerMinorAvailableAt: new Date(NOW - 14 * DAY_MS).toISOString(),
    checkedAt: new Date(nowMs).toISOString(),
    storeUrl: 'https://apps.apple.com/app/boardsesh/id6761350784',
  };
}
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}
function mount(enabled = true) {
  return renderHook(({ allow }) => useStoreUpdateNudge(allow), { initialProps: { allow: enabled }, wrapper });
}

beforeEach(() => {
  nowMs = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  vi.stubGlobal('__DEV__', true);
  vi.stubEnv('EXPO_PUBLIC_STORE_UPDATE_QA_STAGE', '');
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '');
  Object.assign(controls, {
    focused: true,
    active: true,
    launchReady: true,
    sessionId: null,
    platform: 'ios',
    nativeVersion: '2.6.0',
    productionBuild: true,
  });
  controls.preferences.clear();
  vi.clearAllMocks();
  mocks.request.mockReset().mockImplementation(async () => ({ mobileStoreRelease: serverRelease() }));
  mocks.getPreference.mockReset().mockImplementation(async (key: string) => controls.preferences.get(key) ?? null);
  mocks.setPreference.mockReset().mockImplementation(async (key: string, stored: unknown) => {
    controls.preferences.set(key, stored);
  });
  mocks.openURL.mockReset().mockResolvedValue(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('store update hook lifecycle', () => {
  it.each(['focused', 'active', 'launchReady'] as const)('waits until %s becomes true', async (gate) => {
    controls[gate] = false;
    const hook = mount();
    expect(hook.result.current.stage).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
    controls[gate] = true;
    hook.rerender({ allow: true });
    await waitFor(() => expect(hook.result.current.stage).toBe('weekly'));
    controls[gate] = false;
    hook.rerender({ allow: true });
    expect(hook.result.current.stage).toBeNull();
  });

  it('waits for onboarding priority and suppresses both solo and shared sessions', async () => {
    const hook = mount(false);
    expect(mocks.request).not.toHaveBeenCalled();
    hook.rerender({ allow: true });
    await waitFor(() => expect(hook.result.current.stage).toBe('weekly'));
    for (const sessionId of ['solo:test', 'shared-session']) {
      controls.sessionId = sessionId;
      hook.rerender({ allow: true });
      expect(hook.result.current.stage).toBeNull();
    }
  });

  it.each(['preview', 'web', 'screenshot', 'unknown-native'] as const)('suppresses %s runs', async (run) => {
    if (run === 'preview') controls.productionBuild = false;
    if (run === 'web') controls.platform = 'web';
    if (run === 'screenshot') vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    if (run === 'unknown-native') controls.nativeVersion = null;
    const hook = mount();
    await act(async () => {});
    expect(hook.result.current.stage).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('fails closed on preference reads and failed persistence', async () => {
    mocks.getPreference.mockRejectedValueOnce(new Error('storage locked'));
    const failedRead = mount();
    await waitFor(() => expect(mocks.getPreference).toHaveBeenCalled());
    await act(async () => {});
    expect(failedRead.result.current.stage).toBeNull();
    failedRead.unmount();
    const failedWrite = mount();
    await waitFor(() => expect(failedWrite.result.current.stage).toBe('weekly'));
    mocks.setPreference.mockRejectedValueOnce(new Error('storage full'));
    await act(async () => {
      failedWrite.result.current.acknowledge();
    });
    expect(failedWrite.result.current.stage).toBeNull();
  });

  it('keeps the card until acknowledgment, persists dismissal across remounts, and returns after cooldown on focus', async () => {
    const first = mount();
    await waitFor(() => expect(first.result.current.stage).toBe('weekly'));
    expect(mocks.setPreference).not.toHaveBeenCalled();
    await act(async () => {
      first.result.current.acknowledge();
    });
    expect(first.result.current.stage).toBeNull();
    expect(controls.preferences.get(ACK_KEY)).toEqual({ nativeVersion: '2.6.0', lastAcknowledgedAtMs: NOW });
    first.unmount();
    const remounted = mount();
    await act(async () => {});
    expect(remounted.result.current.stage).toBeNull();
    controls.focused = false;
    remounted.rerender({ allow: true });
    nowMs = NOW + 7 * DAY_MS;
    controls.focused = true;
    remounted.rerender({ allow: true });
    await waitFor(() => expect(remounted.result.current.stage).toBe('weekly'));
  });

  it('turns reminders off for good, across cooldowns and native updates', async () => {
    const first = mount();
    await waitFor(() => expect(first.result.current.stage).toBe('weekly'));
    await act(async () => {
      first.result.current.turnOffReminders();
    });
    expect(first.result.current.stage).toBeNull();
    expect(controls.preferences.get(REMINDERS_OFF_KEY)).toBe(true);
    first.unmount();
    mocks.request.mockClear();
    nowMs = NOW + 90 * DAY_MS;
    controls.nativeVersion = '2.5.0';
    const later = mount();
    await act(async () => {});
    expect(later.result.current.stage).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('fails closed when turning reminders off cannot persist', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.stage).toBe('weekly'));
    mocks.setPreference.mockRejectedValueOnce(new Error('storage full'));
    await act(async () => {
      hook.result.current.turnOffReminders();
    });
    expect(hook.result.current.stage).toBeNull();
  });

  it('retries failed store opening without acknowledgment, then acknowledges a successful opening', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.stage).toBe('weekly'));
    mocks.openURL.mockRejectedValueOnce(new Error('store unavailable'));
    await act(async () => {
      await hook.result.current.openStore();
    });
    expect(hook.result.current.openFailed).toBe(true);
    expect(hook.result.current.stage).toBe('weekly');
    expect(mocks.setPreference).not.toHaveBeenCalled();
    await act(async () => {
      await hook.result.current.openStore();
    });
    expect(hook.result.current.openFailed).toBe(false);
    expect(hook.result.current.stage).toBeNull();
    expect(mocks.openURL).toHaveBeenCalledWith(serverRelease().storeUrl);
    expect(mocks.setPreference).toHaveBeenCalledTimes(1);
  });

  it('clears cached eligibility when a successful refetch has no qualifying release', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.stage).toBe('weekly'));
    mocks.request.mockResolvedValueOnce({ mobileStoreRelease: null });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['mobileStoreRelease'] });
    });
    await waitFor(() => expect(hook.result.current.release).toBeNull());
    expect(hook.result.current.stage).toBeNull();
  });

  it('clears cached advice after a failed optional lookup', async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.stage).toBe('weekly'));
    mocks.request.mockRejectedValueOnce(new Error('older backend'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['mobileStoreRelease'] });
    });
    await waitFor(() => expect(hook.result.current.release).toBeNull());
  });

  it('recovers from a failed preference read on the next foreground transition', async () => {
    mocks.getPreference.mockRejectedValueOnce(new Error('storage locked'));
    const hook = mount();
    await act(async () => {});
    expect(hook.result.current.stage).toBeNull();
    controls.active = false;
    hook.rerender({ allow: true });
    controls.active = true;
    hook.rerender({ allow: true });
    await waitFor(() => expect(hook.result.current.stage).toBe('weekly'));
    expect(mocks.getPreference.mock.calls.filter(([key]) => key === ACK_KEY)).toHaveLength(2);
  });

  it('ignores forced QA metadata in a production bundle', async () => {
    vi.stubGlobal('__DEV__', false);
    vi.stubEnv('EXPO_PUBLIC_STORE_UPDATE_QA_STAGE', 'daily');
    const hook = mount();
    await waitFor(() => expect(hook.result.current.stage).toBe('weekly'));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.getPreference).toHaveBeenCalledWith(ACK_KEY);
  });

  it('resets cooldown when the actual installed native version changes', async () => {
    controls.preferences.set(ACK_KEY, { nativeVersion: '2.6.0', lastAcknowledgedAtMs: NOW });
    const hook = mount();
    await act(async () => {});
    expect(hook.result.current.stage).toBeNull();
    controls.nativeVersion = '2.6.1';
    hook.rerender({ allow: true });
    await waitFor(() => expect(hook.result.current.stage).toBe('weekly'));
    expect(mocks.request).toHaveBeenLastCalledWith(expect.any(String), { platform: 'ios', nativeVersion: '2.6.1' });
  });

  it('isolates forced QA acknowledgment and disables real requests, including current', async () => {
    controls.productionBuild = false;
    vi.stubEnv('EXPO_PUBLIC_STORE_UPDATE_QA_STAGE', 'daily');
    const hook = mount();
    await waitFor(() => expect(hook.result.current.stage).toBe('daily'));
    await act(async () => {
      hook.result.current.acknowledge();
    });
    expect(controls.preferences.has(`${ACK_KEY}:qa:daily`)).toBe(true);
    expect(controls.preferences.has(ACK_KEY)).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();
    vi.stubEnv('EXPO_PUBLIC_STORE_UPDATE_QA_STAGE', 'current');
    hook.rerender({ allow: true });
    expect(hook.result.current.release).toBeNull();
    expect(hook.result.current.stage).toBeNull();
  });
});
