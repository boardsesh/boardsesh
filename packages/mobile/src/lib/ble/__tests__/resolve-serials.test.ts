import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  GET_BOARDS_BY_SERIAL_NUMBERS,
  GET_MY_BOARD_SERIAL_CONFIGS,
  type BoardSerialConfig,
} from '@boardsesh/graphql/operations';

const harness = vi.hoisted(() => ({
  authToken: null as string | null,
  request: vi.fn(),
}));

vi.mock('../../auth-store', () => ({
  getAuthToken: vi.fn(() => Promise.resolve(harness.authToken)),
}));

vi.mock('../../graphql/client', () => ({
  getHttpClient: () => ({ request: harness.request }),
}));

vi.mock('../../graphql/use-auth-token', () => ({
  useAuthToken: vi.fn(() => ({ data: null })),
}));

import {
  advertisedBoardTypesBySerial,
  resolveBleSerialNumbers,
  serialsFromDiscoveredDevices,
} from '../resolve-serials';

function makeBoard(serialNumber: string, overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: `board-${serialNumber}`,
    slug: `board-${serialNumber}`,
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: `Board ${serialNumber}`,
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
    serialNumber,
    ...overrides,
  };
}

function makeConfig(serialNumber: string, overrides: Partial<BoardSerialConfig> = {}): BoardSerialConfig {
  return {
    serialNumber,
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    apiLevel: 3,
    updatedAt: '2026-01-02T00:00:00.000Z',
    boardUuid: null,
    boardSlug: null,
    ...overrides,
  };
}

beforeEach(() => {
  harness.authToken = null;
  harness.request.mockReset();
});

describe('serialsFromDiscoveredDevices', () => {
  it('extracts unique serials from BLE device names and caps at 20', () => {
    const devices = Array.from({ length: 22 }, (_unused, deviceIndex) => ({
      deviceId: `device-${deviceIndex}`,
      name: `Kilter Board#SN-${deviceIndex}@3`,
      rssi: -40,
    }));
    devices.push({ deviceId: 'duplicate', name: 'Kilter Board#SN-1@3', rssi: -30 });

    const serialNumbers = serialsFromDiscoveredDevices(devices);

    expect(serialNumbers).toHaveLength(20);
    expect(serialNumbers[0]).toBe('SN-0');
    expect(serialNumbers.at(-1)).toBe('SN-19');
  });
});

describe('resolveBleSerialNumbers', () => {
  it('resolves saved boards and lets saved boards win over recorded configs', async () => {
    harness.authToken = 'token-1';
    const savedBoard = makeBoard('SN-1', { name: 'Saved board' });
    const recordedConfig = makeConfig('SN-1', { boardName: 'tension' });
    harness.request.mockImplementation((operation: unknown) => {
      if (operation === GET_BOARDS_BY_SERIAL_NUMBERS) {
        return Promise.resolve({ boardsBySerialNumbers: [savedBoard] });
      }
      if (operation === GET_MY_BOARD_SERIAL_CONFIGS) {
        return Promise.resolve({ myBoardSerialConfigs: [recordedConfig, makeConfig('SN-2')] });
      }
      return Promise.reject(new Error('Unexpected operation'));
    });

    const resolvedBoards = await resolveBleSerialNumbers(['SN-1', 'SN-2']);

    expect(resolvedBoards.get('SN-1')).toEqual({ kind: 'saved', board: savedBoard });
    expect(resolvedBoards.get('SN-2')).toEqual({ kind: 'recorded', config: makeConfig('SN-2') });
  });

  it('skips recorded configs when signed out', async () => {
    harness.request.mockImplementation((operation: unknown) => {
      if (operation === GET_BOARDS_BY_SERIAL_NUMBERS) {
        return Promise.resolve({ boardsBySerialNumbers: [] });
      }
      if (operation === GET_MY_BOARD_SERIAL_CONFIGS) {
        return Promise.resolve({ myBoardSerialConfigs: [makeConfig('SN-1')] });
      }
      return Promise.reject(new Error('Unexpected operation'));
    });

    const resolvedBoards = await resolveBleSerialNumbers(['SN-1']);

    expect(resolvedBoards.size).toBe(0);
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(harness.request).toHaveBeenCalledWith(GET_BOARDS_BY_SERIAL_NUMBERS, {
      serialNumbers: ['SN-1'],
      boardType: undefined,
    });
  });

  it('uses the provided auth token instead of reading storage', async () => {
    harness.request.mockImplementation((operation: unknown) => {
      if (operation === GET_BOARDS_BY_SERIAL_NUMBERS) {
        return Promise.resolve({ boardsBySerialNumbers: [] });
      }
      if (operation === GET_MY_BOARD_SERIAL_CONFIGS) {
        return Promise.resolve({ myBoardSerialConfigs: [makeConfig('SN-1')] });
      }
      return Promise.reject(new Error('Unexpected operation'));
    });

    const resolvedBoards = await resolveBleSerialNumbers(['SN-1'], 'token-from-hook');

    expect(resolvedBoards.get('SN-1')).toEqual({ kind: 'recorded', config: makeConfig('SN-1') });
    expect(harness.request).toHaveBeenCalledTimes(2);
  });
});

