// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BluetoothAuthorization } from '../../../lib/ble/bluetooth-authorization';
import type { BoardScanStatus, BoardScanUnavailableReason } from '../../../lib/ble/use-board-scan';
import type { QuickstartLookupState, QuickstartRow } from '../quickstart-scan-rows';

// The board picker's in-range slot: when it scans by itself, what ends a scan,
// and that nothing on open can raise the Bluetooth prompt. The scan itself is
// a stand-in here; use-board-scan.test.ts covers the radio.

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' | 'web' }));
const appState = vi.hoisted(() => ({
  currentState: 'active' as string,
  handlers: [] as Array<(state: string) => void>,
}));
vi.mock('react-native', () => ({
  get Platform() {
    return { OS: platform.OS };
  },
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

const bluetooth = vi.hoisted(() => ({
  authorization: 'allowedAlways' as BluetoothAuthorization | null,
  hasNativeRead: true,
  androidGranted: true as boolean | null,
  connected: false,
  transportInstalled: false,
}));
vi.mock('../../../lib/ble/bluetooth-authorization', () => ({
  readBluetoothAuthorization: vi.fn(() => bluetooth.authorization),
  hasBluetoothAuthorizationRead: vi.fn(() => bluetooth.hasNativeRead),
}));
vi.mock('../../../lib/ble/use-ble-permissions', () => ({
  hasAndroidBleScanPermissions: vi.fn(async () => bluetooth.androidGranted),
}));
vi.mock('../../../lib/ble/bluetooth-status-store', () => ({
  useBluetoothConnectedStatus: () => bluetooth.connected,
}));
vi.mock('../../../lib/ble/transport-runtime', () => ({
  bluetoothTransport: () => (bluetooth.transportInstalled ? { discovery: 'external' } : undefined),
}));
// The radio's on/off reports, by hand: who is listening, and a way to say "on".
const radioWatch = vi.hoisted(() => ({
  listeners: [] as Array<() => void>,
  subscriptions: 0,
}));
vi.mock('../bluetooth-radio', () => ({
  watchBluetoothPoweredOn: (onPoweredOn: () => void) => {
    radioWatch.subscriptions += 1;
    radioWatch.listeners.push(onPoweredOn);
    return () => {
      radioWatch.listeners = radioWatch.listeners.filter((listener) => listener !== onPoweredOn);
    };
  },
}));
const settings = vi.hoisted(() => ({ openAppSettings: vi.fn(async () => true) }));
vi.mock('../../../lib/open-app-settings', () => settings);

// The shared scan composition, driven by hand. A start reaches the radio at
// once by default (status 'scanning'), as a real one does after its awaits;
// tests that need it to wait install their own `start`.
const scan = vi.hoisted(() => ({
  status: 'idle' as BoardScanStatus,
  unavailableReason: null as BoardScanUnavailableReason | null,
  rows: [] as QuickstartRow[],
  lookup: 'none' as QuickstartLookupState,
  start: vi.fn(async (_trigger?: string) => {}),
  reset: vi.fn(),
  finish: vi.fn(),
  retryLookup: vi.fn(),
  options: null as {
    mayStartRadio?: () => boolean;
    knownBoards?: unknown;
  } | null,
}));
vi.mock('../use-quickstart-scan', () => ({
  useQuickstartScan: (options: { mayStartRadio?: () => boolean; knownBoards?: unknown }) => {
    scan.options = options;
    return {
      status: scan.status,
      unavailableReason: scan.unavailableReason,
      devices: [],
      rows: scan.rows,
      lookup: scan.lookup,
      start: scan.start,
      reset: scan.reset,
      finish: scan.finish,
      retryLookup: scan.retryLookup,
    };
  },
}));

type HookModule = typeof import('../use-picker-board-scan');
let usePickerBoardScan: HookModule['usePickerBoardScan'];

const MY_BOARDS: UserBoard[] = [{ uuid: 'home-moon', boardType: 'moonboard', name: 'Home' } as unknown as UserBoard];

type HookProps = { focused: boolean; autoStart: boolean };

function renderPickerScan(initialProps: HookProps = { focused: true, autoStart: true }) {
  return renderHook((props: HookProps) => usePickerBoardScan({ ...props, knownBoards: MY_BOARDS }), {
    initialProps,
  });
}

function fireAppState(nextState: string) {
  appState.currentState = nextState;
  act(() => {
    for (const handler of appState.handlers) handler(nextState);
  });
}

function startTriggers(): unknown[] {
  return scan.start.mock.calls.map(([trigger]) => trigger);
}

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  platform.OS = 'ios';
  appState.currentState = 'active';
  appState.handlers = [];
  bluetooth.authorization = 'allowedAlways';
  bluetooth.hasNativeRead = true;
  bluetooth.androidGranted = true;
  bluetooth.connected = false;
  bluetooth.transportInstalled = false;
  scan.status = 'idle';
  scan.unavailableReason = null;
  scan.rows = [];
  scan.lookup = 'none';
  scan.start.mockReset().mockImplementation(async () => {
    scan.status = 'scanning';
  });
  scan.reset.mockReset();
  scan.finish.mockReset();
  scan.retryLookup.mockReset();
  settings.openAppSettings.mockClear();
  radioWatch.listeners = [];
  radioWatch.subscriptions = 0;
  // The 30 s cooldown is module state that spans picker visits: a fresh module
  // per test, so each starts with no picker scan behind it.
  vi.resetModules();
  ({ usePickerBoardScan } = await import('../use-picker-board-scan'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePickerBoardScan on open', () => {
  it('scans by itself, once, with the climber’s boards to recognise', async () => {
    const { result, rerender } = renderPickerScan();

    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto']));
    expect(result.current.phase).toBe('scanning');
    expect(scan.options).toEqual({
      mayStartRadio: expect.any(Function),
      knownBoards: MY_BOARDS,
    });
    rerender({ focused: true, autoStart: true });
    expect(scan.start).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('scanning');
  });

  it('asks with the button, never by itself, when the iOS read failed: the question may be open', async () => {
    bluetooth.authorization = null;
    bluetooth.hasNativeRead = true;
    const { result } = renderPickerScan();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.phase).toBe('needs_permission');
    expect(scan.start).not.toHaveBeenCalled();
  });

  it('scans by itself on an iOS binary with no native read, which asked at launch', async () => {
    bluetooth.authorization = null;
    bluetooth.hasNativeRead = false;
    renderPickerScan();
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto']));
  });

  it('never asks on open while the iOS question is unanswered: only the button asks', async () => {
    bluetooth.authorization = 'notDetermined';
    const { result } = renderPickerScan();

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.phase).toBe('needs_permission');
    expect(scan.start).not.toHaveBeenCalled();

    act(() => result.current.start());
    expect(startTriggers()).toEqual(['picker_tap']);
  });

  it('sends a refused iOS permission to Settings', async () => {
    bluetooth.authorization = 'denied';
    const { result } = renderPickerScan();
    expect(result.current.phase).toBe('blocked_denied');
    act(() => result.current.openSettings());
    expect(settings.openAppSettings).toHaveBeenCalledOnce();
    expect(scan.start).not.toHaveBeenCalled();
  });

  it('asks on Android only from the button when the scan permissions are not held', async () => {
    platform.OS = 'android';
    bluetooth.androidGranted = false;
    const { result } = renderPickerScan();

    await waitFor(() => expect(result.current.phase).toBe('needs_permission'));
    expect(scan.start).not.toHaveBeenCalled();
  });

  it('scans by itself on Android once the check says the permissions are held', async () => {
    platform.OS = 'android';
    const { result } = renderPickerScan();

    expect(result.current.phase).toBe('scanning');
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto']));
  });

  it.each([
    { name: 'in a browser', setUp: () => (platform.OS = 'web') },
    { name: 'behind an installed test transport', setUp: () => (bluetooth.transportInstalled = true) },
    { name: 'while this phone is connected to a board', setUp: () => (bluetooth.connected = true) },
  ])('stays hidden and scans nothing $name', async ({ setUp }) => {
    setUp();
    const { result } = renderPickerScan();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.phase).toBe('hidden');
    expect(scan.start).not.toHaveBeenCalled();
    act(() => result.current.start());
    expect(scan.start).not.toHaveBeenCalled();
  });

  it('waits for a tap with the remote switch off', async () => {
    const { result } = renderPickerScan({ focused: true, autoStart: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.phase).toBe('tap_to_scan');
    expect(scan.start).not.toHaveBeenCalled();
    act(() => result.current.start());
    expect(startTriggers()).toEqual(['picker_tap']);
  });

  it('offers the button again when another owner held the scan', async () => {
    scan.start.mockImplementation(async () => {
      scan.status = 'busy';
    });
    const { result } = renderPickerScan();
    await waitFor(() => expect(result.current.phase).toBe('tap_to_scan'));
    expect(startTriggers()).toEqual(['picker_auto']);

    scan.start.mockImplementation(async () => {
      scan.status = 'scanning';
    });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe('scanning'));
    expect(startTriggers()).toEqual(['picker_auto', 'picker_tap']);
  });
});

