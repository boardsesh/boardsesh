// @vitest-environment jsdom
//
// The connect-step test's Climbs card (#5654, PR 7, treatment only). The copy is
// the en-US catalog itself, so a renamed or missing key fails here instead of
// rendering a raw key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';
import type { FirstConnectDeviceState, ConnectStepEnrolment } from '../../../lib/onboarding/first-connect-decision';

type Children = { children?: ReactNode };

const announceMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const storeMocks = vi.hoisted(() => ({
  recordLaunch: vi.fn(async () => null),
  markNoLights: vi.fn(async () => null),
  dismiss: vi.fn(),
}));
const storeCtrl = vi.hoisted(() => ({
  snapshot: {
    device: null as FirstConnectDeviceState | null,
    userId: 'user-1' as string | null,
    enrolment: null as ConnectStepEnrolment | null,
    cardDismissedThisLaunch: false,
  },
}));
const flagsCtrl = vi.hoisted(() => ({ enabled: true }));
const bluetoothMocks = vi.hoisted(() => ({
  // The hook's own connect (`useLightbulbControl().connect`): it logs Board
  // Connect Tapped, arms the undo toast and relights the remembered board; its
  // own suite covers that. Here it only needs to resolve.
  connect: vi.fn(async () => true),
  onPress: vi.fn(),
  hookOptions: vi.fn(),
}));
const lightbulbCtrl = vi.hoisted(() => ({
  pressAction: 'connect' as string,
  pending: false,
  holderIsAuthoritative: false,
  wallHeldByOtherUser: false,
}));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  AccessibilityInfo: { announceForAccessibility: announceMock },
}));

// Resolves against the real en-US catalog, with {{placeholder}} interpolation.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const found = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          boardsCatalog,
        );
      if (typeof found !== 'string') return key;
      return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '');
    },
  }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children, accessibilityRole }: Children & { accessibilityRole?: string }) =>
    createElement(accessibilityRole === 'header' ? 'h2' : 'span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, loading }: { title: string; onPress: () => void; loading?: boolean }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-loading': String(Boolean(loading)) }, title),
}));
vi.mock('../../ble/use-lightbulb-control', () => ({
  useLightbulbControl: (options: unknown) => {
    bluetoothMocks.hookOptions(options);
    return {
      bluetooth: { wallHeldByOtherUser: lightbulbCtrl.wallHeldByOtherUser },
      pressAction: lightbulbCtrl.pressAction,
      pending: lightbulbCtrl.pending,
      holderIsAuthoritative: lightbulbCtrl.holderIsAuthoritative,
      onPress: bluetoothMocks.onPress,
      connect: bluetoothMocks.connect,
    };
  },
}));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../lib/clock', () => ({ nowMs: () => 42 }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/onboarding/first-connect-store', () => ({
  FIRST_CONNECT_LAUNCH_ID: 'this-launch',
  useFirstConnectSnapshot: () => storeCtrl.snapshot,
  useFirstConnectSelector: <Selected,>(select: (current: typeof storeCtrl.snapshot) => Selected) =>
    select(storeCtrl.snapshot),
  recordFirstConnectCardLaunch: storeMocks.recordLaunch,
  markFirstConnectNoLights: storeMocks.markNoLights,
  dismissFirstConnectCardForLaunch: storeMocks.dismiss,
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFirstConnectCtaEnabled: () => flagsCtrl.enabled,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: { secondaryLabel: '#666', secondaryBackground: '#eee' },
    brandColors: { primary: '#6D28D9' },
    m3SurfaceContainers: { high: '#ddd' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ borderRadius: { lg: 12 }, spacing: { 1: 4, 2: 8, 3: 12 } }));

const { FirstConnectCard, useFirstConnectCardExpected } = await import('../FirstConnectCard');

function freshDevice(overrides: Partial<FirstConnectDeviceState> = {}): FirstConnectDeviceState {
  return {
    connectedAt: null,
    noLightsAt: null,
    confirmationShownAt: null,
    cardLaunchIds: [],
    pillDays: [],
    ...overrides,
  };
}

function renderCard(boardHasLights = true) {
  return render(<FirstConnectCard boardName="Kilter at Blocs" boardHasLights={boardHasLights} />);
}

