// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBoardPath } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { ClimbQueueItem } from '@boardsesh/queue';

// QueueProvider harness for the CROSS-BOARD add gate (#3994): adding a climb set
// on a board the queue isn't on asks first — add anyway / switch board / cancel.
// The real `useCrossBoardAddGate` runs here (only the dialog, the board roster
// cache and the router are stubbed), so the one-prompt-per-board dedup and the
// switch side effects are covered end to end.

const ws = vi.hoisted(() => ({
  client: {
    on: vi.fn(() => vi.fn()),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

const graph = vi.hoisted(() => ({ execute: vi.fn() }));
const http = vi.hoisted(() => ({ request: vi.fn() }));

const boards = vi.hoisted(() => {
  const base = {
    uuid: 'board-kilter',
    slug: 'board-kilter',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'Home Kilter',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
  };
  return {
    kilter: base,
    // A DIFFERENT stored angle from the active board's 40 — the switch must keep
    // the board's own angle, never synthesise 0.
    tension: {
      ...base,
      uuid: 'board-tension',
      slug: 'board-tension',
      boardType: 'tension',
      layoutId: 8,
      sizeId: 12,
      setIds: '3,4',
      name: 'Gym Tension',
      angle: 25,
    },
  };
});

const errorReporting = vi.hoisted(() => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

const roster = vi.hoisted(() => ({ boards: [] as unknown[] }));
const setActiveBoard = vi.hoisted(() => vi.fn(async (_board: unknown) => {}));
const routerPush = vi.hoisted(() => vi.fn());
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const snackbar = vi.hoisted(() => ({ showQueueAddedSnackbar: vi.fn() }));

// A controllable `choose()`: every prompt parks its resolver so the test decides
// when (and whether) the climber answers.
const dialog = vi.hoisted(() => {
  const resolvers: Array<(value: string) => void> = [];
  return {
    resolvers,
    choose: vi.fn(
      (_options: unknown) =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    ),
  };
});

const queueMutations = vi.hoisted(() => ({
  addQueueItem: vi.fn(async () => {}),
  removeQueueItem: vi.fn(async () => {}),
  reorderQueueItem: vi.fn(async () => {}),
  setCurrentClimb: vi.fn(async () => {}),
  mirrorCurrentClimb: vi.fn(async () => {}),
  publishPlaybackState: vi.fn(async () => {}),
  setQueue: vi.fn(async () => {}),
  replaceQueueItem: vi.fn(async () => {}),
  reportWallDisconnect: vi.fn(async () => {}),
  confirmClimbOnWall: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setSessionBoardPath: vi.fn(async (_boardPath: string) => {}),
}));

const sessionStore = vi.hoisted(() => ({
  getStoredSessionId: vi.fn(async (): Promise<string | null> => null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
  getStoredCreatedSessionId: vi.fn(async (): Promise<string | null> => null),
  setStoredCreatedSessionId: vi.fn(async () => {}),
  clearStoredCreatedSessionId: vi.fn(async () => {}),
}));

const queueSnapshotStore = vi.hoisted(() => ({
  getStoredQueueSnapshot: vi.fn(async (): Promise<null> => null),
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-correlation-id' }));
vi.mock('expo-router', () => ({ router: { push: routerPush } }));
// Only the cache read the gate does is stubbed; QueueProvider itself reads the
// real QueryClientContext elsewhere.
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ getQueryData: () => ({ myBoards: { boards: roster.boards } }) }),
}));
vi.mock('@boardsesh/graphql-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/graphql-client')>()),
  execute: graph.execute,
}));
vi.mock('@boardsesh/queue-react', () => ({
  useQueueMutations: () => queueMutations,
}));
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  emitWallConfirm: vi.fn(),
}));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => ws.client }));
vi.mock('../../lib/session-store', () => sessionStore);
vi.mock('../../lib/queue-snapshot-store', () => queueSnapshotStore);
vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard: async () => boards.kilter }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: boards.kilter }),
  useSetActiveBoard: () => setActiveBoard,
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: analytics.track, registerRenderSuperProperties: vi.fn() }));
vi.mock('../../lib/error-reporting', () => errorReporting);
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('../queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({ showQueueAddedSnackbar: snackbar.showQueueAddedSnackbar }),
}));
vi.mock('../dialog-provider', () => ({ useChoose: () => dialog.choose }));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