describe('usePickerBoardScan cooldown across picker opens', () => {
  it('waits for a tap within 30 s of the last picker scan, then scans by itself again', async () => {
    const first = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    scan.status = 'scanning';
    first.rerender({ focused: true, autoStart: true });
    scan.status = 'done';
    first.rerender({ focused: true, autoStart: true });
    first.unmount();

    scan.status = 'idle';
    scan.start.mockClear();
    const second = renderPickerScan();
    await act(async () => {
      await Promise.resolve();
    });
    expect(second.result.current.phase).toBe('tap_to_scan');
    expect(scan.start).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto']));
  });

  it('starts the cooldown from a scan cut short by unmounting mid-scan', async () => {
    const first = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    scan.status = 'scanning';
    first.rerender({ focused: true, autoStart: true });
    first.unmount();

    scan.status = 'idle';
    scan.start.mockClear();
    const second = renderPickerScan();
    await act(async () => {
      await Promise.resolve();
    });
    expect(second.result.current.phase).toBe('tap_to_scan');
    expect(scan.start).not.toHaveBeenCalled();
  });

  it('lets the button scan inside the cooldown', async () => {
    const first = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    scan.status = 'scanning';
    first.rerender({ focused: true, autoStart: true });
    first.unmount();

    scan.status = 'idle';
    scan.start.mockClear();
    const second = renderPickerScan();
    act(() => second.result.current.start());
    expect(startTriggers()).toEqual(['picker_tap']);
  });
});

