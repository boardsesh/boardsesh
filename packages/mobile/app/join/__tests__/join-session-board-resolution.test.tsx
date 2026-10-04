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
  joinSession: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
}));
const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());
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

vi.mock('../../../src/lib/analytics', () => ({ track: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Alert: { alert: vi.fn() },
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
vi.mock('../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../src/providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: null }),
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
}

beforeEach(() => {
  vi.clearAllMocks();
  preview.data.boardPath = SESSION_BOARD_PATH;
  fetchAllMyOwnedBoards.mockResolvedValue({ viewerId: 'viewer-1', boards: [] });
  fetchBoardBySlug.mockResolvedValue(null);
  fetchBoardByUuid.mockResolvedValue(null);
  createBoardMutateAsync.mockResolvedValue(board({ uuid: 'minted-uuid', isOwned: false, angle: 40 }));
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
    });
    expect(showToast).not.toHaveBeenCalled();
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
