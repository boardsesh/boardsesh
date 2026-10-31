// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

// The real gates (lib/support-asks.ts) over the real settings store, on an
// in-memory MMKV. Only the inputs a phone supplies are stubbed: the store-rule
// answer, the calendar day, the session and the Bluetooth link.
const mockStorage = vi.hoisted(() => new Map<string, string>());
const state = vi.hoisted(() => ({
  linksAllowed: true,
  today: new Date(2027, 2, 3),
  sessionId: null as string | null,
  boardConnected: false,
  platform: 'ios',
}));
const analytics = vi.hoisted(() => ({ trackSupportLinkTapped: vi.fn() }));
const browser = vi.hoisted(() => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));

vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => mockStorage.set(key, value),
    remove: (key: string) => mockStorage.delete(key),
    clearAll: () => mockStorage.clear(),
  }),
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
  },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
}));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) =>
    createElement('button', { onClick: onPress, 'data-testid': testID }, title),
}));
vi.mock('../../ChromeIconButton', () => ({
  ChromeIconButton: ({
    onPress,
    testID,
    accessibilityLabel,
  }: {
    onPress: () => void;
    testID?: string;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, 'data-testid': testID, 'aria-label': accessibilityLabel }),
}));
vi.mock('../../../hooks/use-today', () => ({ useToday: () => state.today }));
// The real supportUrlFor; only the store-rule answer is stubbed.
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('../../../providers/feature-flags-provider', () => ({ useFeatureFlag: () => undefined }));
vi.mock('../../../lib/graphql/hooks/use-is-admin', () => ({
  useIsAdmin: () => ({ isAdmin: false, isLoading: false }),
}));
vi.mock('../../../lib/donation-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/donation-links')>()),
  useDonationLinksAllowed: () => state.linksAllowed,
}));
vi.mock('../../../lib/analytics-support-link', () => analytics);
vi.mock('../../../lib/open-url', () => browser);
vi.mock('../../../lib/ble/bluetooth-status-store', () => ({
  useBluetoothConnectedStatus: () => state.boardConnected,
}));
vi.mock('../../../providers/queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: state.sessionId }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: [0, 4, 8, 12, 16, 20, 24] }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));

import { HomeSupportCard } from '../HomeSupportCard';
import { getSetting, resetAllSettings, setSetting } from '../../../settings/hooks';

function renderCard() {
  return render(<HomeSupportCard />);
}

beforeEach(() => {
  mockStorage.clear();
  resetAllSettings();
  state.linksAllowed = true;
  state.today = new Date(2027, 2, 3);
  state.sessionId = null;
  state.boardConnected = false;
  state.platform = 'ios';
  analytics.trackSupportLinkTapped.mockClear();
  browser.openExternalUrl.mockClear();
});

describe('HomeSupportCard', () => {
  it.each([1, 7])('shows on day %i of the month with both ways to give', (day) => {
    state.today = new Date(2027, 2, day);
    renderCard();

    expect(screen.getByTestId('home-support-card')).toBeTruthy();
    expect(screen.getByText('mobile.supportAsks.giveMonthly')).toBeTruthy();
    expect(screen.getByText('mobile.supportAsks.giveOnce')).toBeTruthy();
  });

  it.each([8, 31])('renders nothing on day %i of the month', (day) => {
    state.today = new Date(2027, 2, day);
    renderCard();

    expect(screen.queryByTestId('home-support-card')).toBeNull();
  });

  it('renders nothing where store rules turn links down (Android, non-US iPhones, screenshot mode)', () => {
    state.linksAllowed = false;
    renderCard();

    expect(screen.queryByTestId('home-support-card')).toBeNull();
  });

  it('renders nothing in the browser app, where only the Account row asks', () => {
    state.platform = 'web';
    renderCard();

    expect(screen.queryByTestId('home-support-card')).toBeNull();
  });

  it('renders nothing with Show support asks off', () => {
    setSetting('supportAsksShown', false);
    renderCard();

    expect(screen.queryByTestId('home-support-card')).toBeNull();
  });

  it('renders nothing during a session', () => {
    state.sessionId = 'session-1';
    renderCard();

    expect(screen.queryByTestId('home-support-card')).toBeNull();
  });

  it('renders nothing with a board connected', () => {
    state.boardConnected = true;
    renderCard();

    expect(screen.queryByTestId('home-support-card')).toBeNull();
  });

  it('shows again on every Home visit until it is closed', () => {
    renderCard().unmount();
    renderCard().unmount();
    state.today = new Date(2027, 2, 5);
    renderCard();

    expect(screen.getByTestId('home-support-card')).toBeTruthy();
    expect(getSetting('supportCardV1')).toBeNull();
  });

  it('Give monthly counts the tap, opens the support page and hides the card for the month', () => {
    const { unmount } = renderCard();

    fireEvent.click(screen.getByTestId('home-support-card-monthly'));

    expect(analytics.trackSupportLinkTapped).toHaveBeenCalledWith('home-card', 'monthly');
    expect(browser.openExternalUrl).toHaveBeenCalledWith(
      'https://www.boardsesh.com/support?src=app-home-card&cadence=monthly',
      'home-support-card',
    );
    expect(screen.queryByTestId('home-support-card')).toBeNull();
    expect(getSetting('supportCardV1')).toEqual({ closedMonth: '2027-03' });

    unmount();
    state.today = new Date(2027, 2, 6);
    renderCard();
    expect(screen.queryByTestId('home-support-card')).toBeNull();
  });

  it('Give once opens the same page, starting on a one-off gift, and hides the card for the month', () => {
    renderCard();

    fireEvent.click(screen.getByTestId('home-support-card-once'));

    expect(analytics.trackSupportLinkTapped).toHaveBeenCalledWith('home-card', 'once');
    expect(browser.openExternalUrl).toHaveBeenCalledWith(
      'https://www.boardsesh.com/support?src=app-home-card&cadence=once',
      'home-support-card',
    );
    expect(screen.queryByTestId('home-support-card')).toBeNull();
    expect(getSetting('supportCardV1')).toEqual({ closedMonth: '2027-03' });
  });

  it('the close hides the card for the month without opening anything', () => {
    const { unmount } = renderCard();

    fireEvent.click(screen.getByTestId('home-support-card-close'));

    expect(screen.queryByTestId('home-support-card')).toBeNull();
    expect(browser.openExternalUrl).not.toHaveBeenCalled();
    expect(analytics.trackSupportLinkTapped).not.toHaveBeenCalled();
    expect(getSetting('supportCardV1')).toEqual({ closedMonth: '2027-03' });

    unmount();
    renderCard();
    expect(screen.queryByTestId('home-support-card')).toBeNull();
  });

  it('comes back on the 1st of the next month after a close', () => {
    setSetting('supportCardV1', { closedMonth: '2027-02' });
    state.today = new Date(2027, 2, 1);
    renderCard();

    expect(screen.getByTestId('home-support-card')).toBeTruthy();
  });

  it('hides when a board connects while Home is open, and comes back once it disconnects', () => {
    const { rerender } = renderCard();
    expect(screen.getByTestId('home-support-card')).toBeTruthy();

    state.boardConnected = true;
    act(() => rerender(<HomeSupportCard />));
    expect(screen.queryByTestId('home-support-card')).toBeNull();

    state.boardConnected = false;
    act(() => rerender(<HomeSupportCard />));
    expect(screen.getByTestId('home-support-card')).toBeTruthy();
  });
});
