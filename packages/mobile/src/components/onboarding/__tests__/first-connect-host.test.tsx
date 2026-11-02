// @vitest-environment jsdom
//
// The connect-step test's always-mounted half (#5654, PR 7), against the real
// store over an in-memory AsyncStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';

const storage = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
const trackMock = vi.hoisted(() => vi.fn());
const registerArmMock = vi.hoisted(() => vi.fn());
const chooseMock = vi.hoisted(() => vi.fn(async () => 'got_it'));
const profileCtrl = vi.hoisted(() => ({ id: 'user-1' as string | undefined }));
const flagsCtrl = vi.hoisted(() => ({ enabled: true, keepLighting: true }));
const settingsCtrl = vi.hoisted(() => ({
  values: {
    lightOnClimbTap: true,
    lightOnSwipe: false,
    putOnBoardKeepsLighting: '45',
    moonboardPutOnBoardKeepsLighting: 'until_stopped',
    putOnBoardDrivesInSession: true,
  } as Record<string, unknown>,
}));
const sessionCtrl = vi.hoisted(() => ({ crew: false, shared: false }));
const boardCtrl = vi.hoisted(() => ({ boardType: 'kilter' }));
const bluetoothCtrl = vi.hoisted(() => ({
  isConnected: false,
  virtualWallHeld: false,
  ledless: false,
  autoDisconnectEnabled: false,
  autoDisconnectTimeoutSeconds: 30,
}));
const overridesCtrl = vi.hoisted(() => ({ overrides: {} as Record<string, boolean | string>, loaded: true }));
const enrolMock = vi.hoisted(() => vi.fn(async () => 'enrolled'));

vi.mock('../../../lib/preference-store', () => ({
  getPreference: async (key: string) => (storage.values.has(key) ? structuredClone(storage.values.get(key)) : null),
  setPreference: async (key: string, value: unknown) => {
    storage.values.set(key, structuredClone(value));
  },
}));
vi.mock('../../../lib/ble/last-connected-board-store', () => ({ getStoredLastConnectedBoard: async () => null }));
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
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../lib/analytics-connect-step-arm', () => ({ registerConnectStepArm: registerArmMock }));
vi.mock('../../../lib/clock', () => ({ nowMs: () => 1_000 }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({
    data: profileCtrl.id ? { id: profileCtrl.id, createdAt: '2026-09-20T12:00:00.000Z' } : undefined,
  }),
}));
vi.mock('../../../lib/feature-flag-overrides', () => ({
  useFeatureFlagOverrides: () => ({ overrides: overridesCtrl.overrides, loaded: overridesCtrl.loaded }),
}));
// The enrolment itself is covered by connect-step-enrolment.test.ts; here only
// when the host asks for one, and with what.
vi.mock('../../../lib/onboarding/connect-step-enrolment', () => ({
  CONNECT_STEP_FORCE_ARM_FLAG: 'first-connect-cta-arm',
  enrolInConnectStep: enrolMock,
}));
vi.mock('../../../providers/theme-provider', () => ({ useOptionalTheme: () => ({ variant: 'material' }) }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { name: 'Kilter at Blocs', boardType: boardCtrl.boardType } }),
}));
vi.mock('../../../settings', () => ({ useSetting: (key: string) => [settingsCtrl.values[key], vi.fn()] }));
vi.mock('../../../providers/queue-provider', () => ({
  useIsCrewSession: () => sessionCtrl.crew,
  useIsSharedSession: () => sessionCtrl.shared,
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({ ...bluetoothCtrl }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useChoose: () => chooseMock }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFirstConnectCtaEnabled: () => flagsCtrl.enabled,
  useWallSwipeToDriveEnabled: () => flagsCtrl.keepLighting,
}));
const settleCtrl = vi.hoisted(() => ({ ms: 5 }));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  get SHEET_SETTLE_MS() {
    return settleCtrl.ms;
  },
}));

import { FirstConnectHost } from '../FirstConnectHost';
import {
  getFirstConnectSnapshot,
  loadFirstConnectDevice,
  resetFirstConnectStoreForTests,
  writeConnectStepEnrolment,
} from '../../../lib/onboarding/first-connect-store';
import {
  _resetFirstConnectConfirmationPresenceForTests,
  isFirstConnectConfirmationShowing,
} from '../../../lib/onboarding/first-connect-confirmation-presence';

const ENROLMENT = { userId: 'user-1', arm: 'treatment' as const, forced: false, exposedAt: 1 };