describe('usePickerBoardScan ends a scan', () => {
  async function scanning() {
    const hook = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    scan.status = 'scanning';
    hook.rerender({ focused: true, autoStart: true });
    return hook;
  }

  it('when the picker loses focus', async () => {
    const { rerender } = await scanning();
    rerender({ focused: false, autoStart: true });
    expect(scan.finish).toHaveBeenCalled();
  });

  it('when the app goes to the background', async () => {
    await scanning();
    fireAppState('background');
    expect(scan.finish).toHaveBeenCalled();
  });

  it('not for iOS inactive: the Bluetooth alert and Control Center are not the background', async () => {
    await scanning();
    fireAppState('inactive');
    expect(scan.finish).not.toHaveBeenCalled();
  });

  it('when the phone connects to a board, and then hides', async () => {
    const { result, rerender } = await scanning();
    bluetooth.connected = true;
    rerender({ focused: true, autoStart: true });
    expect(scan.finish).toHaveBeenCalled();
    expect(result.current.phase).toBe('hidden');
  });

  it('on a pick', async () => {
    const { result } = await scanning();
    act(() => result.current.stop());
    expect(scan.finish).toHaveBeenCalled();
  });

  it('never starts by itself after a pick, even when the permission read lands later', async () => {
    platform.OS = 'android';
    const { hasAndroidBleScanPermissions } = await import('../../../lib/ble/use-ble-permissions');
    let answerCheck: (granted: boolean) => void = () => {};
    vi.mocked(hasAndroidBleScanPermissions).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answerCheck = resolve;
        }),
    );
    const { result } = renderPickerScan();

    act(() => result.current.stop());
    await act(async () => {
      answerCheck(true);
      await Promise.resolve();
    });

    expect(scan.start).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('tap_to_scan');
  });

  it('keeps the rows of an ended scan, and offers them as final once the lookup answered', async () => {
    const { result, rerender } = await scanning();
    scan.status = 'done';
    scan.lookup = 'pending';
    rerender({ focused: true, autoStart: true });
    expect(result.current.phase).toBe('scanning');
    // A serial heard last is still being looked up behind the drawn rows.
    scan.lookup = 'updating';
    rerender({ focused: true, autoStart: true });
    expect(result.current.phase).toBe('scanning');
    scan.lookup = 'resolved';
    rerender({ focused: true, autoStart: true });
    expect(result.current.phase).toBe('done');
  });

  it('keeps a start that waits on the Android permission dialog, which Android reports as the background', async () => {
    platform.OS = 'android';
    bluetooth.androidGranted = false;
    let answerDialog: () => void = () => {};
    scan.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answerDialog = resolve;
        }),
    );
    const { result } = renderPickerScan();
    await waitFor(() => expect(result.current.phase).toBe('needs_permission'));

    act(() => result.current.start());
    fireAppState('background');
    expect(scan.finish).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('scanning');
    fireAppState('active');
    await act(async () => {
      answerDialog();
      await Promise.resolve();
    });
    expect(scan.finish).not.toHaveBeenCalled();
  });

  it('drops a start still on its way when the picker loses focus', async () => {
    scan.start.mockImplementation(() => new Promise<void>(() => {}));
    const { rerender } = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    rerender({ focused: false, autoStart: true });
    expect(scan.finish).toHaveBeenCalled();
  });
});

