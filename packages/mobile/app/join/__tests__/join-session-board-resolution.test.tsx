// @vitest-environment jsdom
//
// The join screen's board resolution, end to end from the Join tap: the real
// `resolveBoardForSession` + `createBoardOrAdoptDuplicate` wired to mocked
// GraphQL. What's pinned here is the three ways the old one-page/`?? []`
// resolution went wrong (#4409):
//   1. a matching board past the first `myBoards` page is REUSED, not duplicated;
//   2. a BOARD_DUPLICATE_CONFIG rejection is adopted into the board it names;
//   3. an offline walk surfaces an offline message instead of hanging.
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const queue = vi.hoisted(() => ({
  joinSession: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
}));
const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());
const fetchAllMyBoards = vi.hoisted(() => vi.fn());
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

// Captures the confirmation card's Join button (the first one rendered).
const buttons = vi.hoisted(() => ({ joinPress: null as (() => void) | null }));

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
  Button: ({ onPress }: { onPress?: () => void }) => {
    if (buttons.joinPress === null && onPress) buttons.joinPress = onPress;
    return createElement('button');
  },
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
  fetchAllMyBoards,
  fetchBoardBySlug,
  fetchBoardByUuid,
}));
vi.mock('../../../src/theme/tokens', () => ({ spacing: {}, borderRadius: {} }));

import JoinSessionScreen from '../[sessionId]';

function board(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board-uuid',
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
  render(createElement(JoinSessionScreen));
  expect(buttons.joinPress).not.toBeNull();
  await act(async () => {
    buttons.joinPress?.();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  buttons.joinPress = null;
  preview.data.boardPath = SESSION_BOARD_PATH;
  fetchAllMyBoards.mockResolvedValue([]);
  fetchBoardBySlug.mockResolvedValue(null);
  fetchBoardByUuid.mockResolvedValue(null);
  createBoardMutateAsync.mockResolvedValue(board({ uuid: 'minted-uuid', isOwned: false, angle: 40 }));
});

describe('JoinSessionScreen board resolution', () => {
  // The headline bug: `useMyBoards` served 20 boards and the join treated that
  // page as the whole rack, so a joiner whose board sorted onto page two minted a
  // duplicate. The full walk is what makes the match findable.
  it('reuses a matching board from past the first myBoards page', async () => {
    const matching = board({ uuid: 'page-two-uuid' });
    const firstPage = Array.from({ length: 20 }, (_, index) => board({ uuid: `other-${index}`, sizeId: 99 }));
    fetchAllMyBoards.mockResolvedValue([...firstPage, matching]);

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
    fetchAllMyBoards.mockRejectedValue(new TypeError('Network request failed'));

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
