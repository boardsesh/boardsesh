// @vitest-environment jsdom
//
// The join screen's board resolution, end to end from the Join tap: the real
// `resolveBoardForSession` + `createBoardOrAdoptDuplicate` wired to mocked
// GraphQL. The owner-verified loader supplies its completed result here; its
// profile and pagination checks have separate tests in the GraphQL hook suite. What's pinned
// here is the three ways the old one-page/`?? []` resolution went wrong (#4409):
//   1. a matching board in the complete owned-board list is REUSED, not duplicated;
//   2. a BOARD_DUPLICATE_CONFIG rejection is adopted into the board it names;
//   3. an offline walk surfaces an offline message instead of hanging.
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const queue = vi.hoisted(() => ({
  sessionId: null as string | null,
  joinSession: vi.fn<
    (
      sessionId: string,
      options: { boardPath: string; userBoard: UserBoard; isOperationCurrent?: () => boolean },
    ) => Promise<boolean>
  >(async () => true),
  clearSession: vi.fn(async () => {}),
}));
const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const auth = vi.hoisted(() => ({ isAuthenticated: true, generation: 0 }));
const alerts = vi.hoisted(() => ({ actions: [] as Array<{ text: string; style?: string; onPress?: () => void }> }));
const fetchAllMyOwnedBoards = vi.hoisted(() => vi.fn());
const fetchBoardBySlug = vi.hoisted(() => vi.fn());
const fetchBoardByUuid = vi.hoisted(() => vi.fn());
const createBoardMutateAsync = vi.hoisted(() => vi.fn());

const SESSION_BOARD_PATH = 'kilter/8/17/27,28/40';

const preview = vi.hoisted(() => ({
  data: {
    id: 'session-42',
    boardPath: 'kilter/8/17/27,28/40',
    endedAt: null as string | null,
    users: [{ id: 'u1', username: 'host', avatarUrl: null, isLeader: true }],
  },
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));

vi.mock('../../../src/lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Alert: {
    alert: vi.fn((_title: string, _message: string, actions: typeof alerts.actions) => {
      alerts.actions = actions;
    }),
  },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: 'session-42' }),
  useRouter: () => router,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));

vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title?: string; onPress?: () => void }) =>
    createElement('button', { 'aria-label': title, onClick: onPress }, title),
}));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: auth.isAuthenticated }) }));
vi.mock('../../../src/lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => auth.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === auth.generation,
}));
vi.mock('../../../src/providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: queue.sessionId }),
  useQueueActions: () => ({ joinSession: queue.joinSession, clearSession: queue.clearSession }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
// The only GraphQL boundary. `createBoardOrAdoptDuplicate` imports this same
// module (as `./hooks`), so its `fetchBoardByUuid` is the mock below too.
vi.mock('../../../src/lib/graphql/hooks', () => ({
  useSessionPreview: () => preview,
  useCreateBoard: () => ({ mutateAsync: createBoardMutateAsync }),
  useBoardBySlug: () => ({ data: null }),
  fetchAllMyOwnedBoards,
  fetchBoardBySlug,
  fetchBoardByUuid,
}));
vi.mock('../../../src/lib/graphql/hooks/fetch-all-my-owned-boards', () => ({ fetchAllMyOwnedBoards }));
vi.mock('../../../src/theme/tokens', () => ({ spacing: {}, borderRadius: {} }));

import JoinSessionScreen from '../[sessionId]';

function board(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board-uuid',
    ownerId: 'viewer-1',
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '27,28',
    name: 'Kilter',
    angle: 20,
    isOwned: true,
    isAngleAdjustable: true,
    ...overrides,
  } as unknown as UserBoard;
}

/** The BOARD_DUPLICATE_CONFIG shape graphql-request throws, as the backend sends it. */
function duplicateRejection(existingBoardUuid: string) {
  return {
    response: {
      errors: [
        { message: 'You already have this board', extensions: { code: 'BOARD_DUPLICATE_CONFIG', existingBoardUuid } },
      ],
    },
  };
}

async function pressJoin() {
  const rendered = render(createElement(JoinSessionScreen));
  const joinButton = rendered.getByRole('button', { name: 'mobileJoin.join' });
  await act(async () => {
    fireEvent.click(joinButton);
  });
  return rendered;
}

function deferred<T>() {
  let resolvePromise: (result: T) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushJoinContinuation() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAuthenticated = true;
  auth.generation = 0;
  alerts.actions = [];
  queue.sessionId = null;
  preview.data.boardPath = SESSION_BOARD_PATH;
  fetchAllMyOwnedBoards.mockResolvedValue({ viewerId: 'viewer-1', boards: [] });
  fetchBoardBySlug.mockResolvedValue(null);
  fetchBoardByUuid.mockResolvedValue(null);
  queue.joinSession.mockReset().mockResolvedValue(true);
  createBoardMutateAsync.mockReset().mockResolvedValue(board({ uuid: 'minted-uuid', isOwned: false, angle: 40 }));
});

