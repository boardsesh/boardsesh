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

  it('clears authenticated active boards on signed-out launch', async () => {
    const { getStoredActiveBoard, setStoredActiveBoard, clearStoredAuthenticatedActiveBoard } =
      await import('../active-board-store');
    await setStoredActiveBoard(board);
    await clearStoredAuthenticatedActiveBoard();
    await expect(getStoredActiveBoard()).resolves.toBeNull();
  });

  it('preserves guest active boards on signed-out launch', async () => {
    const { getStoredActiveBoard, setStoredActiveBoard, clearStoredAuthenticatedActiveBoard } =
      await import('../active-board-store');
    const { createGuestActiveBoard } = await import('../boards/guest-board');
    const guestBoard = createGuestActiveBoard({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 2,
      setIds: '3,4',
      displayName: 'Guest Kilter',
    });
    await setStoredActiveBoard(guestBoard);
    await clearStoredAuthenticatedActiveBoard();
    await expect(getStoredActiveBoard()).resolves.toEqual(guestBoard);
  });

  it('overwrites a previously stored board on switch', async () => {
    const { getStoredActiveBoard, setStoredActiveBoard } = await import('../active-board-store');
    await setStoredActiveBoard(board);
    const other = { ...board, uuid: 'board-2', boardType: 'tension' } as unknown as UserBoard;
    await setStoredActiveBoard(other);
    await expect(getStoredActiveBoard()).resolves.toEqual(other);
  });
});
