// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => ({ released: false }));
const navigation = vi.hoisted(() => ({ replace: vi.fn(), dismiss: vi.fn(), canDismiss: vi.fn(() => false) }));
const decisions = vi.hoisted(() => ({ decide: vi.fn() }));
const preventRemoval = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (colors: unknown) => colors,
  StyleSheet: { create: (styles: unknown) => styles },
  Linking: { openURL: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('expo-router', () => ({
  useRouter: () => navigation,
  useNavigation: () => navigation,
  usePreventRemove: preventRemoval,
  Stack: { Screen: () => null },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../providers/consent-provider', () => ({ decideAnalyticsConsent: decisions.decide }));
vi.mock('../components/Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled: boolean }) =>
    createElement('button', { disabled, onClick: onPress }, title),
}));
vi.mock('../components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('span', null, 'spinner'),
}));
vi.mock('../components/onboarding/use-block-back', () => ({ useBlockBack: vi.fn() }));
vi.mock('../lib/launch-hold', () => ({ useLaunchHoldReleased: () => launch.released }));
vi.mock('../lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../lib/posthog-client', () => ({ applyPosthogConsent: async () => {} }));

import PrivacyConsentScreen from '../../app/privacy-consent';
import { getConsentSnapshot, updateConsentState } from '../lib/consent-state';

afterEach(cleanup);

it('holds a direct launch, waits for local consent, then leaves immediately after the local decision', () => {
  updateConsentState({ record: null, loaded: false, settled: false, killed: false });
  navigation.replace.mockImplementation(() => expect(getConsentSnapshot().settled).toBe(true));
  decisions.decide.mockImplementation((choice: 'granted' | 'denied', source: 'ios') => {
    updateConsentState({
      record: { analytics: choice, source, version: 1, decidedAt: new Date().toISOString() },
      settled: true,
    });
    // A server synchronization that never finishes cannot hold the route open.
    return new Promise<void>(() => {});
  });
  const view = render(createElement(PrivacyConsentScreen));
  expect(screen.getByText('spinner')).toBeTruthy();
  expect(preventRemoval).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).toBeNull();

  launch.released = true;
  view.rerender(createElement(PrivacyConsentScreen));
  expect(preventRemoval).toHaveBeenLastCalledWith(true, expect.any(Function));
  expect((screen.getByRole('button', { name: 'allow' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'deny' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'deny' }));
  expect(decisions.decide).not.toHaveBeenCalled();
  expect(navigation.replace).not.toHaveBeenCalled();

  act(() => updateConsentState({ loaded: true }));
  expect((screen.getByRole('button', { name: 'deny' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'deny' }));
  expect(decisions.decide).toHaveBeenCalledWith('denied', 'ios');
  expect(navigation.replace).toHaveBeenCalledWith('/');
  expect(getConsentSnapshot().settled).toBe(true);
  expect(preventRemoval).toHaveBeenLastCalledWith(false, expect.any(Function));
});

it.each([false, true])('replays blocked navigation after synchronous consent settles (canDismiss=%s)', (canDismiss) => {
  launch.released = true;
  updateConsentState({ record: null, loaded: true, settled: false, killed: false });
  navigation.canDismiss.mockReturnValue(canDismiss);
  const repeat = vi.fn();
  const view = render(createElement(PrivacyConsentScreen));
  // Capture the currently installed guard before React can observe the choice.
  const guard = preventRemoval.mock.lastCall?.[1] as (event: { repeat: () => void }) => void;
  guard({ repeat });
  expect(repeat).not.toHaveBeenCalled();

  decisions.decide.mockImplementation((analytics: 'granted' | 'denied') => {
    updateConsentState({
      record: { analytics, source: 'ios', version: 1, decidedAt: new Date().toISOString() },
      settled: true,
    });
    return new Promise<void>(() => {});
  });
  const leave = canDismiss ? navigation.dismiss : navigation.replace;
  leave.mockImplementation(() => guard({ repeat }));
  fireEvent.click(screen.getByRole('button', { name: 'deny' }));
  expect(repeat).toHaveBeenCalledOnce();
  expect(preventRemoval).toHaveBeenLastCalledWith(false, expect.any(Function));
  view.unmount();
  navigation.canDismiss.mockReturnValue(false);
});