describe('usePickerBoardScan after Settings', () => {
  it('gives an Android scan refused for permission a fresh start once the grant is back', async () => {
    platform.OS = 'android';
    scan.status = 'unavailable';
    scan.unavailableReason = 'unauthorized';
    const { result } = renderPickerScan({ focused: true, autoStart: false });
    await waitFor(() => expect(scan.reset).toHaveBeenCalledOnce());
    expect(result.current.phase).toBe('blocked_denied');
  });

  it('leaves a scan refused for permission alone while the grant is still missing', async () => {
    platform.OS = 'android';
    bluetooth.androidGranted = false;
    scan.status = 'unavailable';
    scan.unavailableReason = 'unauthorized';
    renderPickerScan();
    fireAppState('background');
    fireAppState('active');
    await act(async () => {
      await Promise.resolve();
    });
    expect(scan.reset).not.toHaveBeenCalled();
  });

  it('retries the lookup through the scan', () => {
    const { result } = renderPickerScan();
    act(() => result.current.retryLookup());
    expect(scan.retryLookup).toHaveBeenCalledOnce();
  });
});

// A start waits on the permission and the radio before it claims the scan. If
// the app went to the background meanwhile, starting the radio would spend one
// of Android's 5 scan starts per 30 s on a scan nobody sees.
describe('usePickerBoardScan never starts the radio in the background', () => {
  /** A start that waits until the test lets it reach the radio, where it asks the gate. */
  function startThatWaitsForRadio() {
    let reachRadio: () => void = () => {};
    scan.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          reachRadio = () => {
            if (scan.options?.mayStartRadio?.() !== false) scan.status = 'scanning';
            resolve();
          };
        }),
    );
    return { reachRadio: () => reachRadio() };
  }

  it('drops a start that reaches the radio in the background, and scans by itself once the app is back', async () => {
    const { reachRadio } = startThatWaitsForRadio();
    const { result } = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());

    fireAppState('background');
    await act(async () => {
      reachRadio();
      await Promise.resolve();
    });

    expect(scan.status).toBe('idle');
    expect(scan.finish).not.toHaveBeenCalled();
    expect(scan.start).toHaveBeenCalledOnce();

    scan.start.mockImplementation(async () => {
      scan.status = 'scanning';
    });
    fireAppState('active');
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto', 'picker_auto']));
    expect(result.current.phase).toBe('scanning');
  });

  // The Codex finding on #7576: Android's permission dialog reads as the
  // background, and its grant can land before AppState says 'active' again. A
  // start let through then would claim the radio and be finished at once by the
  // background rule, and the first scan after a grant would end empty.
  it('holds a start whose grant lands in the background, and scans once the app is active', async () => {
    platform.OS = 'android';
    bluetooth.androidGranted = false;
    const { reachRadio } = startThatWaitsForRadio();
    const { result } = renderPickerScan();
    await waitFor(() => expect(result.current.phase).toBe('needs_permission'));

    act(() => result.current.start());
    fireAppState('background');
    bluetooth.androidGranted = true;
    await act(async () => {
      reachRadio();
      await Promise.resolve();
    });

    // Held: the radio is untouched and the slot still reads as on its way.
    expect(scan.status).toBe('idle');
    expect(result.current.phase).toBe('scanning');

    scan.start.mockImplementation(async () => {
      scan.status = 'scanning';
    });
    fireAppState('active');
    await waitFor(() => expect(startTriggers()).toEqual(['picker_tap', 'picker_tap']));
    expect(result.current.phase).toBe('scanning');
    expect(scan.finish).not.toHaveBeenCalled();
  });

  it('holds a start that reaches the radio while iOS is inactive (the Bluetooth alert)', async () => {
    const { reachRadio } = startThatWaitsForRadio();
    renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());

    fireAppState('inactive');
    await act(async () => {
      reachRadio();
      await Promise.resolve();
    });
    expect(scan.status).toBe('idle');

    scan.start.mockImplementation(async () => {
      scan.status = 'scanning';
    });
    fireAppState('active');
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto', 'picker_auto']));
    expect(scan.finish).not.toHaveBeenCalled();
  });

  it('drops a held start when the picker loses focus, and runs nothing when the app comes back', async () => {
    const { reachRadio } = startThatWaitsForRadio();
    const { rerender } = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());

    fireAppState('background');
    await act(async () => {
      reachRadio();
      await Promise.resolve();
    });
    rerender({ focused: false, autoStart: true });
    fireAppState('active');
    await act(async () => {
      await Promise.resolve();
    });

    expect(scan.start).toHaveBeenCalledOnce();
    expect(scan.status).toBe('idle');
  });

  it('runs a held start by itself exactly once when the app comes back', async () => {
    const { reachRadio } = startThatWaitsForRadio();
    renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());

    fireAppState('background');
    await act(async () => {
      reachRadio();
      await Promise.resolve();
    });
    scan.start.mockImplementation(async () => {
      scan.status = 'scanning';
    });
    fireAppState('active');
    fireAppState('active');
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto', 'picker_auto']));
    await act(async () => {
      await Promise.resolve();
    });
    expect(startTriggers()).toEqual(['picker_auto', 'picker_auto']);
  });

  it('drops a held start on a pick', async () => {
    const { reachRadio } = startThatWaitsForRadio();
    const { result } = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());

    fireAppState('background');
    await act(async () => {
      reachRadio();
      await Promise.resolve();
    });
    act(() => result.current.stop());
    fireAppState('active');
    await act(async () => {
      await Promise.resolve();
    });

    expect(scan.start).toHaveBeenCalledOnce();
  });

  // A held start never reached the radio, so the next picker open within 30 s
  // still scans by itself.
  it('stamps no cooldown for a start that was held and dropped', async () => {
    const { reachRadio } = startThatWaitsForRadio();
    const first = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    fireAppState('background');
    await act(async () => {
      reachRadio();
      await Promise.resolve();
    });
    first.unmount();
    fireAppState('active');

    scan.start.mockReset().mockImplementation(async () => {
      scan.status = 'scanning';
    });
    renderPickerScan();
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto']));
  });

  it('lets a start through while the app is in the foreground', async () => {
    const { reachRadio } = startThatWaitsForRadio();
    renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    await act(async () => {
      reachRadio();
      await Promise.resolve();
    });
    expect(scan.status).toBe('scanning');
  });
});

