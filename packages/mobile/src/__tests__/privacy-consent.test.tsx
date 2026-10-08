// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => ({ released: false }));
const navigation = vi.hoisted(() => ({ replace: vi.fn(), dismiss: vi.fn(), dispatch: vi.fn() }));
const decisions = vi.hoisted(() => ({ decide: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (colors: unknown) => colors,
  StyleSheet: { create: (styles: unknown) => styles },
  Linking: { openURL: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ ...navigation, canDismiss: () => false }),
  useNavigation: () => navigation,
  Stack: { Screen: () => null },
}));
vi.mock('expo-router/react-navigation', () => ({ usePreventRemove: vi.fn() }));
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
  expect(screen.queryByRole('button')).toBeNull();

  launch.released = true;
  view.rerender(createElement(PrivacyConsentScreen));
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
});
