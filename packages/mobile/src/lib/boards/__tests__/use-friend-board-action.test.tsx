// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import type { FriendBoard, FriendBoardAccess, UserBoard } from '@boardsesh/shared-schema';

const activateMock = vi.hoisted(() => vi.fn(async (_board: UserBoard, _pick?: unknown) => {}));
const activateOptionsSeen = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
const followMock = vi.hoisted(() => vi.fn());
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
    return { mutate: followMock };
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
    expect(friendBoardAccessError({ response: { errors: [{ extensions: { code: 'RATE_LIMITED' } }] } }, false)).toBe(
      'rate_limited',
    );
    expect(friendBoardAccessError(new Error('boom'), true)).toBe('offline');
    expect(friendBoardAccessError(new Error('boom'), false)).toBe('failed');
  });
});

describe('useFriendBoardAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activateMock.mockResolvedValue(undefined);
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

  it('asks the owner from the sheet, then reads the list again instead of assuming Requested', async () => {
    const { hook, invalidate, sheetProps } = render();
    act(() => hook.result.current.onPress(friendBoard('CAN_REQUEST'), 0));

    expect(activateMock).not.toHaveBeenCalled();
    expect(sheetProps()).toMatchObject({ ownerName: 'Sam', waiting: false, error: null });
    await act(async () => sheetProps()?.onAsk());

    expect(accessMock).toHaveBeenCalledWith({ action: 'request', kind: 'board', resourceId: 'board-1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['friendsBoards'] });
    expect(hook.result.current.sheet).toBeNull();
  });

  it('keeps the sheet open with gentle copy when the daily cap is hit', async () => {
    accessMock.mockRejectedValue({ response: { errors: [{ extensions: { code: 'RATE_LIMITED' } }] } });
    const { hook, sheetProps } = render();
    act(() => hook.result.current.onPress(friendBoard('CAN_REQUEST'), 0));
    await act(async () => sheetProps()?.onAsk());

    expect(sheetProps()?.error).toBe('rate_limited');
    expect(reportErrorMock).not.toHaveBeenCalled();
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

  it('tells the pick event the board was saved', async () => {
    const onBound = vi.fn(async () => {});
    render({ onBound });
    const reportBound = activateOptionsSeen.value?.onBound as (board: UserBoard, bound: object) => Promise<void>;
    await reportBound(BOARD, { pickSource: 'friends', followed: false });
    expect(onBound).toHaveBeenCalledWith(BOARD, { pickSource: 'friends', followed: true });
  });
});
