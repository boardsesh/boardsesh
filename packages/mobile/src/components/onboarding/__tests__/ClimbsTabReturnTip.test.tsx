// @vitest-environment jsdom
//
// #5654: on iOS 26 Liquid Glass iPhones the Climbs tab is the tab bar's lone
// search-role magnifier, and newcomers who leave Climbs can miss the way back.
// A new account gets one tip, the first time another tab is open. This pins
// who sees it, when, and that it never comes back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { ONBOARDING_TIP_ACCESSORY_KEY, ONBOARDING_TIP_CLIMBS_TAB_KEY } from '@boardsesh/key-value-storage';

type Children = { children?: ReactNode };

const NOW_MS = Date.parse('2026-09-21T12:00:00Z');
const HOUR_MS = 3_600_000;

const env = vi.hoisted(() => ({
  nativeTabBar: true,
  isAuthenticated: true,
  createdAt: '' as string | undefined,
  segments: ['(tabs)', 'climbs'] as string[],
  hasCurrentClimb: false,
  seenKeys: new Set<string>(),
}));
const trackMock = vi.hoisted(() => vi.fn());
const markTipSeenMock = vi.hoisted(() => vi.fn());
const hasSeenTipMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', { 'data-testid': 'tip-overlay' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-router', () => ({ useSegments: () => env.segments }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../OnboardingTipBanner', () => ({
  OnboardingTipBanner: ({ text, onDismiss, icon }: { text: string; onDismiss: () => void; icon: string }) =>
    createElement('div', { 'data-icon': icon }, [
      createElement('span', { key: 'text' }, text),
      createElement('button', { key: 'close', type: 'button', onClick: onDismiss }, 'close'),
    ]),
}));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenTip: hasSeenTipMock,
  markTipSeen: markTipSeenMock,
}));
vi.mock('../../../lib/clock', () => ({ nowMs: () => NOW_MS }));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: env.createdAt === undefined ? undefined : { createdAt: env.createdAt } }),
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: env.isAuthenticated }) }));
vi.mock('../../../hooks/use-bottom-accessory', () => ({ useNativeTabBar: () => env.nativeTabBar }));
vi.mock('../../../hooks/use-sticky-accessory-presence', () => ({
  useStickyAccessoryPresence: () => env.hasCurrentClimb,
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ floatingControlBottom: 90 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12 } }));

const { ClimbsTabReturnTip } = await import('../ClimbsTabReturnTip');

const TIP_TEXT = 'mobile.onboarding.tips.climbsTab';

beforeEach(() => {
  vi.clearAllMocks();
  env.nativeTabBar = true;
  env.isAuthenticated = true;
  env.createdAt = new Date(NOW_MS - 2 * HOUR_MS).toISOString();
  env.segments = ['(tabs)', 'climbs'];
  env.hasCurrentClimb = false;
  env.seenKeys = new Set();
  hasSeenTipMock.mockImplementation(async (key: string) => env.seenKeys.has(key));
  markTipSeenMock.mockImplementation(async (key: string) => {
    env.seenKeys.add(key);
  });
});

afterEach(() => {
  cleanup();
});

/** Renders on Climbs, then moves to `tab`, the way a newcomer leaves it. */
function renderThenOpen(tab: string) {
  const view = render(createElement(ClimbsTabReturnTip));
  env.segments = ['(tabs)', tab];
  view.rerender(createElement(ClimbsTabReturnTip));
  return view;
}

