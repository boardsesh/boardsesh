// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import type { FriendBoard, FriendBoardAccess, UserBoard } from '@boardsesh/shared-schema';

const activateMock = vi.hoisted(() => vi.fn(async (_board: UserBoard, _pick?: unknown) => {}));
const activateOptionsSeen = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
const followMock = vi.hoisted(() => vi.fn(async (_board: UserBoard): Promise<unknown> => true));
const offerDownloadMock = vi.hoisted(() => vi.fn(async (_board: UserBoard) => {}));
const adoptOptionsSeen = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
const followOptionsSeen = vi.hoisted(() => ({
  value: undefined as { onFollowed?: (board: { uuid: string; name: string }) => void } | undefined,
}));
const accessMock = vi.hoisted(() => vi.fn(async (_variables: unknown) => true));
const showToastMock = vi.hoisted(() => vi.fn());
const reportErrorMock = vi.hoisted(() => vi.fn());
const announceMock = vi.hoisted(() => vi.fn());
const connectivity = vi.hoisted(() => ({ effectiveOffline: false }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../use-activate-board', () => ({
  useActivateBoard: (options: Record<string, unknown>) => {
    activateOptionsSeen.value = options;
    return activateMock;
  },
}));
vi.mock('../../graphql/hooks', () => ({
  useFollowBoard: (options: typeof followOptionsSeen.value) => {
    followOptionsSeen.value = options;
    return { mutateAsync: followMock };
  },
}));
vi.mock('../../board-discovery/use-adopt-found-board', () => ({
  useAdoptFoundBoard: (options: Record<string, unknown>) => {
    adoptOptionsSeen.value = options;
    return offerDownloadMock;
  },
}));
vi.mock('../../graphql/hooks/use-resource-privacy', () => ({
  useResourceAccessAction: () => ({ mutateAsync: accessMock, isPending: false }),
}));
vi.mock('../../graphql/hooks/use-friends-boards', () => ({ FRIENDS_BOARDS_QUERY_KEY: 'friendsBoards' }));
vi.mock('../../connectivity/connectivity-store', () => ({ getConnectivitySnapshot: () => connectivity }));
vi.mock('../../error-reporting', () => ({ reportError: reportErrorMock }));
vi.mock('../saved-friend-board-undo', () => ({ announceSavedFriendBoard: announceMock }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: showToastMock }) }));
// The sheet is a native surface; the hook's element and its props are what matter here.
vi.mock('../../../components/board-discovery/FriendBoardAccessSheet', () => ({
  FriendBoardAccessSheet: () => null,
}));

import { friendBoardAccessError, friendBoardTap, useFriendBoardAction } from '../use-friend-board-action';

type SheetProps = {
  ownerName: string;
  waiting: boolean;
  error: string | null;
  onAsk: () => void;
  onCancelRequest: () => void;
  onDismiss: () => void;
};

function rateLimited(retryAfterSeconds?: number) {
  return { response: { errors: [{ extensions: { code: 'RATE_LIMITED', retryAfterSeconds } }] } };
}

const BOARD = { uuid: 'board-1', name: 'Garage', boardType: 'kilter', isFollowedByMe: false } as unknown as UserBoard;

function friendBoard(access: FriendBoardAccess, board: UserBoard | null = null): FriendBoard {
  return {
    viewerAccess: access,
    owner: { userId: 'sam', displayName: 'Sam', avatarUrl: null },
    preview: { uuid: 'board-1', name: 'Garage', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 },
    board,
  };
}

function render(options: { onBound?: () => Promise<void>; beforeClimb?: () => void } = {}) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => useFriendBoardAction({ returnTo: '/(tabs)/climbs', section: 'friends_boards', ...options }),
    { wrapper },
  );
  const sheetProps = () => (hook.result.current.sheet as ReactElement<SheetProps> | null)?.props ?? null;
  return { hook, invalidate, sheetProps };
}

