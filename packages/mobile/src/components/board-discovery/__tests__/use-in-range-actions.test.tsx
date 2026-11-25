// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PickerScan } from '../use-picker-board-scan';
import type { UnnamedInRangeRow } from '../picker-top-view';

// The In range slot's buttons: which route each opens, with what, and Turn on
// Bluetooth. The serial rule itself is quickstart-scan-rows.test.ts's; here,
// that the builder gets it as its `serial` param, and only then.

const appState = vi.hoisted(() => ({ handlers: [] as Array<(state: string) => void> }));
vi.mock('react-native', () => ({
  AppState: {
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
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/open-app-settings', () => ({ openAppSettings: vi.fn(async () => true) }));
const held = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('../../../lib/boards/pending-board-recognition', () => ({ setPendingBoardRecognition: held.set }));
const radio = vi.hoisted(() => ({
  outcome: 'asked' as 'asked' | 'already_on',
  turnOn: vi.fn(),
  // Who watches for the radio coming on, and a way to say it did.
  watchers: [] as Array<() => void>,
}));
vi.mock('../bluetooth-radio', () => ({
  turnOnBluetooth: async () => {
    radio.turnOn();
    return radio.outcome;
  },
  watchBluetoothPoweredOn: (onPoweredOn: () => void) => {
    radio.watchers.push(onPoweredOn);
    return () => {
      radio.watchers = radio.watchers.filter((watcher) => watcher !== onPoweredOn);
    };
  },
}));

const { RADIO_RETURN_WATCH_MS, useInRangeActions } = await import('../use-in-range-actions');
const { clearHeardSerialOffer, isHeardSerialOffered } = await import('../../../lib/boards/heard-serial-offer');

const scanCtrl = { listenedLongEnough: true };
const scan: PickerScan = {
  phase: 'done',
  rows: [],
  lookup: 'resolved',
  listenedLongEnough: () => scanCtrl.listenedLongEnough,
  start: vi.fn(),
  stop: vi.fn(),
  openSettings: vi.fn(),
  retryLookup: vi.fn(),
};
const router = { push: vi.fn() };
const chooseFirstBoardPath = vi.fn();
const dropHeldBox = vi.fn();

function renderActionsHook(wizardEnabled = false) {
  return renderHook(() =>
    useInRangeActions({
      scan,
      router: router as unknown as Parameters<typeof useInRangeActions>[0]['router'],
      chooseFirstBoardPath,
      dropHeldBox,
      boardReturnTo: '/(tabs)/climbs',
      source: undefined,
      wizardEnabled,
    }),
  );
}

function renderActions(wizardEnabled = false) {
  return renderActionsHook(wizardEnabled).result.current;
}

function radioComesOn() {
  for (const watcher of radio.watchers.slice()) watcher();
}

function unknownKilter(serials: string[]): UnnamedInRangeRow {
  return {
    kind: 'unknown_setup',
    key: 'unknown_setup:kilter',
    boardType: 'kilter',
    rssi: -50,
    serials,
    serialLessBoxCount: 0,
  };
}

function pushedParams(): Record<string, string> {
  const [[route]] = router.push.mock.calls as [[{ pathname: string; params: Record<string, string> }]];
  expect(route.pathname).toBe('/boards/create');
  return route.params;
}

function fireAppState(nextState: string) {
  for (const handler of appState.handlers.slice()) handler(nextState);
}

beforeEach(() => {
  appState.handlers = [];
  radio.watchers = [];
  clearHeardSerialOffer();
  scanCtrl.listenedLongEnough = true;
  radio.outcome = 'asked';
  radio.turnOn.mockClear();
  held.set.mockClear();
  router.push.mockClear();
  chooseFirstBoardPath.mockClear();
  dropHeldBox.mockClear();
  vi.mocked(scan.start).mockClear();
  vi.mocked(scan.stop).mockClear();
});

describe("It's my own board", () => {
  it('opens the builder on the type with the one unsaved serial heard', () => {
    renderActions().onOwnBoard(unknownKilter(['751737']));
    expect(pushedParams()).toEqual({
      returnTo: '/(tabs)/climbs',
      preset: '1',
      presetBoardType: 'kilter',
      serial: '751737',
    });
    expect(scan.stop).toHaveBeenCalledOnce();
    // The builder trusts the param only because the picker offered it.
    expect(isHeardSerialOffered({ serial: '751737', boardType: 'kilter' })).toBe(true);
    expect(isHeardSerialOffered({ serial: '751737', boardType: 'tension' })).toBe(false);
  });

  it('withdraws an earlier offer when the next row offers none', () => {
    const actions = renderActions();
    actions.onOwnBoard(unknownKilter(['751737']));
    actions.onOwnBoard(unknownKilter(['751737', '800001']));
    expect(isHeardSerialOffered({ serial: '751737', boardType: 'kilter' })).toBe(false);
  });

  it.each<{ name: string; serials: string[]; listenedLongEnough: boolean }>([
    { name: 'two boxes of the type', serials: ['751737', '800001'], listenedLongEnough: true },
    { name: 'no serial', serials: [], listenedLongEnough: true },
    { name: 'a scan cut short', serials: ['751737'], listenedLongEnough: false },
  ])('leaves the serial out with $name', ({ serials, listenedLongEnough }) => {
    scanCtrl.listenedLongEnough = listenedLongEnough;
    renderActions().onOwnBoard(unknownKilter(serials));
    expect(pushedParams()).not.toHaveProperty('serial');
  });

  it('never sends a serial for a MoonBoard, and still holds its box', () => {
    renderActions().onOwnBoard({
      kind: 'moonboard',
      key: 'moonboard:moonboard',
      boardType: 'moonboard',
      rssi: -50,
      deviceId: 'MOON',
    });
    expect(pushedParams()).toEqual({ returnTo: '/(tabs)/climbs', preset: '1', presetBoardType: 'moonboard' });
    expect(held.set).toHaveBeenCalledWith({ deviceId: 'MOON', boardType: 'moonboard' });
  });

  // With the add-a-board wizard on, the button said home and the scan heard the
  // type: the wizard's Set up opens directly, its only counted screen.
  it("opens the wizard's Set up with the type and the heard serial, skipping Where and Which board", () => {
    renderActions(true).onOwnBoard(unknownKilter(['751737']));
    expect(pushedParams()).toEqual({
      returnTo: '/(tabs)/climbs',
      entry: 'in_range',
      path: 'home',
      kind: 'home',
      preset: '1',
      presetBoardType: 'kilter',
      serial: '751737',
    });
    expect(isHeardSerialOffered({ serial: '751737', boardType: 'kilter' })).toBe(true);
  });

  it('holds no box for a serial row: the serial already names it', () => {
    renderActions().onOwnBoard(unknownKilter(['751737']));
    expect(held.set).not.toHaveBeenCalled();
    expect(dropHeldBox).toHaveBeenCalledOnce();
  });
});

describe('Turn on Bluetooth', () => {
  it('asks the system, then watches the radio when the app comes back and scans once it is on', async () => {
    renderActions().onTurnOnBluetooth();
    await act(async () => {});
    expect(radio.turnOn).toHaveBeenCalledOnce();
    expect(scan.start).not.toHaveBeenCalled();
    expect(chooseFirstBoardPath).toHaveBeenCalledWith('scan');

    fireAppState('background');
    expect(radio.watchers).toEqual([]);
    act(() => fireAppState('active'));
    expect(appState.handlers).toEqual([]);
    // Still Resetting on return: nothing yet, the watch waits for it.
    expect(radio.watchers).toHaveLength(1);
    expect(scan.start).not.toHaveBeenCalled();
    act(() => radioComesOn());
    expect(scan.start).toHaveBeenCalledOnce();
    expect(radio.watchers).toEqual([]);
  });

  it('stops watching after a while with the radio still off', async () => {
    vi.useFakeTimers();
    try {
      renderActions().onTurnOnBluetooth();
      await act(async () => {});
      act(() => fireAppState('active'));
      expect(radio.watchers).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(RADIO_RETURN_WATCH_MS + 1);
      });
      expect(radio.watchers).toEqual([]);
      expect(scan.start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers nothing and starts nothing once the picker is gone', async () => {
    const { result, unmount } = renderActionsHook();
    result.current.onTurnOnBluetooth();
    unmount();
    await act(async () => {});
    expect(appState.handlers).toEqual([]);

    radio.outcome = 'already_on';
    const second = renderActionsHook();
    second.result.current.onTurnOnBluetooth();
    second.unmount();
    await act(async () => {});
    expect(scan.start).not.toHaveBeenCalled();
  });

  it('drops the watch when the picker goes while it waits', async () => {
    const { result, unmount } = renderActionsHook();
    result.current.onTurnOnBluetooth();
    await act(async () => {});
    act(() => fireAppState('active'));
    expect(radio.watchers).toHaveLength(1);
    unmount();
    expect(radio.watchers).toEqual([]);
  });

  it('scans straight away when the radio is already on', async () => {
    radio.outcome = 'already_on';
    renderActions().onTurnOnBluetooth();
    await act(async () => {});
    expect(scan.start).toHaveBeenCalledOnce();
  });
});