/** Lets the tip's storage reads settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ClimbsTabReturnTip', () => {
  it('stays hidden on Climbs itself', async () => {
    render(createElement(ClimbsTabReturnTip));
    await settle();
    expect(screen.queryByText(TIP_TEXT)).toBeNull();
    expect(hasSeenTipMock).not.toHaveBeenCalled();
  });

  it('points a new account back to the magnifier the first time another tab is open', async () => {
    renderThenOpen('profile');

    await waitFor(() => expect(screen.getByText(TIP_TEXT)).toBeTruthy());
    expect(document.querySelector('[data-icon="search"]')).not.toBeNull();
    expect(trackMock).toHaveBeenCalledWith('Climbs Tab Tip Shown', { fromTab: 'profile' });
  });

  // Written the moment it shows, so a force-quit with the tip up cannot bring
  // it back on the next launch.
  it('marks itself seen as soon as it shows', async () => {
    renderThenOpen('home');
    await waitFor(() => expect(screen.getByText(TIP_TEXT)).toBeTruthy());
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_CLIMBS_TAB_KEY);
  });

  it('never shows twice', async () => {
    env.seenKeys.add(ONBOARDING_TIP_CLIMBS_TAB_KEY);
    renderThenOpen('home');
    await settle();

    expect(screen.queryByText(TIP_TEXT)).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('stays up across other tabs and goes once they tap back to Climbs', async () => {
    const view = renderThenOpen('home');
    await waitFor(() => expect(screen.getByText(TIP_TEXT)).toBeTruthy());

    env.segments = ['(tabs)', 'discover'];
    view.rerender(createElement(ClimbsTabReturnTip));
    expect(screen.getByText(TIP_TEXT)).toBeTruthy();

    env.segments = ['(tabs)', 'climbs'];
    view.rerender(createElement(ClimbsTabReturnTip));
    expect(screen.queryByText(TIP_TEXT)).toBeNull();

    env.segments = ['(tabs)', 'home'];
    view.rerender(createElement(ClimbsTabReturnTip));
    await settle();
    expect(screen.queryByText(TIP_TEXT)).toBeNull();
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('goes away for good when dismissed', async () => {
    const view = renderThenOpen('record');
    await waitFor(() => expect(screen.getByText(TIP_TEXT)).toBeTruthy());

    fireEvent.click(screen.getByText('close'));
    expect(screen.queryByText(TIP_TEXT)).toBeNull();

    env.segments = ['(tabs)', 'home'];
    view.rerender(createElement(ClimbsTabReturnTip));
    await settle();
    expect(screen.queryByText(TIP_TEXT)).toBeNull();
  });

  it('hides under a root modal and comes back with the tabs', async () => {
    const view = renderThenOpen('home');
    await waitFor(() => expect(screen.getByText(TIP_TEXT)).toBeTruthy());

    env.segments = ['boards'];
    view.rerender(createElement(ClimbsTabReturnTip));
    expect(screen.queryByText(TIP_TEXT)).toBeNull();

    env.segments = ['(tabs)', 'home'];
    view.rerender(createElement(ClimbsTabReturnTip));
    expect(screen.getByText(TIP_TEXT)).toBeTruthy();
  });

  // Android, iPhones before iOS 26, iPads and the Material variant all get the
  // JS tab bar, where Climbs is a labelled tab like the others.
  it('never shows without the iOS 26 native tab bar', async () => {
    env.nativeTabBar = false;
    renderThenOpen('home');
    await settle();

    expect(screen.queryByText(TIP_TEXT)).toBeNull();
    expect(hasSeenTipMock).not.toHaveBeenCalled();
  });

  it('never shows to an account older than seven days', async () => {
    env.createdAt = new Date(NOW_MS - 8 * 24 * HOUR_MS).toISOString();
    renderThenOpen('home');
    await settle();

    expect(screen.queryByText(TIP_TEXT)).toBeNull();
  });

  it('waits for the profile, and for sign-in', async () => {
    env.createdAt = undefined;
    renderThenOpen('home');
    await settle();
    expect(screen.queryByText(TIP_TEXT)).toBeNull();

    cleanup();
    env.createdAt = new Date(NOW_MS - HOUR_MS).toISOString();
    env.isAuthenticated = false;
    env.segments = ['(tabs)', 'climbs'];
    renderThenOpen('home');
    await settle();
    expect(screen.queryByText(TIP_TEXT)).toBeNull();
  });

  // Both tips float just above the tab bar; the accessory tip goes first.
  it('waits behind the accessory tip, then shows on the next tab change', async () => {
    env.hasCurrentClimb = true;
    const view = renderThenOpen('home');
    await settle();
    expect(screen.queryByText(TIP_TEXT)).toBeNull();
    expect(markTipSeenMock).not.toHaveBeenCalled();

    env.seenKeys.add(ONBOARDING_TIP_ACCESSORY_KEY);
    env.segments = ['(tabs)', 'discover'];
    view.rerender(createElement(ClimbsTabReturnTip));

    await waitFor(() => expect(screen.getByText(TIP_TEXT)).toBeTruthy());
    expect(trackMock).toHaveBeenCalledWith('Climbs Tab Tip Shown', { fromTab: 'discover' });
  });
});