describe('friendBoardTap', () => {
  it.each([
    { access: 'CAN_CLIMB' as const, board: BOARD, expected: 'climb' },
    { access: 'CAN_CLIMB' as const, board: null, expected: 'unavailable' },
    { access: 'CAN_REQUEST' as const, board: null, expected: 'ask' },
    { access: 'REQUESTED' as const, board: null, expected: 'waiting' },
  ])('$access with board $board.uuid → $expected', ({ access, board, expected }) => {
    expect(friendBoardTap(friendBoard(access, board))).toBe(expected);
  });

  it('reads a rate limit, no signal and anything else apart', () => {
    expect(friendBoardAccessError(rateLimited(), false, 'request')).toBe('rate_limited');
    expect(friendBoardAccessError(new Error('boom'), true, 'request')).toBe('offline');
    expect(friendBoardAccessError(new Error('boom'), false, 'request')).toBe('failed');
  });

  it('says "tomorrow" only for an ask that waits more than an hour', () => {
    expect(friendBoardAccessError(rateLimited(20 * 60 * 60), false, 'request')).toBe('daily_cap');
    expect(friendBoardAccessError(rateLimited(60 * 60), false, 'request')).toBe('rate_limited');
    expect(friendBoardAccessError(rateLimited(30), false, 'request')).toBe('rate_limited');
    // Taking a request back has no daily cap: always the neutral copy.
    expect(friendBoardAccessError(rateLimited(20 * 60 * 60), false, 'cancel')).toBe('rate_limited');
  });
});