/**
 * Aurora numbers each board app separately, so a serial identifies a controller
 * only WITHIN a board type: a Kilter `#12345` and a Tension `#12345` are
 * different hardware. Reported from Benchmark Climbing, where connecting the
 * gym's Tension board resolved onto a stranger's Kilter board that shared the
 * serial, so every connect announced it as a Kilter board.
 */
describe('advertisedBoardTypesBySerial', () => {
  it('reads the board type out of each device name', () => {
    const advertisedTypes = advertisedBoardTypesBySerial([
      { deviceId: 'a', name: 'Tension Board#12345@3', rssi: -40 },
      { deviceId: 'b', name: 'Kilter Board#99@3', rssi: -50 },
    ]);

    expect(advertisedTypes.get('12345')).toBe('tension');
    expect(advertisedTypes.get('99')).toBe('kilter');
  });

  it('omits serials whose name carries no recognisable board type', () => {
    // Absent, not null: an unknown type must not be treated as a mismatch, or a
    // real board would be filtered out of the picker.
    const advertisedTypes = advertisedBoardTypesBySerial([
      { deviceId: 'a', name: 'Mystery Box#12345@3', rssi: -40 },
      { deviceId: 'b', rssi: -50 },
    ]);

    expect(advertisedTypes.size).toBe(0);
  });
});

describe('resolveBleSerialNumbers — advertised board type', () => {
  const tensionDevices = [{ deviceId: 'a', name: 'Tension Board#SN-1@3', rssi: -40 }];

  function mockLookup(boards: UserBoard[], configs: BoardSerialConfig[] = []) {
    harness.request.mockImplementation((operation: unknown) => {
      if (operation === GET_BOARDS_BY_SERIAL_NUMBERS) return Promise.resolve({ boardsBySerialNumbers: boards });
      if (operation === GET_MY_BOARD_SERIAL_CONFIGS) return Promise.resolve({ myBoardSerialConfigs: configs });
      return Promise.reject(new Error('Unexpected operation'));
    });
  }

  it('drops a saved board whose type is not what the controller advertised', async () => {
    // The Benchmark case: the backend still returns the Kilter board (an older
    // deployment ignores the boardType argument), so the client has to refuse it.
    mockLookup([makeBoard('SN-1', { boardType: 'kilter', name: 'Someone else Kilter' })]);

    const resolvedBoards = await resolveBleSerialNumbers(['SN-1'], null, advertisedBoardTypesBySerial(tensionDevices));

    expect(resolvedBoards.size).toBe(0);
  });

  it('keeps a saved board of the advertised type', async () => {
    const tensionBoard = makeBoard('SN-1', { boardType: 'tension', name: 'Benchmark Tension' });
    mockLookup([tensionBoard]);

    const resolvedBoards = await resolveBleSerialNumbers(['SN-1'], null, advertisedBoardTypesBySerial(tensionDevices));

    expect(resolvedBoards.get('SN-1')).toEqual({ kind: 'saved', board: tensionBoard });
  });

  it('drops a recorded config of the wrong type and does not fall back to it', async () => {
    // The recorded fallback must not become a second way in for the same board
    // the saved-board filter just refused.
    harness.authToken = 'token-1';
    mockLookup([makeBoard('SN-1', { boardType: 'kilter' })], [makeConfig('SN-1', { boardName: 'kilter' })]);

    const resolvedBoards = await resolveBleSerialNumbers(
      ['SN-1'],
      'token-1',
      advertisedBoardTypesBySerial(tensionDevices),
    );

    expect(resolvedBoards.size).toBe(0);
  });

  it('keeps a match when the device name advertised no type', async () => {
    const kilterBoard = makeBoard('SN-1', { boardType: 'kilter' });
    mockLookup([kilterBoard]);

    const resolvedBoards = await resolveBleSerialNumbers(['SN-1'], null, new Map());

    expect(resolvedBoards.get('SN-1')).toEqual({ kind: 'saved', board: kilterBoard });
  });

  it('scopes the query when the whole scan advertises one type', async () => {
    mockLookup([]);

    await resolveBleSerialNumbers(['SN-1'], null, advertisedBoardTypesBySerial(tensionDevices));

    expect(harness.request).toHaveBeenCalledWith(GET_BOARDS_BY_SERIAL_NUMBERS, {
      serialNumbers: ['SN-1'],
      boardType: 'tension',
    });
  });

  it('sends no board type for a mixed scan, and still filters per serial', async () => {
    // One argument can't describe two types, so the request goes out wide and
    // each serial is checked against its own advertisement.
    const mixedDevices = [
      { deviceId: 'a', name: 'Tension Board#SN-1@3', rssi: -40 },
      { deviceId: 'b', name: 'Kilter Board#SN-2@3', rssi: -50 },
    ];
    mockLookup([makeBoard('SN-1', { boardType: 'kilter' }), makeBoard('SN-2', { boardType: 'kilter' })]);

    const resolvedBoards = await resolveBleSerialNumbers(
      ['SN-1', 'SN-2'],
      null,
      advertisedBoardTypesBySerial(mixedDevices),
    );

    expect(harness.request).toHaveBeenCalledWith(GET_BOARDS_BY_SERIAL_NUMBERS, {
      serialNumbers: ['SN-1', 'SN-2'],
      boardType: undefined,
    });
    expect(resolvedBoards.has('SN-1')).toBe(false);
    expect(resolvedBoards.get('SN-2')?.kind).toBe('saved');
  });
});
