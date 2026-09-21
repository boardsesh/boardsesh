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
const flagsCtrl = vi.hoisted(() => ({ enabled: true }));
const settingsCtrl = vi.hoisted(() => ({ lightOnClimbTap: true }));
const bluetoothCtrl = vi.hoisted(() => ({ isConnected: false, virtualWallHeld: false, ledless: false }));

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
  useProfile: () => ({ data: profileCtrl.id ? { id: profileCtrl.id } : undefined }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { name: 'Kilter at Blocs' } }),
}));
vi.mock('../../../settings', () => ({ useSetting: () => [settingsCtrl.lightOnClimbTap, vi.fn()] }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({ ...bluetoothCtrl }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useChoose: () => chooseMock }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFirstConnectCtaEnabled: () => flagsCtrl.enabled,
}));
vi.mock('../../../providers/sheet-presentation-provider', () => ({ SHEET_SETTLE_MS: 5 }));

import { FirstConnectHost } from '../FirstConnectHost';
import {
  getFirstConnectSnapshot,
  resetFirstConnectStoreForTests,
  writeConnectStepEnrolment,
} from '../../../lib/onboarding/first-connect-store';

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
    settingsCtrl.lightOnClimbTap = true;
    bluetoothCtrl.isConnected = false;
    bluetoothCtrl.virtualWallHeld = false;
    bluetoothCtrl.ledless = false;
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

  it('says nothing when tapping a climb would not light it', async () => {
    settingsCtrl.lightOnClimbTap = false;
    await writeConnectStepEnrolment(ENROLMENT);
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().enrolment).toEqual(ENROLMENT));

    bluetoothCtrl.isConnected = true;
    rerender(<FirstConnectHost />);

    await waitFor(() => expect(getFirstConnectSnapshot().device?.connectedAt).toBe(1_000));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chooseMock).not.toHaveBeenCalled();
  });

  it('treats the device picker’s "no lights" like the card’s, for an enrolled account', async () => {
    await writeConnectStepEnrolment(ENROLMENT);
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().device).not.toBeNull());
    await waitFor(() => expect(getFirstConnectSnapshot().enrolment).toEqual(ENROLMENT));

    bluetoothCtrl.virtualWallHeld = true;
    rerender(<FirstConnectHost />);

    await waitFor(() => expect(getFirstConnectSnapshot().device?.noLightsAt).toBe(1_000));
    expect(trackMock).toHaveBeenCalledWith('Board Lights Declined', { surface: 'device_picker' });
  });

  it('leaves a board that already says it has no lights alone', async () => {
    const { rerender } = render(<FirstConnectHost />);
    await waitFor(() => expect(getFirstConnectSnapshot().device).not.toBeNull());

    bluetoothCtrl.virtualWallHeld = true;
    bluetoothCtrl.ledless = true;
    rerender(<FirstConnectHost />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getFirstConnectSnapshot().device?.noLightsAt).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });
});
