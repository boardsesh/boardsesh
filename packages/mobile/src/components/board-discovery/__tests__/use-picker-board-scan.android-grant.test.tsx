// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The picker's In range slot composed with the real scan (useQuickstartScan and
// useBoardScan), on Android, through one awkward but ordinary path: the
// climber says Don't allow, taps Continue again and allows. Android shows its
// permission dialog as the background and may answer before AppState says
// 'active' again, so the start is held at the radio and re-run on 'active'.
// The same 'active' also re-reads the permission, which sees the old refusal
// and used to reset the scan, cancelling the start the climber just made
// (Fable F3). Only the platform edges are stand-ins here: AppState, the
// permission calls, the radio and the queries.

const appState = vi.hoisted(() => ({
  currentState: 'active' as string,
  handlers: [] as Array<(state: string) => void>,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_event: string, handler: (state: string) => void) => {
      appState.handlers.push(handler);
      return {
        remove: () => {
          appState.handlers = appState.handlers.filter((registered) => registered !== handler);
        },
      };
    },
  },
}));

const permissions = vi.hoisted(() => ({
  granted: false,
  /** What the next request answers. A function so a test can play the dialog. */
  request: vi.fn(async (): Promise<string> => 'denied'),
}));
vi.mock('../../../lib/ble/use-ble-permissions', () => ({
  hasAndroidBleScanPermissions: vi.fn(async () => permissions.granted),
  requestBleRuntimePermissionStatus: () => permissions.request(),
}));

const radio = vi.hoisted(() => ({
  startDeviceScan: vi.fn(),
  stopDeviceScan: vi.fn(async () => {}),
}));
vi.mock('../../../lib/ble/ble-manager', () => ({ getBleManager: () => radio }));
// The wait for the radio to report powered on. Open by default; a test can
// close it to keep a start waiting there while the app does something else.
const radioWait = vi.hoisted(() => ({ gate: null as Promise<void> | null, open: () => {} }));
vi.mock('../../../lib/ble/availability', () => ({
  waitForBlePoweredOn: vi.fn(async () => {
    if (radioWait.gate) await radioWait.gate;
    return true;
  }),
}));
vi.mock('../../../lib/ble/bluetooth-unavailable', () => ({
  readBluetoothUnavailableReason: vi.fn(async () => 'unknown'),
  trackBluetoothUnavailable: vi.fn(),
}));
vi.mock('../../../lib/ble/android-location-permission', () => ({
  describeBlePermissionDenial: vi.fn(async () => ({})),
}));
const analyticsTrack = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics', () => ({ track: analyticsTrack }));
vi.mock('../../../lib/ble/transport-runtime', () => ({ bluetoothTransport: () => undefined }));
vi.mock('../../../lib/ble/bluetooth-status-store', () => ({ useBluetoothConnectedStatus: () => false }));
vi.mock('../../../lib/ble/bluetooth-authorization', () => ({
  readBluetoothAuthorization: () => null,
  hasBluetoothAuthorizationRead: () => false,
}));
vi.mock('../../../lib/open-app-settings', () => ({ openAppSettings: vi.fn(async () => true) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useBoardsBySerialNumbers: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    fetchStatus: 'idle',
    refetch: vi.fn(),
  }),
}));
vi.mock('../../../lib/ble/use-my-board-serial-configs', () => ({
  useMyBoardSerialConfigs: () => ({ data: [], isResolving: false }),
}));
vi.mock('../../../lib/ble/recognized-board-devices-store', () => ({
  useRecognizedBoardDevices: () => [],
  indexRecognizedBoardDevices: () => new Map(),
  normalizeBoardDeviceId: (deviceId: string) => deviceId.trim().toUpperCase(),
}));

const { usePickerBoardScan } = await import('../use-picker-board-scan');

const MY_BOARDS: UserBoard[] = [];

function fireAppState(nextState: string) {
  appState.currentState = nextState;
  act(() => {
    for (const handler of appState.handlers) handler(nextState);
  });
}

async function flush() {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  appState.currentState = 'active';
  appState.handlers = [];
  permissions.granted = false;
  permissions.request.mockReset().mockImplementation(async () => 'denied');
  radioWait.gate = null;
});

describe('the picker scan after a Don’t allow, then Continue and Allow', () => {
  // With the remote switch off a reset leaves no scan at all; with it on, a
  // reset is papered over by a scan the slot starts by itself, which reports
  // as picker_auto instead of the climber's tap.
  it.each([{ autoStart: true }, { autoStart: false }])(
    'runs exactly the tapped scan once the app is back, never reset (autoStart $autoStart)',
    async ({ autoStart }) => {
      const { result } = renderHook(() => usePickerBoardScan({ focused: true, autoStart, knownBoards: MY_BOARDS }));
      await flush();
      expect(result.current.phase).toBe('needs_permission');

      // Continue, and Don't allow in the dialog.
      act(() => result.current.start());
      await flush();
      expect(result.current.phase).toBe('needs_permission');
      expect(radio.startDeviceScan).not.toHaveBeenCalled();

      // Continue again. The dialog sends the app to the background, and the
      // Allow lands before AppState says 'active'.
      permissions.request.mockImplementation(async () => {
        fireAppState('background');
        permissions.granted = true;
        return 'granted';
      });
      act(() => result.current.start());
      await flush();
      // Held at the radio: nothing scanned in the background.
      expect(radio.startDeviceScan).not.toHaveBeenCalled();
      expect(result.current.phase).toBe('scanning');

      // Back in the app: the held start runs again and waits on the radio, and
      // meanwhile the re-read sees the grant beside the old refusal.
      permissions.request.mockImplementation(async () => 'granted');
      radioWait.gate = new Promise<void>((resolve) => {
        radioWait.open = resolve;
      });
      fireAppState('active');
      await flush();
      expect(result.current.phase).toBe('scanning');

      // The radio comes up: the start the climber made goes through.
      radioWait.gate = null;
      radioWait.open();
      await flush();

      expect(radio.startDeviceScan).toHaveBeenCalledTimes(1);
      expect(radio.stopDeviceScan).not.toHaveBeenCalled();
      expect(result.current.phase).toBe('scanning');

      // The scan that ran is the one the climber tapped for.
      act(() => result.current.stop());
      expect(analyticsTrack).toHaveBeenCalledWith(
        'Board Quickstart Scan Finished',
        expect.objectContaining({ outcome: 'stopped', trigger: 'picker_tap' }),
      );
      expect(analyticsTrack).not.toHaveBeenCalledWith(
        'Board Quickstart Scan Finished',
        expect.objectContaining({ trigger: 'picker_auto' }),
      );
    },
  );
});