// What the In range slot reads beside the phase: whether the serial lookup is
// still out, and whether the scan behind the rows listened long enough for a
// one-box row to mean one box (Fable F2).
describe('usePickerBoardScan for the rows', () => {
  it('says where the serial lookup stands', () => {
    scan.lookup = 'pending';
    const { result, rerender } = renderPickerScan({ focused: true, autoStart: false });
    expect(result.current.lookup).toBe('pending');

    scan.lookup = 'resolved';
    rerender({ focused: true, autoStart: false });
    expect(result.current.lookup).toBe('resolved');
  });

  it('trusts a one-box row only after 5 s of listening, or a scan that ran to its end', async () => {
    const { result, rerender } = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    rerender({ focused: true, autoStart: true });
    expect(result.current.listenedLongEnough()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current.listenedLongEnough()).toBe(true);
  });

  it('does not trust a one-box row from a scan a tap cut short at 2 s', async () => {
    const { result, rerender } = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    rerender({ focused: true, autoStart: true });

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    scan.status = 'done';
    rerender({ focused: true, autoStart: true });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.listenedLongEnough()).toBe(false);
  });

  it('has nothing to trust before any scan ran', () => {
    const { result } = renderPickerScan({ focused: true, autoStart: false });
    expect(result.current.listenedLongEnough()).toBe(false);
  });
});

