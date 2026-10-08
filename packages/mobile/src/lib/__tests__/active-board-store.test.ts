import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
    },
  };
});

// Minimal UserBoard stand-in — only the fields the active-board readers consume
// plus uuid (used for the picker highlight). Cast covers the unused remainder.
const board = {
  uuid: 'board-1',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '3,4',
  angle: 40,
  name: 'My Kilter',
} as unknown as UserBoard;

describe('active-board-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __reset: () => void;
    };
    asyncStorage.__reset();
  });

  it('round-trips the full board through storage', async () => {
    const { getStoredActiveBoard, setStoredActiveBoard } = await import('../active-board-store');
    await setStoredActiveBoard(board);
    await expect(getStoredActiveBoard()).resolves.toEqual(board);
  });

  it('returns null when no board is stored', async () => {
    const { getStoredActiveBoard } = await import('../active-board-store');
    await expect(getStoredActiveBoard()).resolves.toBeNull();
  });

  it('clears the stored board', async () => {
    const { getStoredActiveBoard, setStoredActiveBoard, clearStoredActiveBoard } =
      await import('../active-board-store');
    await setStoredActiveBoard(board);
    await clearStoredActiveBoard();
    await expect(getStoredActiveBoard()).resolves.toBeNull();
  });

  it('overwrites a previously stored board on switch', async () => {
    const { getStoredActiveBoard, setStoredActiveBoard } = await import('../active-board-store');
    await setStoredActiveBoard(board);
    const other = { ...board, uuid: 'board-2', boardType: 'tension' } as unknown as UserBoard;
    await setStoredActiveBoard(other);
    await expect(getStoredActiveBoard()).resolves.toEqual(other);
  });

  it('withdraws protected metadata while preserving the offline wall configuration', async () => {
    const { getStoredActiveBoard, setStoredActiveBoard } = await import('../active-board-store');
    const { invalidatePrivacySnapshots } = await import('../privacy/privacy-cache');
    const protectedBoard = { ...board, ownerId: 'setter', name: 'Private wall', gymName: 'Home gym', latitude: 52 };
    await setStoredActiveBoard(protectedBoard);
    expect(await getStoredActiveBoard()).toEqual(protectedBoard);
    invalidatePrivacySnapshots();
    expect(await getStoredActiveBoard()).toMatchObject({
      uuid: board.uuid,
      boardType: board.boardType,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
      name: '',
      ownerId: null,
    });
    expect(await getStoredActiveBoard()).not.toHaveProperty('gymName');
    expect(await getStoredActiveBoard()).not.toHaveProperty('latitude');
  });

  it('writes only neutral configuration and cannot restore identity on cold restart', async () => {
    const { setStoredActiveBoard } = await import('../active-board-store');
    const { getPreference } = await import('../preference-store');
    await setStoredActiveBoard({
      ...board,
      ownerId: 'setter',
      name: 'Private wall',
      longitude: 4,
      serialNumber: 'led-kit',
      timerName: 'rogue-timer',
    });
    const persisted = await getPreference<UserBoard>('boardsesh_active_board_v2');
    expect(persisted).toMatchObject({ uuid: board.uuid, angle: board.angle, name: '', ownerId: null });
    expect(persisted).not.toHaveProperty('longitude');
    expect(persisted).toMatchObject({ serialNumber: 'led-kit', timerName: 'rogue-timer' });
    vi.resetModules();
    const { getStoredActiveBoard } = await import('../active-board-store');
    expect(await getStoredActiveBoard()).toEqual(persisted);
  });

  it('sanitizes a legacy snapshot on an offline upgrade without losing selected angle', async () => {
    const { setPreference } = await import('../preference-store');
    await setPreference('boardsesh_active_board_v2', {
      ...board,
      name: 'Legacy private wall',
      ownerId: 'setter',
      gymUuid: 'gym',
    });
    const { getStoredActiveBoard } = await import('../active-board-store');
    const restored = await getStoredActiveBoard();
    expect(restored).toMatchObject({
      uuid: board.uuid,
      angle: 40,
      layoutId: 1,
      setIds: '3,4',
      name: '',
      ownerId: null,
    });
    expect(restored).not.toHaveProperty('gymUuid');
  });

  it('does not authorize a write completed after a privacy boundary', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const { getStoredActiveBoard, setStoredActiveBoard } = await import('../active-board-store');
    const { invalidatePrivacySnapshots } = await import('../privacy/privacy-cache');
    const writeStored = vi.spyOn(asyncStorage, 'setItem');
    const originalWrite = writeStored.getMockImplementation();
    let releaseWrite: (() => void) | undefined;
    writeStored.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      await originalWrite?.(...args);
    });
    const saving = setStoredActiveBoard({ ...board, name: 'Withdrawn wall' });
    invalidatePrivacySnapshots();
    releaseWrite?.();
    await saving;
    expect(await getStoredActiveBoard()).toMatchObject({ uuid: board.uuid, angle: board.angle, name: '' });
  });
});
