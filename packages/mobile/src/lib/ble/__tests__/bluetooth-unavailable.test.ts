import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TFunction } from 'i18next';
import {
  reactNativePermissionHarness,
  resetReactNativePermissionHarness,
} from './react-native-permissions-test-harness';
import {
  installIosBluetoothAuthorization,
  resetNativeBluetoothAuthorizationHarness,
} from './native-bluetooth-authorization-test-harness';

const mockBleManager = vi.hoisted(() => ({ state: vi.fn(), onStateChange: vi.fn() }));
const mockAlert = vi.hoisted(() => ({ alert: vi.fn() }));
const mockLinking = vi.hoisted(() => ({ openSettings: vi.fn(async () => undefined) }));
const mockTrack = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const { reactNativePermissionHarness: harness } = await import('./react-native-permissions-test-harness');
  return {
    Alert: mockAlert,
    Linking: mockLinking,
    Platform: harness.platform,
    PermissionsAndroid: harness.permissionsAndroid,
  };
});

vi.mock('../ble-manager', () => ({ getBleManager: () => mockBleManager }));
vi.mock('../../analytics', () => ({ track: mockTrack }));
// The real bluetooth-authorization reads this; null (the default) is Android,
// web, or an iOS binary that still asks at launch.
vi.mock('../../../../modules/live-activity/src/index', async () => {
  const { nativeBluetoothAuthorizationHarness: harness } =
    await import('./native-bluetooth-authorization-test-harness');
  return {
    get boardBleNative() {
      return harness.nativeModule;
    },
  };
});

import {
  bluetoothUnavailableReasonForState,
  readBluetoothUnavailableReason,
  trackBluetoothUnavailable,
} from '../bluetooth-unavailable';
import { alertBluetoothUnavailable, bluetoothBlockedBody } from '../bluetooth-unavailable-alert';

// Echo the key so assertions name the exact copy each state gets.
const echoSettings = ((key: string) => key) as unknown as TFunction<'settings'>;
const echoCommon = ((key: string) => `common:${key}`) as unknown as TFunction<'common'>;

type AlertButtonArg = { text?: string; style?: string; onPress?: () => void };

function lastAlertButtons(): AlertButtonArg[] {
  const call = mockAlert.alert.mock.calls.at(-1) as unknown[] | undefined;
  return (call?.[2] as AlertButtonArg[] | undefined) ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetReactNativePermissionHarness();
  resetNativeBluetoothAuthorizationHarness();
  mockBleManager.state.mockResolvedValue('PoweredOn');
  mockBleManager.onStateChange.mockReturnValue({ remove: vi.fn() });
});

describe('bluetoothUnavailableReasonForState', () => {
  it.each([
    ['Unauthorized', 'unauthorized'],
    ['PoweredOff', 'powered_off'],
    ['Unsupported', 'unsupported'],
    // Nothing in these says why the adapter gave up, so they must not be
    // counted (or worded) as a switched-off radio or a blocked permission.
    ['Unknown', 'unknown'],
    ['Resetting', 'unknown'],
    ['PoweredOn', 'unknown'],
  ])('maps %s to %s', (radioState, reason) => {
    expect(bluetoothUnavailableReasonForState(radioState)).toBe(reason);
  });
});

describe('readBluetoothUnavailableReason', () => {
  it('reads the ble-plx radio state', async () => {
    mockBleManager.state.mockResolvedValue('Unauthorized');
    await expect(readBluetoothUnavailableReason()).resolves.toBe('unauthorized');
  });

  it('falls back to unknown when the state read throws', async () => {
    mockBleManager.state.mockRejectedValue(new Error('manager destroyed'));
    await expect(readBluetoothUnavailableReason()).resolves.toBe('unknown');
  });

  // Reading ble-plx's state creates its manager, and on iOS that raises the
  // Bluetooth alert while the question is unanswered.
  it('says not_asked, without touching ble-plx, while the iOS question is unanswered', async () => {
    reactNativePermissionHarness.platform.OS = 'ios';
    installIosBluetoothAuthorization('notDetermined');

    await expect(readBluetoothUnavailableReason()).resolves.toBe('not_asked');
    expect(mockBleManager.state).not.toHaveBeenCalled();
  });

  it.each(['denied', 'restricted'] as const)(
    'reads a %s iOS authorization as unauthorized, without touching ble-plx',
    async (authorization) => {
      reactNativePermissionHarness.platform.OS = 'ios';
      installIosBluetoothAuthorization(authorization);

      await expect(readBluetoothUnavailableReason()).resolves.toBe('unauthorized');
      expect(mockBleManager.state).not.toHaveBeenCalled();
    },
  );

  it('waits on iOS for a just-created ble-plx manager to report a real state', async () => {
    // Allowed, radio off. The first read lands before CoreBluetooth's first
    // update, which used to read as "no idea" and show the generic copy.
    reactNativePermissionHarness.platform.OS = 'ios';
    installIosBluetoothAuthorization('allowedAlways');
    mockBleManager.state.mockResolvedValue('Unknown');
    const removeSubscription = vi.fn();
    mockBleManager.onStateChange.mockImplementation((listener: (state: string) => void) => {
      queueMicrotask(() => listener('PoweredOff'));
      return { remove: removeSubscription };
    });

    await expect(readBluetoothUnavailableReason()).resolves.toBe('powered_off');
    expect(removeSubscription).toHaveBeenCalledOnce();
  });

  it('keeps the single read on Android, where an Unknown state is the answer', async () => {
    mockBleManager.state.mockResolvedValue('Unknown');

    await expect(readBluetoothUnavailableReason()).resolves.toBe('unknown');
    expect(mockBleManager.onStateChange).not.toHaveBeenCalled();
  });
});