describe('useFriendBoardAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activateMock.mockResolvedValue(undefined);
    followMock.mockResolvedValue(true);
    accessMock.mockResolvedValue(true);
    connectivity.effectiveOffline = false;
  });

  it('binds a climbable board without adoption, then saves it', async () => {
    const beforeClimb = vi.fn();
    const { hook } = render({ beforeClimb });
    act(() => hook.result.current.onPress(friendBoard('CAN_CLIMB', BOARD), 3));

    expect(beforeClimb).toHaveBeenCalledOnce();
    expect(activateOptionsSeen.value).toMatchObject({ adopt: false, writeFailure: 'rethrow' });
    expect(activateMock).toHaveBeenCalledWith(BOARD, { pickSource: 'friends', section: 'friends_boards', position: 3 });
    await waitFor(() => expect(followMock).toHaveBeenCalledWith(BOARD));
    expect(hook.result.current.sheet).toBeNull();
  });

  it('offers the download as adoption would, without adoption following too', async () => {
    const { hook } = render();
    act(() => hook.result.current.onPress(friendBoard('CAN_CLIMB', BOARD), 0));
    await waitFor(() => expect(offerDownloadMock).toHaveBeenCalledWith(BOARD));
    expect(adoptOptionsSeen.value).toEqual({ follow: false });
  });

  it('offers Undo and refreshes the friend lists once the save lands', () => {
    const { invalidate } = render();
    followOptionsSeen.value?.onFollowed?.({ uuid: 'board-1', name: 'Garage' });
    expect(announceMock).toHaveBeenCalledWith({ uuid: 'board-1', name: 'Garage' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['friendsBoards'] });
  });

  it('does not save a board whose bind failed', async () => {
    activateMock.mockRejectedValue(new Error('storage full'));
    const { hook } = render();
    act(() => hook.result.current.onPress(friendBoard('CAN_CLIMB', BOARD), 0));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith('mobile.boardSwitchError', 'error'));
    expect(followMock).not.toHaveBeenCalled();
  });

  it('does not save a board already in Your boards again', async () => {
    const followed = { ...BOARD, isFollowedByMe: true } as UserBoard;
    const { hook } = render();
    act(() => hook.result.current.onPress(friendBoard('CAN_CLIMB', followed), 0));
    await waitFor(() => expect(activateMock).toHaveBeenCalled());
    expect(followMock).not.toHaveBeenCalled();
  });

  it('asks the owner from the sheet and closes on the write, leaving the refresh to the action', async () => {
    const { hook, invalidate, sheetProps } = render();
    act(() => hook.result.current.onPress(friendBoard('CAN_REQUEST'), 0));

    expect(activateMock).not.toHaveBeenCalled();
    expect(sheetProps()).toMatchObject({ ownerName: 'Sam', waiting: false, error: null });
    await act(async () => sheetProps()?.onAsk());

    expect(accessMock).toHaveBeenCalledWith({ action: 'request', kind: 'board', resourceId: 'board-1' });
    // useResourceAccessAction refreshes friendsBoards itself, without being awaited.
    expect(invalidate).not.toHaveBeenCalled();
    expect(hook.result.current.sheet).toBeNull();
  });

  it('keeps the sheet open with gentle copy when the daily cap is hit', async () => {
    accessMock.mockRejectedValue(rateLimited(20 * 60 * 60));
    const { hook, sheetProps } = render();
    act(() => hook.result.current.onPress(friendBoard('CAN_REQUEST'), 0));
    await act(async () => sheetProps()?.onAsk());

    expect(sheetProps()?.error).toBe('daily_cap');
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('reads a short limit on a cancel as a moment to wait', async () => {
    accessMock.mockRejectedValue(rateLimited(20 * 60 * 60));
    const { hook, sheetProps } = render();
    act(() => hook.result.current.onPress(friendBoard('REQUESTED'), 0));
    await act(async () => sheetProps()?.onCancelRequest());

    expect(sheetProps()?.error).toBe('rate_limited');
  });

  it('takes a waiting request back from the same sheet', async () => {
    const { hook, sheetProps } = render();
    act(() => hook.result.current.onPress(friendBoard('REQUESTED'), 0));
    expect(sheetProps()?.waiting).toBe(true);
    await act(async () => sheetProps()?.onCancelRequest());

    expect(accessMock).toHaveBeenCalledWith({ action: 'cancel', kind: 'board', resourceId: 'board-1' });
    expect(hook.result.current.sheet).toBeNull();
  });

  it('says so when a climbable row came without its board', () => {
    const { hook } = render();
    act(() => hook.result.current.onPress(friendBoard('CAN_CLIMB', null), 0));
    expect(showToastMock).toHaveBeenCalledWith('mobile.boardSwitchError', 'error');
    expect(activateMock).not.toHaveBeenCalled();
  });

  it('tells the pick event the board was saved once the save lands', async () => {
    let finishFollow: (value: unknown) => void = () => {};
    followMock.mockReturnValue(new Promise((resolve) => (finishFollow = resolve)));
    const onBound = vi.fn(async () => {});
    const { hook } = render({ onBound });
    expect(activateOptionsSeen.value?.onBound).toBeUndefined();
    act(() => hook.result.current.onPress(friendBoard('CAN_CLIMB', BOARD), 2));

    await waitFor(() => expect(followMock).toHaveBeenCalled());
    expect(onBound).not.toHaveBeenCalled();
    await act(async () => finishFollow(true));
    expect(onBound).toHaveBeenCalledWith(BOARD, {
      pickSource: 'friends',
      section: 'friends_boards',
      position: 2,
      followed: true,
    });
  });

  it('tells the pick event the board was not saved when the save fails', async () => {
    followMock.mockRejectedValue(new Error('nope'));
    const onBound = vi.fn(async () => {});
    const { hook } = render({ onBound });
    act(() => hook.result.current.onPress(friendBoard('CAN_CLIMB', BOARD), 0));
    await waitFor(() => expect(onBound).toHaveBeenCalledWith(BOARD, expect.objectContaining({ followed: false })));
  });

  it('reports a board already in Your boards as not newly saved', async () => {
    const followed = { ...BOARD, isFollowedByMe: true } as UserBoard;
    const onBound = vi.fn(async () => {});
    const { hook } = render({ onBound });
    act(() => hook.result.current.onPress(friendBoard('CAN_CLIMB', followed), 0));
    await waitFor(() => expect(onBound).toHaveBeenCalledWith(followed, expect.objectContaining({ followed: false })));
  });
});
