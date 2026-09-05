import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateBoardInput } from '@boardsesh/shared-schema';

const preferenceValues = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../preference-store', () => ({
  getPreference: async (key: string) => preferenceValues.get(key) ?? null,
  setPreference: async (key: string, value: unknown) => {
    preferenceValues.set(key, value);
  },
  removePreference: async (key: string) => {
    preferenceValues.delete(key);
  },
}));

import { createLocalBoard, isLocalBoard } from '../local-board';
import {
  clearPendingLocalBoardSetup,
  getLocalBoard,
  getPendingLocalBoardSetup,
  saveLocalBoard,
  savePendingLocalBoardSetup,
} from '../local-board-store';

const input: CreateBoardInput = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '12,13',
  angle: 40,
  isAngleAdjustable: true,
  name: 'Garage wall',
};

function localBoard() {
  return createLocalBoard(input, {
    uuid: 'local-board-uuid',
    ownerId: 'local-profile-uuid',
    createdAt: '2026-08-30T00:00:00.000Z',
  });
}

beforeEach(() => {
  preferenceValues.clear();
});

describe('local board model', () => {
  it('has an explicit local origin and no account, location, gym, serial or social metadata', () => {
    const board = localBoard();

    expect(board).toMatchObject({
      origin: 'local',
      uuid: 'local-board-uuid',
      ownerId: 'local-profile-uuid',
      name: 'Garage wall',
      latitude: null,
      longitude: null,
      gymId: null,
      gymUuid: null,
      serialNumber: null,
      timerName: null,
      isPublic: false,
      isUnlisted: true,
      isFollowedByMe: false,
      followerCount: 0,
    });
    expect(isLocalBoard(board)).toBe(true);
    expect(isLocalBoard({ ...board, origin: undefined })).toBe(false);
  });
});

describe('local board setup persistence', () => {
  it('round-trips the saved board and ignores a server board without local origin', async () => {
    const board = localBoard();
    await saveLocalBoard(board);
    await expect(getLocalBoard()).resolves.toEqual(board);

    const savedKey = [...preferenceValues.keys()].find((key) => key.includes('local_board_v1'))!;
    preferenceValues.set(savedKey, { ...board, origin: undefined });
    await expect(getLocalBoard()).resolves.toBeNull();
  });

  it('persists the downloading phase so setup can resume after a restart', async () => {
    const pending = { version: 1 as const, board: localBoard(), phase: 'downloading' as const };
    await savePendingLocalBoardSetup(pending);

    await expect(getPendingLocalBoardSetup()).resolves.toEqual(pending);
    await clearPendingLocalBoardSetup();
    await expect(getPendingLocalBoardSetup()).resolves.toBeNull();
  });
});
