// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { RecognizedBoardDevice } from '../recognized-board-devices-store';

// Which board a serial-less box is, as this phone learned it: the identity the
// board picker's in-range rows name a MoonBoard or bare Kilter box by.

const RECOGNIZED_KEY = 'boardsesh_recognized_board_devices_v1';

const mockPreferences = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  failReads: false,
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  removePreference: vi.fn(),
}));
vi.mock('../../preference-store', () => ({
  getPreference: mockPreferences.getPreference,
  setPreference: mockPreferences.setPreference,
  removePreference: mockPreferences.removePreference,
}));

type StoreModule = typeof import('../recognized-board-devices-store');
let store: StoreModule;

function entry(deviceId: string, boardUuid: string, savedAt = 1): RecognizedBoardDevice {
  return { deviceId, boardUuid, boardType: 'moonboard', savedAt };
}

function storedList(): unknown {
  return mockPreferences.stored.get(RECOGNIZED_KEY);
}

beforeEach(async () => {
  mockPreferences.stored = new Map();
  mockPreferences.failReads = false;
  mockPreferences.getPreference.mockReset().mockImplementation(async (key: string) => {
    if (mockPreferences.failReads) throw new Error('storage locked before first unlock');
    return mockPreferences.stored.get(key) ?? null;
  });
  mockPreferences.setPreference.mockReset().mockImplementation(async (key: string, value: unknown) => {
    mockPreferences.stored.set(key, value);
  });
  mockPreferences.removePreference.mockReset().mockImplementation(async (key: string) => {
    mockPreferences.stored.delete(key);
  });
  // The store keeps its list in module state: a fresh module per test.
  vi.resetModules();
  store = await import('../recognized-board-devices-store');
});

describe('recognised device list rules', () => {
  it('puts a new binding first and replaces what the same id named before', () => {
    const devices = [entry('A', 'board-1'), entry('B', 'board-2')];
    const next = store.withRecognizedBoardDevice(devices, entry('B', 'board-3', 2));
    expect(next.map((device) => `${device.deviceId}:${device.boardUuid}`)).toEqual(['B:board-3', 'A:board-1']);
  });

  it('lets one board keep several ids', () => {
    const next = store.withRecognizedBoardDevice([entry('A', 'board-1')], entry('B', 'board-1'));
    expect(next).toHaveLength(2);
  });

  it(`keeps the newest ${32}`, () => {
    let devices: ReadonlyArray<RecognizedBoardDevice> = [];
    for (let index = 0; index < 40; index += 1) {
      devices = store.withRecognizedBoardDevice(devices, entry(`ID-${index}`, `board-${index}`, index));
    }
    expect(devices).toHaveLength(store.MAX_RECOGNIZED_BOARD_DEVICES);
    expect(store.MAX_RECOGNIZED_BOARD_DEVICES).toBe(32);
    expect(devices[0].deviceId).toBe('ID-39');
    expect(devices.at(-1)?.deviceId).toBe('ID-8');
  });

  it.each([
    { name: 'forgets an id that names the board', boardUuid: 'board-1', deviceId: 'A', left: ['B'] },
    { name: 'forgets whatever case the id comes in', boardUuid: 'board-1', deviceId: 'a', left: ['B'] },
    { name: 'keeps an id that names another board', boardUuid: 'board-9', deviceId: 'A', left: ['A', 'B'] },
    { name: 'keeps every id when the id is unknown', boardUuid: 'board-1', deviceId: 'Z', left: ['A', 'B'] },
  ])('$name', ({ boardUuid, deviceId, left }) => {
    const devices = [entry('A', 'board-1'), entry('B', 'board-2')];
    const next = store.withoutRecognizedBoardDevice(devices, deviceId, boardUuid);
    expect(next.map((device) => device.deviceId)).toEqual(left);
    if (left.length === devices.length) expect(next).toBe(devices);
  });

  it('reads back only well-formed entries, once per id, upper-cased', () => {
    const parsed = store.parseRecognizedBoardDevices([
      entry('aa:bb', 'board-1'),
      entry('AA:BB', 'board-2'),
      { deviceId: 'C', boardUuid: '', boardType: 'moonboard', savedAt: 1 },
      { deviceId: 'D', boardUuid: 'board-4', boardType: 'not-a-board', savedAt: 1 },
      { deviceId: 'E', boardUuid: 'board-5', boardType: 'kilter', savedAt: Number.NaN },
      'junk',
      null,
      entry('F', 'board-6'),
    ]);
    expect(parsed.map((device) => `${device.deviceId}:${device.boardUuid}`)).toEqual(['AA:BB:board-1', 'F:board-6']);
    expect(store.parseRecognizedBoardDevices({ not: 'a list' })).toEqual([]);
  });
});