// Bluetooth off: the radio coming on starts the scan, as Turn on Bluetooth
// (Android) or Control Center (iOS) were the climber's answer to the line.
describe('usePickerBoardScan with Bluetooth off', () => {
  function radioOffOnStart() {
    scan.start.mockReset().mockImplementation(async () => {
      scan.status = 'unavailable';
      scan.unavailableReason = 'powered_off';
    });
  }

  function radioComesOn() {
    act(() => {
      for (const listener of radioWatch.listeners.slice()) listener();
    });
  }

  it('scans once the radio reports on, reported as a tap', async () => {
    radioOffOnStart();
    const { result, rerender } = renderPickerScan();
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto']));
    rerender({ focused: true, autoStart: true });
    await waitFor(() => expect(result.current.phase).toBe('blocked_off'));
    expect(radioWatch.listeners).toHaveLength(1);

    scan.start.mockImplementation(async () => {
      scan.status = 'scanning';
    });
    radioComesOn();
    expect(startTriggers()).toEqual(['picker_auto', 'picker_tap']);
    rerender({ focused: true, autoStart: true });
    // Scanning: nothing listens for the radio any more.
    expect(radioWatch.listeners).toEqual([]);
  });

  it('does not listen for the radio while the picker is not on top', async () => {
    radioOffOnStart();
    const { rerender } = renderPickerScan();
    await waitFor(() => expect(scan.start).toHaveBeenCalledOnce());
    rerender({ focused: false, autoStart: true });
    expect(radioWatch.listeners).toEqual([]);
  });

  it('leaves the radio alone with auto-scan switched off: the line has Turn on and Scan again', async () => {
    scan.status = 'unavailable';
    scan.unavailableReason = 'powered_off';
    const { result } = renderPickerScan({ focused: true, autoStart: false });
    expect(result.current.phase).toBe('blocked_off');
    expect(radioWatch.subscriptions).toBe(0);
  });

  it('starts nothing after a pick, until the next tap', async () => {
    radioOffOnStart();
    const { result, rerender } = renderPickerScan();
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto']));
    rerender({ focused: true, autoStart: true });
    await waitFor(() => expect(result.current.phase).toBe('blocked_off'));

    act(() => result.current.stop());
    rerender({ focused: true, autoStart: true });
    // Still listening: the pick, not a missing listener, is what starts nothing.
    expect(radioWatch.listeners).toHaveLength(1);
    radioComesOn();
    expect(startTriggers()).toEqual(['picker_auto']);
  });

  // Android's Turn on dialog reads as the background: the radio's report lands
  // there, and the start waits for the app. Past a minute the climber has moved on.
  it.each<{ name: string; heldMs: number; runs: boolean }>([
    { name: 'runs a held radio start when the app is back within a minute', heldMs: 20_000, runs: true },
    { name: 'drops a held radio start older than a minute', heldMs: 61_000, runs: false },
  ])('$name', async ({ heldMs, runs }) => {
    radioOffOnStart();
    const { result, rerender } = renderPickerScan();
    await waitFor(() => expect(startTriggers()).toEqual(['picker_auto']));
    rerender({ focused: true, autoStart: true });
    await waitFor(() => expect(result.current.phase).toBe('blocked_off'));

    // The radio's start gets through its checks while the app is in the background.
    appState.currentState = 'background';
    scan.start.mockImplementation(async () => {
      scan.options?.mayStartRadio?.();
    });
    radioComesOn();
    await act(async () => {});
    expect(startTriggers()).toEqual(['picker_auto', 'picker_tap']);

    scan.start.mockImplementation(async () => {
      scan.status = 'scanning';
    });
    act(() => {
      vi.advanceTimersByTime(heldMs);
    });
    fireAppState('active');
    await act(async () => {});
    expect(startTriggers()).toEqual(runs ? ['picker_auto', 'picker_tap', 'picker_tap'] : ['picker_auto', 'picker_tap']);
  });

  it('starts nothing twice when a tap already started the scan', async () => {
    scan.status = 'unavailable';
    scan.unavailableReason = 'powered_off';
    // A start that waits on the radio, so it is still on its way when the report lands.
    scan.start.mockReset().mockImplementation(() => new Promise<void>(() => {}));
    const { result } = renderPickerScan();
    expect(radioWatch.listeners).toHaveLength(1);
    act(() => result.current.start());
    radioComesOn();
    expect(startTriggers()).toEqual(['picker_tap']);
  });
});
