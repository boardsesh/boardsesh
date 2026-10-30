import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredLastConnectedBoard } from '../last-connected-board-store';

// The per-board device handles behind a walk between boards at a gym (#7076).

const mockPreferences = vi.hoisted(() => ({
  stored: undefined as unknown,
  getPreference: vi.fn(async () => mockPreferences.stored),
  setPreference: vi.fn(async (_key: string, value: unknown) => {
    mockPreferences.stored = value;
  }),
}));
vi.mock('../../preference-store', () => ({
  getPreference: mockPreferences.getPreference,
  setPreference: mockPreferences.setPreference,
}));

import {
  findKnownBoardDevice,
  forgetKnownBoardDevice,
  getStoredKnownBoardDevices,
  MAX_KNOWN_BOARD_DEVICES,
  rememberKnownBoardDevice,
  setStoredKnownBoardDevices,
  type KnownBoardDevices,
} from '../known-board-devices-store';

const KILTER: StoredLastConnectedBoard = { configKey: 'kilter::1::10::gym-kilter', serial: 'K-1' };
const MOONBOARD: StoredLastConnectedBoard = { configKey: 'moonboard::2::1::gym-moon', deviceId: 'moon-device' };
const TENSION: StoredLastConnectedBoard = { configKey: 'tension::9::1::gym-tension', serial: 'T-1' };

function boardNumber(index: number): StoredLastConnectedBoard {
  return { configKey: `kilter::1::${index}::wall-${index}`, serial: `S-${index}` };
}

beforeEach(() => {
  mockPreferences.stored = undefined;
  mockPreferences.getPreference.mockClear();
  mockPreferences.setPreference.mockClear();
});

describe('findKnownBoardDevice', () => {
  it('finds the handle remembered for a board, and nothing for another board or no key', () => {
    const devices = [KILTER, MOONBOARD];
    expect(findKnownBoardDevice(devices, MOONBOARD.configKey)).toBe(MOONBOARD);
    expect(findKnownBoardDevice(devices, TENSION.configKey)).toBeNull();
    expect(findKnownBoardDevice(devices, null)).toBeNull();
  });
});

describe('rememberKnownBoardDevice', () => {
  it('puts a new board first', () => {
    expect(rememberKnownBoardDevice([KILTER], MOONBOARD)).toEqual([MOONBOARD, KILTER]);
  });

  it('replaces the handle for the same board and moves it first', () => {
    const swappedController = { configKey: KILTER.configKey, serial: 'K-2' };
    expect(rememberKnownBoardDevice([MOONBOARD, KILTER, TENSION], swappedController)).toEqual([
      swappedController,
      MOONBOARD,
      TENSION,
    ]);
  });

  it(`keeps the newest ${MAX_KNOWN_BOARD_DEVICES} boards and drops the oldest`, () => {
    let devices: KnownBoardDevices = [];
    for (let index = 0; index <= MAX_KNOWN_BOARD_DEVICES; index += 1) {
      devices = rememberKnownBoardDevice(devices, boardNumber(index));
    }
    expect(devices).toHaveLength(MAX_KNOWN_BOARD_DEVICES);
    expect(devices[0]).toEqual(boardNumber(MAX_KNOWN_BOARD_DEVICES));
    expect(findKnownBoardDevice(devices, boardNumber(0).configKey)).toBeNull();
    expect(findKnownBoardDevice(devices, boardNumber(1).configKey)).toEqual(boardNumber(1));
  });
});

describe('forgetKnownBoardDevice', () => {
  it('drops only that board, keeping the others in order', () => {
    expect(forgetKnownBoardDevice([KILTER, MOONBOARD, TENSION], MOONBOARD.configKey)).toEqual([KILTER, TENSION]);
  });

  it('hands back the same list when the board was never remembered', () => {
    const devices = [KILTER, MOONBOARD];
    expect(forgetKnownBoardDevice(devices, TENSION.configKey)).toBe(devices);
  });
});

describe('getStoredKnownBoardDevices', () => {
  it('round-trips what was written', async () => {
    await setStoredKnownBoardDevices([MOONBOARD, KILTER]);
    await expect(getStoredKnownBoardDevices()).resolves.toEqual([MOONBOARD, KILTER]);
  });

  it.each([
    ['nothing stored', undefined],
    ['not an array', { configKey: KILTER.configKey, serial: 'K-1' }],
  ])('reads %s as no boards', async (_case, stored) => {
    mockPreferences.stored = stored;
    await expect(getStoredKnownBoardDevices()).resolves.toEqual([]);
  });

  it('drops an entry with both handles, with no handle, with a non-string handle or no key', async () => {
    mockPreferences.stored = [
      { configKey: 'both', serial: 'S', deviceId: 'D' },
      { configKey: 'neither' },
      { configKey: 'numeric-serial', serial: 42 },
      { serial: 'no-key' },
      null,
      'kilter',
      KILTER,
    ];
    await expect(getStoredKnownBoardDevices()).resolves.toEqual([KILTER]);
  });

  it('keeps the first (newest) entry for a board stored twice', async () => {
    const olderKilter = { configKey: KILTER.configKey, serial: 'K-old' };
    mockPreferences.stored = [KILTER, MOONBOARD, olderKilter];
    await expect(getStoredKnownBoardDevices()).resolves.toEqual([KILTER, MOONBOARD]);
  });

  it(`reads back no more than ${MAX_KNOWN_BOARD_DEVICES} boards`, async () => {
    mockPreferences.stored = Array.from({ length: MAX_KNOWN_BOARD_DEVICES + 3 }, (_, index) => boardNumber(index));
    const devices = await getStoredKnownBoardDevices();
    expect(devices).toHaveLength(MAX_KNOWN_BOARD_DEVICES);
    expect(devices[0]).toEqual(boardNumber(0));
  });
});
