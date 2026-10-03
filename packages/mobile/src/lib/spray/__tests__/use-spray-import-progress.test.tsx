// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SprayWallImportProgress, UserBoard } from '@boardsesh/shared-schema';

const runtime = vi.hoisted(() => ({
  focused: true,
  offline: false,
  currentState: 'active',
  appStateListener: null as ((state: string) => void) | null,
  removeListener: vi.fn(),
  request: vi.fn(),
}));
vi.mock('expo-router', () => ({ useIsFocused: () => runtime.focused }));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return runtime.currentState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      runtime.appStateListener = listener;
      return { remove: runtime.removeListener };
    },
  },
}));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => runtime.offline }));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: runtime.request }) }));

import { useSprayImportProgress, SPRAY_IMPORT_PROGRESS_QUERY_KEY } from '../use-spray-import-progress';

const queued: SprayWallImportProgress = {
  wallUuid: 'wall-uuid',
  versionId: '42',
  detectionId: 'detection-uuid',
  stage: 'queued',
  queuePosition: 3,
  retryAt: null,
  isReset: false,
};
function board(uuid: string, changes: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid,
    slug: uuid,
    ownerId: 'owner',
    boardType: 'spray',
    layoutId: 1,
    sizeId: 1,
    setIds: '1',
    name: uuid,
    isPublic: false,
    isUnlisted: true,
    hideLocation: true,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: false,
    createdAt: '2026-10-03T12:00:00Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: true,
    sprayImport: queued,
    ...changes,
  };
}
function mount(boards: UserBoard[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useSprayImportProgress(boards), { wrapper }) };
}
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  runtime.focused = true;
  runtime.offline = false;
  runtime.currentState = 'active';
  runtime.appStateListener = null;
  runtime.request.mockReset().mockResolvedValue({ sprayWallImportProgress: [queued] });
  runtime.removeListener.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('visible spray import progress', () => {
  it('fetches only editable spray walls and clears omitted imports after a successful read', async () => {
    const foreign = board('foreign', { canEdit: false });
    const kilter = board('kilter', { boardType: 'kilter' });
    const finished = board('finished');
    const { result } = mount([board('wall-uuid'), finished, foreign, kilter]);
    await settle();
    expect(runtime.request).toHaveBeenCalledWith(expect.any(String), { wallUuids: ['finished', 'wall-uuid'] });
    expect(result.current.boards[0].sprayImport).toEqual(queued);
    expect(result.current.boards[1].sprayImport).toBeNull();
    expect(result.current.boards[2]).toBe(foreign);
    expect(result.current.boards[3]).toBe(kilter);
  });

  it('waits for focus and pauses polling when the screen loses focus', async () => {
    runtime.focused = false;
    const { rerender } = mount([board('wall-uuid')]);
    await settle();
    expect(runtime.request).not.toHaveBeenCalled();
    runtime.focused = true;
    rerender();
    await settle();
    expect(runtime.request).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(runtime.request).toHaveBeenCalledTimes(2);
    runtime.focused = false;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(runtime.request).toHaveBeenCalledTimes(2);
  });

  it('pauses in the background and refreshes on foregrounding', async () => {
    runtime.currentState = 'background';
    const { unmount } = mount([board('wall-uuid')]);
    await settle();
    expect(runtime.request).not.toHaveBeenCalled();
    act(() => runtime.appStateListener?.('active'));
    await settle();
    expect(runtime.request).toHaveBeenCalledTimes(1);
    act(() => runtime.appStateListener?.('background'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(runtime.request).toHaveBeenCalledTimes(1);
    act(() => runtime.appStateListener?.('active'));
    await settle();
    expect(runtime.request).toHaveBeenCalledTimes(2);
    unmount();
    expect(runtime.removeListener).toHaveBeenCalledOnce();
  });

  it('retains saved import metadata offline and masks its stale position', async () => {
    runtime.offline = true;
    const boards = [board('wall-uuid')];
    const { result, rerender } = mount(boards);
    await settle();
    expect(runtime.request).not.toHaveBeenCalled();
    expect(result.current).toEqual({ boards, stale: true });
    runtime.offline = false;
    rerender();
    await settle();
    expect(runtime.request).toHaveBeenCalledTimes(1);
    expect(result.current.stale).toBe(false);
  });

  it('marks transport errors stale while preserving the import and recovers after a fresh read', async () => {
    runtime.request.mockRejectedValue(new Error('Disconnected'));
    const boards = [board('wall-uuid')];
    const { result, client } = mount(boards);
    await settle();
    expect(result.current.stale).toBe(true);
    expect(result.current.boards).toBe(boards);
    runtime.request.mockResolvedValue({
      sprayWallImportProgress: [{ ...queued, stage: 'ready', queuePosition: null }],
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: SPRAY_IMPORT_PROGRESS_QUERY_KEY });
    });
    await settle();
    expect(result.current.stale).toBe(false);
    expect(result.current.boards[0].sprayImport?.stage).toBe('ready');
    const requestCount = runtime.request.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(runtime.request).toHaveBeenCalledTimes(requestCount);
  });
});
