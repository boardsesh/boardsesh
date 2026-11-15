// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

const storage = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  nextWriteGates: new Map<string, Promise<void>>(),
  startedWrites: vi.fn(),
}));
const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.entries.get(key) ?? null),
    setItem: vi.fn(async (key: string, serializedPreference: string) => {
      const gate = storage.nextWriteGates.get(key);
      storage.nextWriteGates.delete(key);
      storage.startedWrites(key);
      if (gate) await gate;
      storage.entries.set(key, serializedPreference);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.entries.delete(key);
    }),
  },
}));
vi.mock('../../error-reporting', () => ({ reportError: reportErrorMock }));

import {
  ACTIVE_BOARD_QUERY_KEY,
  clearStoredActiveBoardCoordinated,
  resetActiveBoardWriteCoordinatorForTests,
  useActiveBoard,
  useClearActiveBoard,
  useSetActiveBoard,
} from '../../graphql/use-active-board';
import { getStoredActiveBoard, setStoredActiveBoard } from '../../active-board-store';
import { invalidateCredentialSnapshots } from '../../privacy/privacy-cache';
import { getStoredBoardAngle } from '../board-angle-store';
import { useSetBoardAngle } from '../use-set-board-angle';

const ANGLE_STORAGE_KEY = 'boardsesh_board_angles_v1';
const ACTIVE_BOARD_STORAGE_KEY = 'boardsesh_active_board_v2';

const initialBoard = {
  uuid: 'kilter-1',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
  isAngleAdjustable: true,
} as UserBoard;
const nextBoard = { ...initialBoard, uuid: 'kilter-2' };

function deferStorageWrite(storageKey: string) {
  let release = () => {};
  storage.nextWriteGates.set(
    storageKey,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return release;
}

async function renderBoardControls() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const controls = renderHook(
    () => ({
      activeBoard: useActiveBoard(),
      setAngle: useSetBoardAngle(),
      secondAngleControl: useSetBoardAngle(),
      selectBoard: useSetActiveBoard(),
      clearBoard: useClearActiveBoard(),
    }),
    { wrapper },
  );
  await waitFor(() => expect(controls.result.current.activeBoard.data).toEqual(initialBoard));
  return { ...controls, queryClient };
}

async function expectBoardEverywhere(queryClient: QueryClient, expectedBoard: UserBoard | null) {
  expect(queryClient.getQueryData(ACTIVE_BOARD_QUERY_KEY)).toEqual(expectedBoard);
  await expect(getStoredActiveBoard()).resolves.toEqual(expectedBoard);
  const serializedBoard = storage.entries.get(ACTIVE_BOARD_STORAGE_KEY);
  const persistedSnapshot: unknown = serializedBoard ? JSON.parse(serializedBoard) : null;
  if (expectedBoard) expect(persistedSnapshot).toMatchObject(expectedBoard);
  else expect(persistedSnapshot).toBeNull();
}

describe('angle writes preserve active-board intent order', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    storage.entries.clear();
    storage.nextWriteGates.clear();
    resetActiveBoardWriteCoordinatorForTests();
    await setStoredActiveBoard(initialBoard);
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps a later board selection when older angle persistence finishes', async () => {
    const { result, queryClient } = await renderBoardControls();
    const releaseAngle = deferStorageWrite(ANGLE_STORAGE_KEY);
    let angleChange: Promise<void> = Promise.resolve();

    act(() => {
      angleChange = result.current.setAngle(initialBoard, 25);
    });
    await waitFor(() => expect(storage.startedWrites).toHaveBeenCalledWith(ANGLE_STORAGE_KEY));
    await act(async () => {
      await result.current.selectBoard(nextBoard);
    });
    releaseAngle();
    await act(async () => {
      await angleChange;
    });

    await expectBoardEverywhere(queryClient, nextBoard);
    await expect(getStoredBoardAngle(initialBoard.uuid)).resolves.toBe(25);
  });

  it('keeps a later clear when older angle persistence finishes', async () => {
    const { result, queryClient } = await renderBoardControls();
    const releaseAngle = deferStorageWrite(ANGLE_STORAGE_KEY);
    let angleChange: Promise<void> = Promise.resolve();
    act(() => {
      angleChange = result.current.setAngle(initialBoard, 25);
    });
    await waitFor(() => expect(storage.startedWrites).toHaveBeenCalledWith(ANGLE_STORAGE_KEY));
    await act(async () => {
      await result.current.clearBoard();
    });
    releaseAngle();
    await act(async () => {
      await angleChange;
    });

    await expectBoardEverywhere(queryClient, null);
  });

  it('does not restore an old account board after credential cleanup', async () => {
    const { result, queryClient } = await renderBoardControls();
    const releaseAngle = deferStorageWrite(ANGLE_STORAGE_KEY);
    let angleChange: Promise<void> = Promise.resolve();
    act(() => {
      angleChange = result.current.setAngle(initialBoard, 25);
    });
    await waitFor(() => expect(storage.startedWrites).toHaveBeenCalledWith(ANGLE_STORAGE_KEY));
    await act(async () => {
      invalidateCredentialSnapshots();
      await clearStoredActiveBoardCoordinated();
      queryClient.setQueryData(ACTIVE_BOARD_QUERY_KEY, null);
    });
    releaseAngle();
    await act(async () => {
      await angleChange;
    });

    await expectBoardEverywhere(queryClient, null);
  });

  it.each([30, 40])('keeps the latest angle %s across two controls before a rerender', async (latestAngle) => {
    const { result, queryClient } = await renderBoardControls();
    const releaseAngle = deferStorageWrite(ANGLE_STORAGE_KEY);
    let angleChanges: Promise<void[]> = Promise.resolve([]);
    act(() => {
      angleChanges = Promise.all([
        result.current.setAngle(initialBoard, 25),
        result.current.secondAngleControl(initialBoard, latestAngle),
      ]);
    });
    await waitFor(() => expect(storage.startedWrites).toHaveBeenCalledWith(ANGLE_STORAGE_KEY));
    releaseAngle();
    await act(async () => {
      await angleChanges;
    });

    await expectBoardEverywhere(queryClient, { ...initialBoard, angle: latestAngle });
    await expect(getStoredBoardAngle(initialBoard.uuid)).resolves.toBe(latestAngle);
  });
});