describe('trackBluetoothUnavailable', () => {
  it('reports reason, surface and platform, plus the board on a connect', () => {
    reactNativePermissionHarness.platform.OS = 'ios';
    trackBluetoothUnavailable('unauthorized', 'connect', 'kilter');

    expect(mockTrack).toHaveBeenCalledWith('Bluetooth Unavailable', {
      reason: 'unauthorized',
      surface: 'connect',
      platform: 'ios',
      boardName: 'kilter',
    });
  });

  it('records nothing for a question the climber has not answered yet', () => {
    trackBluetoothUnavailable('not_asked', 'quickstart_scan');

    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('leaves boardName off the quickstart scan, which runs before a board is picked', () => {
    trackBluetoothUnavailable('powered_off', 'quickstart_scan');

    expect(mockTrack).toHaveBeenCalledWith('Bluetooth Unavailable', {
      reason: 'powered_off',
      surface: 'quickstart_scan',
      platform: 'android',
    });
  });
});

describe('bluetoothBlockedBody', () => {
  it('names the per-app Bluetooth switch on iOS', () => {
    reactNativePermissionHarness.platform.OS = 'ios';
    expect(bluetoothBlockedBody(echoSettings)).toBe('ble.blockedBody');
  });

  it('names "Nearby devices" on Android 12+, where Bluetooth scanning lives', () => {
    reactNativePermissionHarness.platform.Version = 31;
    expect(bluetoothBlockedBody(echoSettings)).toBe('ble.blockedBodyNearbyDevices');
  });

  it('names Location on Android 11 and older, which gate scans on it', () => {
    reactNativePermissionHarness.platform.Version = 30;
    expect(bluetoothBlockedBody(echoSettings)).toBe('ble.blockedBodyLocation');
  });
});

describe('alertBluetoothUnavailable', () => {
  it('says Bluetooth is blocked, with Open Settings, when iOS reports Unauthorized', async () => {
    // The #5654 bug: a denied iOS prompt read "Bluetooth is off. Turn it on",
    // to a climber whose Bluetooth was on.
    reactNativePermissionHarness.platform.OS = 'ios';
    mockBleManager.state.mockResolvedValue('Unauthorized');

    const reason = await alertBluetoothUnavailable({ boardName: 'kilter', t: echoSettings, tCommon: echoCommon });

    expect(reason).toBe('unauthorized');
    expect(mockAlert.alert).toHaveBeenCalledWith('ble.blockedTitle', 'ble.blockedBody', expect.any(Array));
    expect(lastAlertButtons().map((button) => button.text)).toEqual(['ble.cancel', 'ble.openSettings']);
    expect(mockTrack).toHaveBeenCalledWith('Bluetooth Unavailable', {
      reason: 'unauthorized',
      surface: 'connect',
      platform: 'ios',
      boardName: 'kilter',
    });
  });

  it('opens the Settings app from the Open Settings button', async () => {
    reactNativePermissionHarness.platform.OS = 'ios';
    mockBleManager.state.mockResolvedValue('Unauthorized');
    await alertBluetoothUnavailable({ t: echoSettings, tCommon: echoCommon });

    lastAlertButtons()
      .find((button) => button.text === 'ble.openSettings')
      ?.onPress?.();

    expect(mockLinking.openSettings).toHaveBeenCalledTimes(1);
  });

  it('uses a known reason without reading the radio (Android never-ask-again)', async () => {
    await alertBluetoothUnavailable({ reason: 'unauthorized', t: echoSettings, tCommon: echoCommon });

    expect(mockBleManager.state).not.toHaveBeenCalled();
    expect(mockAlert.alert).toHaveBeenCalledWith('ble.blockedTitle', 'ble.blockedBodyNearbyDevices', expect.any(Array));
  });

  it('asks to allow Bluetooth, and records nothing, when iOS has not asked yet', async () => {
    reactNativePermissionHarness.platform.OS = 'ios';
    installIosBluetoothAuthorization('notDetermined');

    const reason = await alertBluetoothUnavailable({ boardName: 'kilter', t: echoSettings, tCommon: echoCommon });

    expect(reason).toBe('not_asked');
    expect(mockAlert.alert).toHaveBeenCalledWith('ble.permissionRequired', 'ble.errorPermissionDenied');
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockBleManager.state).not.toHaveBeenCalled();
  });

  it('shows the blocked copy for a denied iOS authorization', async () => {
    reactNativePermissionHarness.platform.OS = 'ios';
    installIosBluetoothAuthorization('denied');

    const reason = await alertBluetoothUnavailable({ t: echoSettings, tCommon: echoCommon });

    expect(reason).toBe('unauthorized');
    expect(mockAlert.alert).toHaveBeenCalledWith('ble.blockedTitle', 'ble.blockedBody', expect.any(Array));
  });

  it('keeps "Bluetooth is off" for a radio that is off', async () => {
    mockBleManager.state.mockResolvedValue('PoweredOff');

    const reason = await alertBluetoothUnavailable({ t: echoSettings, tCommon: echoCommon });

    expect(reason).toBe('powered_off');
    expect(mockAlert.alert).toHaveBeenCalledWith('ble.connectionFailedTitle', 'common:bluetooth.unavailable');
    expect(mockTrack).toHaveBeenCalledWith('Bluetooth Unavailable', expect.objectContaining({ reason: 'powered_off' }));
  });

  it.each(['Unsupported', 'Unknown'])('keeps the existing copy for %s, with no Settings button', async (radioState) => {
    mockBleManager.state.mockResolvedValue(radioState);

    await alertBluetoothUnavailable({ t: echoSettings, tCommon: echoCommon });

    expect(mockAlert.alert).toHaveBeenCalledWith('ble.connectionFailedTitle', 'common:bluetooth.unavailable');
  });
});
