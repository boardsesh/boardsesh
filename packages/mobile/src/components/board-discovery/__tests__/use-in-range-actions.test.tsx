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
const radio = vi.hoisted(() => ({ outcome: 'asked' as 'asked' | 'already_on', turnOn: vi.fn(), poweredOn: false }));
vi.mock('../bluetooth-radio', () => ({
  turnOnBluetooth: async () => {
    radio.turnOn();
    return radio.outcome;
  },
  isBluetoothPoweredOn: async () => radio.poweredOn,
}));

const { useInRangeActions } = await import('../use-in-range-actions');
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

function renderActions() {
  return renderHook(() =>
    useInRangeActions({
      scan,
      router: router as unknown as Parameters<typeof useInRangeActions>[0]['router'],
      chooseFirstBoardPath,
      dropHeldBox,
      boardReturnTo: '/(tabs)/climbs',
      source: undefined,
      gymFirstEnabled: false,
    }),
  ).result.current;
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
  radio.poweredOn = false;
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

  it('holds no box for a serial row: the serial already names it', () => {
    renderActions().onOwnBoard(unknownKilter(['751737']));
    expect(held.set).not.toHaveBeenCalled();
    expect(dropHeldBox).toHaveBeenCalledOnce();
  });
});

describe('Turn on Bluetooth', () => {
  it('asks the system, then scans when the app comes back with the radio on', async () => {
    renderActions().onTurnOnBluetooth();
    await act(async () => {});
    expect(radio.turnOn).toHaveBeenCalledOnce();
    expect(scan.start).not.toHaveBeenCalled();
    expect(chooseFirstBoardPath).toHaveBeenCalledWith('scan');

    radio.poweredOn = true;
    fireAppState('background');
    expect(appState.handlers).toHaveLength(1);
    await act(async () => fireAppState('active'));
    expect(scan.start).toHaveBeenCalledOnce();
    // Read once: a later return to the app starts nothing.
    expect(appState.handlers).toEqual([]);
  });

  it('starts nothing when the climber came back with the radio still off', async () => {
    renderActions().onTurnOnBluetooth();
    await act(async () => {});
    await act(async () => fireAppState('active'));
    expect(scan.start).not.toHaveBeenCalled();
  });

  it('scans straight away when the radio is already on', async () => {
    radio.outcome = 'already_on';
    renderActions().onTurnOnBluetooth();
    await act(async () => {});
    expect(scan.start).toHaveBeenCalledOnce();
  });
});