describe('FirstConnectCard', () => {
  beforeEach(() => {
    storeCtrl.snapshot = {
      device: freshDevice(),
      userId: 'user-1',
      enrolment: { userId: 'user-1', arm: 'treatment', forced: false, exposedAt: 1 },
      cardDismissedThisLaunch: false,
    };
    flagsCtrl.enabled = true;
    lightbulbCtrl.pressAction = 'connect';
    lightbulbCtrl.pending = false;
    lightbulbCtrl.holderIsAuthoritative = false;
    lightbulbCtrl.wallHeldByOtherUser = false;
    bluetoothMocks.connect.mockReset();
    bluetoothMocks.connect.mockResolvedValue(true);
    bluetoothMocks.onPress.mockClear();
    bluetoothMocks.hookOptions.mockClear();
    announceMock.mockClear();
    trackMock.mockClear();
    storeMocks.recordLaunch.mockClear();
    storeMocks.markNoLights.mockClear();
    storeMocks.dismiss.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('names the board and says what connecting does', () => {
    renderCard();

    expect(screen.getByRole('heading').textContent).toBe('Light climbs on Kilter at Blocs');
    expect(screen.getByText('Connect this phone to the board, then tap any climb to light it.')).toBeTruthy();
    expect(screen.getByText('Connect')).toBeTruthy();
    expect(screen.getByText('This wall has no lights')).toBeTruthy();
    expect(screen.getByLabelText('Not now')).toBeTruthy();
  });

  it('counts this launch against its two', () => {
    renderCard();

    expect(storeMocks.recordLaunch).toHaveBeenCalledWith('this-launch');
  });

  it.each([
    [
      'control',
      () => (storeCtrl.snapshot.enrolment = { userId: 'user-1', arm: 'control', forced: false, exposedAt: 1 }),
    ],
    ['an account not in the test', () => (storeCtrl.snapshot.enrolment = null)],
    ['the kill switch on', () => (flagsCtrl.enabled = false)],
    ['a phone that has connected', () => (storeCtrl.snapshot.device = freshDevice({ connectedAt: 5 }))],
    ['"no lights" already said', () => (storeCtrl.snapshot.device = freshDevice({ noLightsAt: 5 }))],
    ['two launches spent', () => (storeCtrl.snapshot.device = freshDevice({ cardLaunchIds: ['a', 'b'] }))],
    ['"Not now" this launch', () => (storeCtrl.snapshot.cardDismissedThisLaunch = true)],
    ['a peer holding the wall', () => (lightbulbCtrl.holderIsAuthoritative = true)],
    ['another account holding the wall', () => (lightbulbCtrl.wallHeldByOtherUser = true)],
  ])('renders nothing for %s', (_label, arrange) => {
    arrange();
    const { container } = renderCard();

    expect(container.textContent).toBe('');
    expect(storeMocks.recordLaunch).not.toHaveBeenCalled();
  });

  it('renders nothing on a board flagged as having no lights', () => {
    const { container } = renderCard(false);
    expect(container.textContent).toBe('');
  });

  it('connects through the bulb’s own connect, as its own surface, and says so to a screen reader', async () => {
    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByText('Connect'));
    });

    expect(bluetoothMocks.hookOptions).toHaveBeenCalledWith({ surface: 'first_connect_card' });
    expect(trackMock).toHaveBeenCalledWith('First Run Card Action', { action: 'connect' });
    expect(announceMock).toHaveBeenCalledWith('Connecting to Kilter at Blocs…');
    expect(bluetoothMocks.connect).toHaveBeenCalledTimes(1);
    expect(bluetoothMocks.connect).toHaveBeenCalledWith();
    expect(screen.queryByText(/Not connected to/)).toBeNull();
  });

  it('treats a connect that throws as a failed one', async () => {
    bluetoothMocks.connect.mockRejectedValue(new Error('adapter gone'));
    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByText('Connect'));
    });

    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('keeps the card up after a failed or cancelled connect, with Try again', async () => {
    bluetoothMocks.connect.mockResolvedValue(false);
    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByText('Connect'));
    });

    // Outcome-neutral: a false covers a dismissed picker and a denied
    // permission as well as a board out of range, so no "move closer".
    expect(screen.getByText("Not connected to Kilter at Blocs yet. Try again when you're ready.")).toBeTruthy();
    expect(screen.queryByText(/closer/i)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Try again'));
    });
    expect(trackMock).toHaveBeenCalledWith('First Run Card Action', { action: 'retry' });
    expect(bluetoothMocks.connect).toHaveBeenCalledTimes(2);
  });

  it('hands anything but a plain connect to the bulb’s own ladder', async () => {
    lightbulbCtrl.pressAction = 'relay';
    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByText('Connect'));
    });

    expect(bluetoothMocks.onPress).toHaveBeenCalledTimes(1);
    expect(bluetoothMocks.connect).not.toHaveBeenCalled();
  });

  it('shows a connect in flight on the button', () => {
    lightbulbCtrl.pending = true;
    renderCard();

    expect(screen.getByText('Connect').getAttribute('data-loading')).toBe('true');
  });

  it('records "no lights" on the phone and says so, without touching the board', () => {
    renderCard();

    fireEvent.click(screen.getByText('This wall has no lights'));

    expect(trackMock).toHaveBeenCalledWith('First Run Card Action', { action: 'no_lights' });
    expect(trackMock).toHaveBeenCalledWith('Board Lights Declined', { surface: 'climbs_card' });
    expect(storeMocks.markNoLights).toHaveBeenCalledWith(42);
  });

  it('hides for this launch on "Not now"', () => {
    renderCard();

    fireEvent.click(screen.getByLabelText('Not now'));

    expect(trackMock).toHaveBeenCalledWith('First Run Card Action', { action: 'dismiss' });
    expect(storeMocks.dismiss).toHaveBeenCalledTimes(1);
  });
});

describe('useFirstConnectCardExpected', () => {
  beforeEach(() => {
    storeCtrl.snapshot = {
      device: freshDevice(),
      userId: 'user-1',
      enrolment: { userId: 'user-1', arm: 'treatment', forced: false, exposedAt: 1 },
      cardDismissedThisLaunch: false,
    };
    flagsCtrl.enabled = true;
  });

  it('is true while the card is due, so the list holds its tips back', () => {
    expect(renderHook(() => useFirstConnectCardExpected(true)).result.current).toBe(true);
  });

  it('is false outside the treatment and on a board without lights', async () => {
    expect(renderHook(() => useFirstConnectCardExpected(false)).result.current).toBe(false);
    storeCtrl.snapshot.enrolment = null;
    await waitFor(() => expect(renderHook(() => useFirstConnectCardExpected(true)).result.current).toBe(false));
  });
});