describe('recognised device storage', () => {
  it('remembers a binding, newest first, on top of what was stored', async () => {
    mockPreferences.stored.set(RECOGNIZED_KEY, [entry('OLD', 'board-0')]);
    await store.rememberRecognizedBoardDevice('mb-1', { uuid: 'home-moon', boardType: 'moonboard' });

    expect(storedList()).toEqual([
      { deviceId: 'MB-1', boardUuid: 'home-moon', boardType: 'moonboard', savedAt: expect.any(Number) },
      entry('OLD', 'board-0'),
    ]);
  });

  it.each([
    { name: 'a board with no uuid (a signed-out serial lookup)', board: { uuid: '', boardType: 'moonboard' } },
    { name: 'a board of an unknown type', board: { uuid: 'home-moon', boardType: 'not-a-board' } },
  ])('ignores $name', async ({ board }) => {
    await store.rememberRecognizedBoardDevice('mb-1', board);
    expect(mockPreferences.setPreference).not.toHaveBeenCalled();
  });

  it('forgets an id after a wrong-box connect to its board, and only then', async () => {
    mockPreferences.stored.set(RECOGNIZED_KEY, [entry('MB-1', 'home-moon'), entry('MB-2', 'gym-moon')]);

    await store.forgetRecognizedBoardDevice('mb-2', 'home-moon');
    expect(mockPreferences.setPreference).not.toHaveBeenCalled();

    await store.forgetRecognizedBoardDevice('mb-1', 'home-moon');
    expect(storedList()).toEqual([entry('MB-2', 'gym-moon')]);
  });

  it('forgets nothing for a board with no uuid', async () => {
    mockPreferences.stored.set(RECOGNIZED_KEY, [entry('MB-1', 'home-moon')]);
    await store.forgetRecognizedBoardDevice('mb-1', undefined);
    expect(mockPreferences.getPreference).not.toHaveBeenCalled();
    expect(storedList()).toEqual([entry('MB-1', 'home-moon')]);
  });

  it('clears every id, stored and in memory, at sign-out', async () => {
    mockPreferences.stored.set(RECOGNIZED_KEY, [entry('MB-1', 'home-moon')]);
    const { result } = renderHook(() => store.useRecognizedBoardDevices(true));
    await waitFor(() => expect(result.current).toHaveLength(1));

    await act(async () => {
      await store.clearRecognizedBoardDevices();
    });

    expect(mockPreferences.removePreference).toHaveBeenCalledWith(RECOGNIZED_KEY);
    expect(storedList()).toBeUndefined();
    expect(result.current).toEqual([]);
  });

  it('does not bring a cleared list back from a read that was already queued', async () => {
    mockPreferences.stored.set(RECOGNIZED_KEY, [entry('MB-1', 'home-moon')]);
    const load = store.loadRecognizedBoardDevices();
    const clear = store.clearRecognizedBoardDevices();
    await Promise.all([load, clear]);
    await store.rememberRecognizedBoardDevice('mb-2', { uuid: 'gym-moon', boardType: 'moonboard' });

    expect(storedList()).toEqual([expect.objectContaining({ deviceId: 'MB-2', boardUuid: 'gym-moon' })]);
  });

  it('counts a failed read as empty when a binding lands, and never rejects', async () => {
    mockPreferences.stored.set(RECOGNIZED_KEY, [entry('OLD', 'board-0')]);
    mockPreferences.failReads = true;

    await expect(
      store.rememberRecognizedBoardDevice('mb-1', { uuid: 'home-moon', boardType: 'moonboard' }),
    ).resolves.toBeUndefined();

    expect(storedList()).toEqual([expect.objectContaining({ deviceId: 'MB-1' })]);
  });

  it('reads again after a failed read that changed nothing', async () => {
    mockPreferences.stored.set(RECOGNIZED_KEY, [entry('MB-1', 'home-moon')]);
    mockPreferences.failReads = true;
    await store.loadRecognizedBoardDevices();
    mockPreferences.failReads = false;

    const { result } = renderHook(() => store.useRecognizedBoardDevices(true));

    await waitFor(() => expect(result.current).toEqual([entry('MB-1', 'home-moon')]));
    expect(mockPreferences.getPreference).toHaveBeenCalledTimes(2);
  });

  it('never rejects when storage fails to write', async () => {
    mockPreferences.setPreference.mockRejectedValue(new Error('disk full'));
    await expect(
      store.rememberRecognizedBoardDevice('mb-1', { uuid: 'home-moon', boardType: 'moonboard' }),
    ).resolves.toBeUndefined();
    mockPreferences.removePreference.mockRejectedValue(new Error('disk full'));
    await expect(store.clearRecognizedBoardDevices()).resolves.toBeUndefined();
  });
});

describe('useRecognizedBoardDevices', () => {
  it('loads the stored list and follows later bindings', async () => {
    mockPreferences.stored.set(RECOGNIZED_KEY, [entry('MB-1', 'home-moon')]);
    const { result } = renderHook(() => store.useRecognizedBoardDevices(true));
    await waitFor(() => expect(result.current).toHaveLength(1));

    await act(async () => {
      await store.rememberRecognizedBoardDevice('kb-1', { uuid: 'gym-kilter', boardType: 'kilter' });
    });

    expect(result.current.map((device) => device.deviceId)).toEqual(['KB-1', 'MB-1']);
  });

  it('reads nothing while switched off', async () => {
    mockPreferences.stored.set(RECOGNIZED_KEY, [entry('MB-1', 'home-moon')]);
    const { result } = renderHook(() => store.useRecognizedBoardDevices(false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
    expect(mockPreferences.getPreference).not.toHaveBeenCalled();
  });
});