describe('FirstConnectHost', () => {
  beforeEach(() => {
    storage.values.clear();
    resetFirstConnectStoreForTests();
    trackMock.mockClear();
    registerArmMock.mockClear();
    chooseMock.mockClear();
    profileCtrl.id = 'user-1';
    flagsCtrl.enabled = true;
    flagsCtrl.keepLighting = true;
    settingsCtrl.values = {
      lightOnClimbTap: true,
      lightOnSwipe: false,
      putOnBoardKeepsLighting: '45',
      moonboardPutOnBoardKeepsLighting: 'until_stopped',
      putOnBoardDrivesInSession: true,
    };
    sessionCtrl.crew = false;
    sessionCtrl.shared = false;
    boardCtrl.boardType = 'kilter';
    chooseMock.mockImplementation(async () => 'got_it');
    settleCtrl.ms = 5;
    _resetFirstConnectConfirmationPresenceForTests();
    bluetoothCtrl.isConnected = false;
    bluetoothCtrl.virtualWallHeld = false;
    bluetoothCtrl.ledless = false;
    bluetoothCtrl.autoDisconnectEnabled = false;
    bluetoothCtrl.autoDisconnectTimeoutSeconds = 30;
    overridesCtrl.overrides = {};
    overridesCtrl.loaded = true;
    enrolMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('binds the signed-in account and puts its arm on every event', async () => {
    await writeConnectStepEnrolment(ENROLMENT);

    render(<FirstConnectHost />);

    await waitFor(() => expect(registerArmMock).toHaveBeenCalledWith('treatment'));
    expect(getFirstConnectSnapshot()).toMatchObject({ userId: 'user-1', enrolment: ENROLMENT });
  });

  it('waits for the signed-in profile before it binds anyone', async () => {
    profileCtrl.id = undefined;
    const { rerender } = render(<FirstConnectHost />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registerArmMock).not.toHaveBeenCalled();

    await writeConnectStepEnrolment(ENROLMENT);
    profileCtrl.id = 'user-1';
    rerender(<FirstConnectHost />);

    await waitFor(() => expect(registerArmMock).toHaveBeenCalledWith('treatment'));
    expect(registerArmMock).not.toHaveBeenCalledWith(null);
  });

  it('clears the arm for an account that is not in the test', async () => {
    render(<FirstConnectHost />);

    await waitFor(() => expect(registerArmMock).toHaveBeenCalledWith(null));
  });

  it('confirms the first connect of an enrolled account, once', async () => {
    await writeConnectStepEnrolment(ENROLMENT);
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().enrolment).toEqual(ENROLMENT));

    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);

    await waitFor(() => expect(chooseMock).toHaveBeenCalledTimes(1));
    expect(chooseMock).toHaveBeenCalledWith({
      title: 'Connected to Kilter at Blocs',
      message: 'Tapping a climb in the list now lights it on the wall.',
      options: [{ value: 'got_it', label: 'Got it' }],
      cancelValue: 'got_it',
    });
    expect(getFirstConnectSnapshot().device).toMatchObject({ connectedAt: 1_000, confirmationShownAt: 1_000 });

    // A later reconnect in the same launch says nothing.
    bluetoothCtrl.isConnected = false;
    rerender(<FirstConnectHost />);
    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chooseMock).toHaveBeenCalledTimes(1);
  });

  it('records the first connect for everyone, but confirms only for enrolled accounts', async () => {
    bluetoothCtrl.isConnected = true;
    render(<FirstConnectHost />);

    await waitFor(() => expect(getFirstConnectSnapshot().device?.connectedAt).toBe(1_000));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chooseMock).not.toHaveBeenCalled();
  });

  it('says nothing with the kill switch on', async () => {
    flagsCtrl.enabled = false;
    await writeConnectStepEnrolment(ENROLMENT);
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().enrolment).toEqual(ENROLMENT));

    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);

    await waitFor(() => expect(getFirstConnectSnapshot().device?.connectedAt).toBe(1_000));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chooseMock).not.toHaveBeenCalled();
  });

  /** Enrol, connect, and return the message the confirmation showed. */
  async function confirmFirstConnect(): Promise<string> {
    await writeConnectStepEnrolment(ENROLMENT);
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().enrolment).toEqual(ENROLMENT));

    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);

    await waitFor(() => expect(chooseMock).toHaveBeenCalledTimes(1));
    const [request] = chooseMock.mock.calls[0] as unknown as [{ title: string; message: string }];
    expect(request.title).toBe('Connected to Kilter at Blocs');
    return request.message;
  }

  // With Light on tap off (the 2.7 default) it still confirms, and says what
  // Put on board keeps lighting instead of promising a tap lights a climb.
  it('confirms with Light on tap off too, naming Put on board’s window', async () => {
    settingsCtrl.values.lightOnClimbTap = false;

    expect(await confirmFirstConnect()).toBe(
      'For 45 seconds after Put on board, every climb you pick lights too. After that, tap Put on board again.',
    );
    expect(getFirstConnectSnapshot().device).toMatchObject({ connectedAt: 1_000, confirmationShownAt: 1_000 });
  });

  it('reads the window from the climber’s keep-lighting choice', async () => {
    settingsCtrl.values.lightOnClimbTap = false;
    settingsCtrl.values.putOnBoardKeepsLighting = '30';

    expect(await confirmFirstConnect()).toMatch(/^For 30 seconds after Put on board/);
  });

  it('says a 60 s window the way the preview-first card does', async () => {
    settingsCtrl.values.lightOnClimbTap = false;
    settingsCtrl.values.putOnBoardKeepsLighting = '60';

    expect(await confirmFirstConnect()).toBe(
      'For 1 minute after Put on board, every climb you pick lights too. After that, tap Put on board again.',
    );
  });

  // A list tap in a shared session stays a preview whatever Light on tap says.
  it('never says a tap lights a climb in a shared session', async () => {
    sessionCtrl.shared = true;

    expect(await confirmFirstConnect()).toMatch(/^For 45 seconds after Put on board/);
  });

  // Solo with Light the board as I swipe on, Put on board opens no window.
  it('promises no window solo with Light the board as I swipe on', async () => {
    settingsCtrl.values.lightOnClimbTap = false;
    settingsCtrl.values.lightOnSwipe = true;

    expect(await confirmFirstConnect()).toBe('Tap a climb, then Put on board to light it on the wall.');
  });

  it('names auto-disconnect’s timeout when it lets go of the board first', async () => {
    settingsCtrl.values.lightOnClimbTap = false;
    bluetoothCtrl.autoDisconnectEnabled = true;
    bluetoothCtrl.autoDisconnectTimeoutSeconds = 15;

    expect(await confirmFirstConnect()).toMatch(/^For 15 seconds after Put on board/);
  });

  it('says auto-disconnect can end a MoonBoard’s drive', async () => {
    settingsCtrl.values.lightOnClimbTap = false;
    boardCtrl.boardType = 'moonboard';
    bluetoothCtrl.autoDisconnectEnabled = true;
    bluetoothCtrl.autoDisconnectTimeoutSeconds = 120;

    expect(await confirmFirstConnect()).toBe(
      'After Put on board, every climb you pick lights until you tap the button to stop, or until auto-disconnect lets go of the board.',
    );
  });

  it('says a MoonBoard keeps lighting until the climber stops it', async () => {
    settingsCtrl.values.lightOnClimbTap = false;
    boardCtrl.boardType = 'moonboard';

    expect(await confirmFirstConnect()).toBe(
      'After Put on board, every climb you pick lights until you tap the button to stop.',
    );
  });

  it('promises one climb where no window can start', async () => {
    settingsCtrl.values.lightOnClimbTap = false;
    flagsCtrl.keepLighting = false;

    expect(await confirmFirstConnect()).toBe('Tap a climb, then Put on board to light it on the wall.');
  });

  it('honours In a session too in a crew session', async () => {
    settingsCtrl.values.lightOnClimbTap = false;
    settingsCtrl.values.putOnBoardDrivesInSession = false;
    sessionCtrl.crew = true;

    expect(await confirmFirstConnect()).toBe('Tap a climb, then Put on board to light it on the wall.');
  });

  it('holds the preview-first card back from the decision until the dialog closes', async () => {
    let close: (value: string) => void = () => {};
    chooseMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          close = resolve;
        }),
    );
    await writeConnectStepEnrolment(ENROLMENT);
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().enrolment).toEqual(ENROLMENT));
    expect(isFirstConnectConfirmationShowing()).toBe(false);

    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);

    await waitFor(() => expect(isFirstConnectConfirmationShowing()).toBe(true));
    await waitFor(() => expect(chooseMock).toHaveBeenCalledTimes(1));
    expect(isFirstConnectConfirmationShowing()).toBe(true);

    close('got_it');
    await waitFor(() => expect(isFirstConnectConfirmationShowing()).toBe(false));
  });

  // Recording the connect is what hides the Climbs card, and the list's tips
  // and the preview-first card wait behind it. They must see the confirmation
  // coming before the card goes, or one of them takes the slot in between and
  // the dialog lands on top of it (and the quick-actions tip is used up).
  it('says the confirmation is coming before it records the connect that hides the card', async () => {
    // The dialog stays up, so the presence is still on whenever the test looks.
    chooseMock.mockImplementation(() => new Promise<string>(() => {}));
    await writeConnectStepEnrolment(ENROLMENT);
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().enrolment).toEqual(ENROLMENT));
    // The card had this phone's state read: it shows only once it has.
    await loadFirstConnectDevice();

    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);

    expect(getFirstConnectSnapshot().device?.connectedAt).toBeNull();
    expect(isFirstConnectConfirmationShowing()).toBe(true);
    await waitFor(() => expect(getFirstConnectSnapshot().device?.connectedAt).toBe(1_000));
    expect(isFirstConnectConfirmationShowing()).toBe(true);
    await waitFor(() => expect(chooseMock).toHaveBeenCalledTimes(1));
  });

  it('lets the preview-first card go again when it unmounts before the dialog', async () => {
    // Long enough for the unmount to land while the picker would still be settling.
    settleCtrl.ms = 10_000;
    await writeConnectStepEnrolment(ENROLMENT);
    const { rerender, unmount } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().enrolment).toEqual(ENROLMENT));

    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);
    await waitFor(() => expect(isFirstConnectConfirmationShowing()).toBe(true));
    unmount();

    expect(isFirstConnectConfirmationShowing()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chooseMock).not.toHaveBeenCalled();
  });

  it('never holds the card back for a connect it does not confirm', async () => {
    bluetoothCtrl.isConnected = true;
    render(<FirstConnectHost />);

    await waitFor(() => expect(getFirstConnectSnapshot().device?.connectedAt).toBe(1_000));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isFirstConnectConfirmationShowing()).toBe(false);
  });

  it('never announces a reconnect on a phone that has connected before', async () => {
    await writeConnectStepEnrolment(ENROLMENT);
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().enrolment).toEqual(ENROLMENT));
    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);
    await waitFor(() => expect(chooseMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(isFirstConnectConfirmationShowing()).toBe(false));

    bluetoothCtrl.isConnected = false;
    rerender(<FirstConnectHost />);
    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);

    expect(isFirstConnectConfirmationShowing()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isFirstConnectConfirmationShowing()).toBe(false);
    expect(chooseMock).toHaveBeenCalledTimes(1);
  });

  it('never reads a virtual hold as "no lights", even one that moves with a board switch', async () => {
    // The Bluetooth provider releases a virtual hold in the cleanup of its
    // board effect, so switching from a ledless wall held virtually to a wall
    // with lights renders one commit with the hold still up on the new board.
    // Only the device picker's tap says "no lights" (device-picker-no-lights.ts).
    await writeConnectStepEnrolment(ENROLMENT);
    bluetoothCtrl.virtualWallHeld = true;
    bluetoothCtrl.ledless = true;
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().device).not.toBeNull());

    bluetoothCtrl.ledless = false;
    rerender(<FirstConnectHost />);
    bluetoothCtrl.virtualWallHeld = false;
    rerender(<FirstConnectHost />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getFirstConnectSnapshot().device?.noLightsAt).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });

  describe('the QA override', () => {
    it('leaves the launch value to the gate', async () => {
      overridesCtrl.overrides = { 'first-connect-cta-arm': 'treatment' };
      render(<FirstConnectHost />);

      await waitFor(() => expect(registerArmMock).toHaveBeenCalled());
      expect(enrolMock).not.toHaveBeenCalled();
    });

    it('re-enrols the signed-in account as soon as a tester moves it, and again when cleared', async () => {
      const { rerender } = render(<FirstConnectHost />);
      await waitFor(() => expect(registerArmMock).toHaveBeenCalled());

      overridesCtrl.overrides = { 'first-connect-cta-arm': 'treatment' };
      rerender(<FirstConnectHost />);

      await waitFor(() => expect(enrolMock).toHaveBeenCalledTimes(1));
      expect(enrolMock).toHaveBeenCalledWith({
        userId: 'user-1',
        accountCreatedAt: '2026-09-20T12:00:00.000Z',
        enabled: true,
        hadBoard: true,
        uiVariant: 'material',
      });

      rerender(<FirstConnectHost />);
      overridesCtrl.overrides = {};
      rerender(<FirstConnectHost />);
      await waitFor(() => expect(enrolMock).toHaveBeenCalledTimes(2));
    });

    it('waits for the overrides to load before it treats anything as a change', async () => {
      overridesCtrl.loaded = false;
      const { rerender } = render(<FirstConnectHost />);

      overridesCtrl.overrides = { 'first-connect-cta-arm': 'control' };
      overridesCtrl.loaded = true;
      rerender(<FirstConnectHost />);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(enrolMock).not.toHaveBeenCalled();
    });

    it('asks for nothing while the profile is still loading', async () => {
      profileCtrl.id = undefined;
      const { rerender } = render(<FirstConnectHost />);

      overridesCtrl.overrides = { 'first-connect-cta-arm': 'control' };
      rerender(<FirstConnectHost />);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(enrolMock).not.toHaveBeenCalled();
    });
  });
});
