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

import { resolveBleSerialNumbers, serialsFromDiscoveredDevices } from '../resolve-serials';

function makeBoard(serialNumber: string, overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    id: 1,
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
    expect(harness.request).toHaveBeenCalledWith(GET_BOARDS_BY_SERIAL_NUMBERS, { serialNumbers: ['SN-1'] });
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