describe('JoinSessionScreen board resolution', () => {
  // The real resolver re-checks ownership even when a followed row sorts first;
  // the loader's profile and pagination contract has its own GraphQL tests.
  it('reuses the current viewer board when a followed physical wall sorts first', async () => {
    const followed = board({ uuid: 'followed-first', ownerId: 'another-viewer', isOwned: true });
    const matching = board({ uuid: 'viewer-wall', isOwned: false });
    fetchAllMyOwnedBoards.mockResolvedValue({ viewerId: 'viewer-1', boards: [followed, matching] });

    await pressJoin();

    await waitFor(() => expect(queue.joinSession).toHaveBeenCalledTimes(1));
    expect(createBoardMutateAsync).not.toHaveBeenCalled();
    expect(queue.joinSession).toHaveBeenCalledWith('session-42', {
      boardPath: SESSION_BOARD_PATH,
      // Adopted at the session's angle, not the board's stored 20.
      userBoard: { ...matching, angle: 40 },
      isOperationCurrent: expect.any(Function),
    });
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/record');
  });

  it('creates instead of joining a followed-only matching board from a later page', async () => {
    const precedingBoards = Array.from({ length: 60 }, (_, index) => board({ uuid: `other-${index}`, sizeId: 99 }));
    const followedMatch = board({ uuid: 'followed-late', ownerId: 'another-viewer', isOwned: true });
    fetchAllMyOwnedBoards.mockResolvedValue({ viewerId: 'viewer-1', boards: [...precedingBoards, followedMatch] });

    await pressJoin();

    await waitFor(() => expect(queue.joinSession).toHaveBeenCalledTimes(1));
    expect(createBoardMutateAsync).toHaveBeenCalledTimes(1);
    expect(queue.joinSession).toHaveBeenCalledWith('session-42', {
      boardPath: SESSION_BOARD_PATH,
      userBoard: expect.objectContaining({ uuid: 'minted-uuid', isOwned: false }),
      isOperationCurrent: expect.any(Function),
    });
  });

  // The walk closes the common case but not the race: a board created on another
  // device since the walk still rejects, and the rejection names the board to use.
  it('adopts the board a duplicate rejection names instead of failing the join', async () => {
    const existing = board({ uuid: 'existing-uuid', angle: 20 });
    createBoardMutateAsync.mockRejectedValue(duplicateRejection('existing-uuid'));
    fetchBoardByUuid.mockResolvedValue(existing);

    await pressJoin();

    await waitFor(() => expect(queue.joinSession).toHaveBeenCalledTimes(1));
    expect(fetchBoardByUuid).toHaveBeenCalledWith('existing-uuid');
    expect(queue.joinSession).toHaveBeenCalledWith('session-42', {
      boardPath: SESSION_BOARD_PATH,
      userBoard: { ...existing, angle: 40 },
      isOperationCurrent: expect.any(Function),
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps a same-owner join valid through the initial profile request and proactive refresh', async () => {
    const verifiedOwnerList = deferred<{ viewerId: string; boards: UserBoard[] }>();
    fetchAllMyOwnedBoards.mockReturnValueOnce(verifiedOwnerList.promise);
    const startingGeneration = auth.generation;
    const rendered = await pressJoin();

    await waitFor(() => expect(fetchAllMyOwnedBoards).toHaveBeenCalledTimes(1));
    // The native interceptor refreshes tokens with storeTokensForGeneration,
    // which preserves the credential generation; the initial GET_PROFILE can
    // therefore finish without invalidating this same-owner operation.
    expect(auth.generation).toBe(startingGeneration);
    await act(async () => {
      verifiedOwnerList.resolve({ viewerId: 'viewer-1', boards: [] });
      await verifiedOwnerList.promise;
    });

    await waitFor(() => expect(queue.joinSession).toHaveBeenCalledTimes(1));
    expect(auth.generation).toBe(startingGeneration);
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/record');
    expect(rendered.getByRole('button', { name: 'mobileJoin.join' })).toBeDefined();
  });

  it('does not create a board when the verified owned-board walk belongs to an older auth generation', async () => {
    const ownedBoards = deferred<{ viewerId: string; boards: UserBoard[] }>();
    fetchAllMyOwnedBoards.mockReturnValueOnce(ownedBoards.promise);
    const rendered = await pressJoin();

    await waitFor(() => expect(fetchAllMyOwnedBoards).toHaveBeenCalledTimes(1));
    await act(async () => {
      auth.generation += 1;
      auth.isAuthenticated = false;
      rendered.rerender(createElement(JoinSessionScreen));
    });
    await act(async () => {
      ownedBoards.resolve({ viewerId: 'viewer-1', boards: [] });
      await ownedBoards.promise;
    });
    await flushJoinContinuation();

    expect(createBoardMutateAsync).not.toHaveBeenCalled();
    expect(queue.joinSession).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('rejects an A→B→A completion after the deferred board create', async () => {
    const createdBoard = deferred<UserBoard>();
    createBoardMutateAsync.mockReturnValueOnce(createdBoard.promise);
    const rendered = await pressJoin();

    await waitFor(() => expect(createBoardMutateAsync).toHaveBeenCalledTimes(1));
    await act(async () => {
      auth.generation += 1;
      auth.isAuthenticated = false;
      rendered.rerender(createElement(JoinSessionScreen));
    });
    await act(async () => {
      auth.generation += 1;
      auth.isAuthenticated = true;
      rendered.rerender(createElement(JoinSessionScreen));
    });
    await act(async () => {
      createdBoard.resolve(board({ uuid: 'created-for-a', isOwned: false, angle: 40 }));
      await createdBoard.promise;
    });
    await flushJoinContinuation();

    expect(queue.joinSession).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('passes the live auth guard through session publication and stays quiet after sign-out', async () => {
    const joinResult = deferred<boolean>();
    queue.joinSession.mockReturnValueOnce(joinResult.promise);
    const rendered = await pressJoin();

    await waitFor(() => expect(queue.joinSession).toHaveBeenCalledTimes(1));
    const joinOptions = queue.joinSession.mock.calls[0]?.[1] as { isOperationCurrent?: () => boolean } | undefined;
    expect(joinOptions?.isOperationCurrent?.()).toBe(true);

    await act(async () => {
      auth.generation += 1;
      auth.isAuthenticated = false;
      rendered.rerender(createElement(JoinSessionScreen));
    });
    expect(joinOptions?.isOperationCurrent?.()).toBe(false);
    await act(async () => {
      joinResult.resolve(false);
      await joinResult.promise;
    });
    await flushJoinContinuation();

    expect(analytics.track).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not publish a board returned by a duplicate lookup after auth changes', async () => {
    const existingBoard = deferred<UserBoard | null>();
    createBoardMutateAsync.mockRejectedValueOnce(duplicateRejection('existing-uuid'));
    fetchBoardByUuid.mockReturnValueOnce(existingBoard.promise);
    const rendered = await pressJoin();

    await waitFor(() => expect(fetchBoardByUuid).toHaveBeenCalledWith('existing-uuid'));
    await act(async () => {
      auth.generation += 1;
      // Account B is authenticated too; the credential generation, not just
      // the screen's signed-in boolean, must fence A's late board result.
      auth.isAuthenticated = true;
      rendered.rerender(createElement(JoinSessionScreen));
    });
    await act(async () => {
      existingBoard.resolve(board({ uuid: 'existing-uuid' }));
      await existingBoard.promise;
    });
    await flushJoinContinuation();

    expect(queue.joinSession).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not publish after the screen unmounts while duplicate lookup is pending', async () => {
    const existingBoard = deferred<UserBoard | null>();
    createBoardMutateAsync.mockRejectedValueOnce(duplicateRejection('existing-uuid'));
    fetchBoardByUuid.mockReturnValueOnce(existingBoard.promise);
    const rendered = await pressJoin();

    await waitFor(() => expect(fetchBoardByUuid).toHaveBeenCalledWith('existing-uuid'));
    rendered.unmount();
    await act(async () => {
      existingBoard.resolve(board({ uuid: 'existing-uuid' }));
      await existingBoard.promise;
    });
    await flushJoinContinuation();

    expect(auth.generation).toBe(0);
    expect(queue.joinSession).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps the current session when the climber cancels a confirmed switch', async () => {
    queue.sessionId = 'current-session';
    const rendered = render(createElement(JoinSessionScreen));
    await act(async () => {
      fireEvent.click(rendered.getByRole('button', { name: 'mobileJoin.join' }));
    });

    const cancelAction = alerts.actions.find((action) => action.text === 'mobileJoin.cancel');
    expect(cancelAction).toBeDefined();
    await act(async () => cancelAction?.onPress?.());

    expect(queue.clearSession).not.toHaveBeenCalled();
    expect(queue.joinSession).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  // Previously: an awaited `refetch()` paused forever under `offlineFirst`, and a
  // failed one degraded to `[]` and minted a duplicate. Now the walk rejects, and
  // the rejection is a transport failure the climber is told about by name.
  it('surfaces an offline message when the owned-board walk cannot reach the server', async () => {
    fetchAllMyOwnedBoards.mockRejectedValue(new TypeError('Network request failed'));

    await pressJoin();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('mobileJoin.offlineError', 'error'));
    expect(createBoardMutateAsync).not.toHaveBeenCalled();
    expect(queue.joinSession).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  // A server verdict is not a connectivity problem — telling a climber with full
  // bars that they're offline sends them chasing the wrong fix.
  it('keeps the generic join error for a server-side failure', async () => {
    createBoardMutateAsync.mockRejectedValue({
      response: { errors: [{ message: 'Board limit reached', extensions: { code: 'BOARD_LIMIT', status: 400 } }] },
    });

    await pressJoin();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('mobileJoin.joinError', 'error'));
    expect(queue.joinSession).not.toHaveBeenCalled();
  });
});