// The board continuation feed (the re-anchor after a board switch) is a React
// Query hook and this harness mounts no QueryClient. Its own behaviour is covered
// by queue-provider-board-switch.test.tsx.
vi.mock('../queue/use-board-continuation-feed', () => ({ useBoardContinuationFeed: () => ({ climbs: [] }) }));

import { QueueProvider, useQueue } from '../queue-provider';

type Snapshot = {
  queue: ClimbQueueItem[];
  addToQueue: ReturnType<typeof useQueue>['addToQueue'];
};

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  useEffect(() => {
    onSnapshot({ queue: queue.state.queue, addToQueue: queue.addToQueue });
  }, [queue.state, queue.addToQueue, onSnapshot]);
  return null;
}

function makeQueueItem(uuid: string, board: { boardType?: string; layoutId?: number }): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: `climb-${uuid}`,
      name: `Climb ${uuid}`,
      frames: 'p1r12',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
      ...board,
    },
    suggested: false,
  };
}

const kilterItem = (uuid: string) => makeQueueItem(uuid, { boardType: 'kilter', layoutId: 1 });
const tensionItem = (uuid: string) => makeQueueItem(uuid, { boardType: 'tension', layoutId: 8 });

async function mountProvider() {
  const snapshots: Snapshot[] = [];
  render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (s) => snapshots.push(s) })));
  await waitFor(() => {
    expect(snapshots.length).toBeGreaterThan(0);
  });
  return {
    latest: () => {
      const snapshot = snapshots.at(-1);
      if (!snapshot) throw new Error('provider never rendered');
      return snapshot;
    },
  };
}

/** Answer the Nth open prompt and let the awaiting add finish. */
async function answerPrompt(index: number, value: 'add' | 'switch' | 'cancel') {
  await act(async () => {
    dialog.resolvers[index](value);
    await Promise.resolve();
  });
}

function queueUuids(snapshot: Snapshot): string[] {
  return snapshot.queue.map((item) => item.uuid);
}

describe('QueueProvider cross-board add gate', () => {
  beforeEach(() => {
    dialog.resolvers.length = 0;
    dialog.choose.mockClear();
    roster.boards = [boards.kilter, boards.tension];
    setActiveBoard.mockClear();
    routerPush.mockClear();
    errorReporting.reportHandledError.mockClear();
    toast.showToast.mockClear();
    setActiveBoard.mockImplementation(async () => {});
    queueMutations.setSessionBoardPath.mockImplementation(async () => {});
    analytics.track.mockClear();
    snackbar.showQueueAddedSnackbar.mockClear();
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockClear();
    }
    graph.execute.mockReset();
    http.request.mockReset();
    http.request.mockResolvedValue({ createSession: { id: 'session-new' } });
  });

  it('adds a climb from the active board with no prompt at all', async () => {
    const provider = await mountProvider();

    await act(async () => {
      await expect(provider.latest().addToQueue(kilterItem('same-board'))).resolves.toBe('added');
    });

    expect(dialog.choose).not.toHaveBeenCalled();
    expect(queueUuids(provider.latest())).toEqual(['same-board']);
    expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1);
  });

  it('adds a climb with no board metadata rather than prompting', async () => {
    const provider = await mountProvider();

    await act(async () => {
      await provider.latest().addToQueue(makeQueueItem('no-metadata', {}));
    });

    expect(dialog.choose).not.toHaveBeenCalled();
    expect(queueUuids(provider.latest())).toEqual(['no-metadata']);
  });

  it('prompts once for a foreign board and queues it on "add anyway"', async () => {
    const provider = await mountProvider();

    let pending!: Promise<'added' | 'cancelled'>;
    act(() => {
      pending = provider.latest().addToQueue(tensionItem('foreign'));
    });
    expect(dialog.choose).toHaveBeenCalledTimes(1);
    // Nothing lands until they answer.
    expect(queueUuids(provider.latest())).toEqual([]);

    await answerPrompt(0, 'add');
    await expect(pending).resolves.toBe('added');

    expect(queueUuids(provider.latest())).toEqual(['foreign']);
    expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(
      SHARED_EVENTS.CrossBoardQueueAddPrompted,
      expect.objectContaining({ outcome: 'add', climbBoardName: 'tension', climbLayoutId: 8 }),
    );
  });

  it('cancelling leaves the queue untouched, unsynced, untracked and unsnackbarred', async () => {
    const provider = await mountProvider();

    let pending!: Promise<'added' | 'cancelled'>;
    act(() => {
      pending = provider.latest().addToQueue(tensionItem('foreign'));
    });
    await answerPrompt(0, 'cancel');
    await expect(pending).resolves.toBe('cancelled');

    expect(queueUuids(provider.latest())).toEqual([]);
    expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
    expect(snackbar.showQueueAddedSnackbar).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.ClimbAddedToQueue, expect.anything());
  });

  it('switching activates the owned board at ITS OWN angle, queues the climb, and tells peers', async () => {
    const provider = await mountProvider();

    let pending!: Promise<'added' | 'cancelled'>;
    act(() => {
      pending = provider.latest().addToQueue(tensionItem('foreign'));
    });
    await answerPrompt(0, 'switch');
    await expect(pending).resolves.toBe('added');

    expect(setActiveBoard).toHaveBeenCalledWith(boards.tension);
    // Its stored 25°, never a synthesised 0.
    expect(queueMutations.setSessionBoardPath).toHaveBeenCalledWith(buildBoardPath('tension', 8, 12, '3,4', 25));
    // The add is the SAME synced body, not a local-only dispatch.
    expect(queueUuids(provider.latest())).toEqual(['foreign']);
    expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(1);
  });

  it('reports a failed peer broadcast instead of splitting the party in silence', async () => {
    queueMutations.setSessionBoardPath.mockImplementation(async () => {
      throw new Error('join failed');
    });
    const provider = await mountProvider();

    let pending!: Promise<'added' | 'cancelled'>;
    act(() => {
      pending = provider.latest().addToQueue(tensionItem('foreign'));
    });
    await answerPrompt(0, 'switch');
    // The local add still succeeds — only the peers' follow is lost.
    await expect(pending).resolves.toBe('added');
    expect(queueUuids(provider.latest())).toEqual(['foreign']);

    await waitFor(() => {
      expect(errorReporting.reportHandledError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.objectContaining({ op: 'set-board-path-switch' }) }),
      );
    });
  });

  it('cancels the add when activating the board fails, rather than rejecting into the void', async () => {
    setActiveBoard.mockImplementation(async () => {
      throw new Error('activation failed');
    });
    const provider = await mountProvider();

    let pending!: Promise<'added' | 'cancelled'>;
    act(() => {
      // Every real call site fires this as `void addToQueue(...)`, so a
      // rejection here would land as an unhandled rejection.
      pending = provider.latest().addToQueue(tensionItem('foreign'));
    });
    await answerPrompt(0, 'switch');
    await expect(pending).resolves.toBe('cancelled');

    // The queue is still on the old board, so nothing foreign got queued onto it.
    expect(queueUuids(provider.latest())).toEqual([]);
    expect(queueMutations.addQueueItem).not.toHaveBeenCalled();
    expect(queueMutations.setSessionBoardPath).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith('mobile.crossBoardAdd.switchFailed', 'error');
    expect(errorReporting.reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ op: 'cross-board-switch' }) }),
    );
    expect(analytics.track).toHaveBeenCalledWith(
      SHARED_EVENTS.CrossBoardQueueAddPrompted,
      expect.objectContaining({ outcome: 'cancel' }),
    );
  });

  it('routes to the board picker and cancels the add when they do not own that board', async () => {
    roster.boards = [boards.kilter];
    const provider = await mountProvider();

    let pending!: Promise<'added' | 'cancelled'>;
    act(() => {
      pending = provider.latest().addToQueue(tensionItem('foreign'));
    });
    await answerPrompt(0, 'switch');
    await expect(pending).resolves.toBe('cancelled');

    expect(routerPush).toHaveBeenCalledWith('/boards');
    expect(setActiveBoard).not.toHaveBeenCalled();
    expect(queueUuids(provider.latest())).toEqual([]);
  });

  it('raises ONE prompt for a burst of adds from the same foreign board', async () => {
    const provider = await mountProvider();

    let first!: Promise<'added' | 'cancelled'>;
    let second!: Promise<'added' | 'cancelled'>;
    let third!: Promise<'added' | 'cancelled'>;
    act(() => {
      const { addToQueue } = provider.latest();
      first = addToQueue(tensionItem('bulk-1'));
      second = addToQueue(tensionItem('bulk-2'));
      third = addToQueue(tensionItem('bulk-3'));
    });
    expect(dialog.choose).toHaveBeenCalledTimes(1);

    await answerPrompt(0, 'add');
    await act(async () => {
      await expect(Promise.all([first, second, third])).resolves.toEqual(['added', 'added', 'added']);
    });

    expect(queueUuids(provider.latest())).toEqual(['bulk-1', 'bulk-2', 'bulk-3']);
    expect(queueMutations.addQueueItem).toHaveBeenCalledTimes(3);
  });

  it('keeps an unrelated add made while the prompt is open (no stale queue snapshot)', async () => {
    const provider = await mountProvider();

    let foreign!: Promise<'added' | 'cancelled'>;
    act(() => {
      foreign = provider.latest().addToQueue(tensionItem('foreign'));
    });
    // Same-board add lands immediately, while the prompt is still up.
    await act(async () => {
      await provider.latest().addToQueue(kilterItem('meanwhile'));
    });
    expect(queueUuids(provider.latest())).toEqual(['meanwhile']);

    await answerPrompt(0, 'add');
    await expect(foreign).resolves.toBe('added');

    expect(queueUuids(provider.latest())).toEqual(['meanwhile', 'foreign']);
  });

  it('never re-prompts for a board already sitting in the queue', async () => {
    const provider = await mountProvider();

    let first!: Promise<'added' | 'cancelled'>;
    act(() => {
      first = provider.latest().addToQueue(tensionItem('foreign-1'));
    });
    await answerPrompt(0, 'add');
    await expect(first).resolves.toBe('added');
    expect(dialog.choose).toHaveBeenCalledTimes(1);

    await act(async () => {
      await expect(provider.latest().addToQueue(tensionItem('foreign-2'))).resolves.toBe('added');
    });

    // deriveAcceptedConfigs saw tension:8 in the live queue — no second dialog.
    expect(dialog.choose).toHaveBeenCalledTimes(1);
    expect(queueUuids(provider.latest())).toEqual(['foreign-1', 'foreign-2']);
  });

  it('prompts again for a DIFFERENT foreign board', async () => {
    const provider = await mountProvider();

    let first!: Promise<'added' | 'cancelled'>;
    act(() => {
      first = provider.latest().addToQueue(tensionItem('tension-climb'));
    });
    await answerPrompt(0, 'add');
    await expect(first).resolves.toBe('added');

    let second!: Promise<'added' | 'cancelled'>;
    act(() => {
      second = provider.latest().addToQueue(makeQueueItem('moon-climb', { boardType: 'moonboard', layoutId: 17 }));
    });
    expect(dialog.choose).toHaveBeenCalledTimes(2);
    await answerPrompt(1, 'cancel');
    await expect(second).resolves.toBe('cancelled');

    expect(queueUuids(provider.latest())).toEqual(['tension-climb']);
  });
});
