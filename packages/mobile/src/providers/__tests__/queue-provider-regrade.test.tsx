// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';

// Self-contained QueueProvider harness (mirrors queue-provider-session-updates.test.tsx)
// scoped to the angle-change re-grade of the displayed playlist suggestion peek.

const ws = vi.hoisted(() => ({
  client: {
    on: vi.fn(() => vi.fn()),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

const graph = vi.hoisted(() => ({ execute: vi.fn() }));
const http = vi.hoisted(() => ({ request: vi.fn() }));

const activeBoard = vi.hoisted(() => ({
  stored: {
    uuid: 'board-1',
    slug: 'board-1',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'Test board',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 25,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
  } satisfies UserBoard,
  getStoredActiveBoard: vi.fn(),
}));

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
  setSessionBoardPath: vi.fn(async () => {}),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-correlation-id' }));
vi.mock('@boardsesh/graphql-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/graphql-client')>()),
  execute: graph.execute,
}));
vi.mock('@boardsesh/queue-react', () => ({ useQueueMutations: () => queueMutations }));
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  emitWallConfirm: vi.fn(),
}));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => ws.client }));
// Solo (no session) keeps the regrade path isolated from join/subscription noise.
vi.mock('../../lib/session-store', () => ({
  getStoredSessionId: vi.fn(async () => null),
  setStoredSessionId: vi.fn(async () => {}),
  clearStoredSessionId: vi.fn(async () => {}),
  // Device provenance for the leave-vs-end emphasis (#3502).
  getStoredCreatedSessionId: vi.fn(async () => null),
  setStoredCreatedSessionId: vi.fn(async () => {}),
  clearStoredCreatedSessionId: vi.fn(async () => {}),
}));
vi.mock('../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: vi.fn(async () => null),
  setStoredQueueSnapshot: vi.fn(async () => {}),
  clearStoredQueueSnapshot: vi.fn(async () => {}),
}));
vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard: activeBoard.getStoredActiveBoard }));
vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => vi.fn(async () => {}),
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn(), registerRenderSuperProperties: vi.fn() }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../queue-snackbar-provider', () => ({ useQueueSnackbar: () => ({ showQueueAddedSnackbar: vi.fn() }) }));
// The cross-board add gate calls useChoose()/useQueryClient()/expo-router, none of
// which this harness mounts. Pass every add straight through — the gate's own
// behaviour is covered by queue-provider-cross-board-add.test.tsx.
vi.mock('../queue/use-cross-board-add-gate', () => ({
  useCrossBoardAddGate: () => async () => ({ outcome: 'add' }),
}));
vi.mock('../party-profile-provider', () => ({
  usePartyProfile: () => ({ username: undefined, avatarUrl: undefined }),
}));

import { QueueProvider, usePlaylistSuggestionSource, useQueue } from '../queue-provider';

type Snapshot = {
  state: ReturnType<typeof useQueue>['state'];
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  setCurrentClimb: ReturnType<typeof useQueue>['setCurrentClimb'];
  setQueue: ReturnType<typeof useQueue>['setQueue'];
};

function makeClimb(uuid: string, angle: number, difficulty: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1r12',
    setter_username: 'setter',
    angle,
    ascensionist_count: 0,
    difficulty,
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
  };
}

function makeItem(climb: Climb): ClimbQueueItem {
  return { uuid: climb.uuid, climb, suggested: false };
}

function Probe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const queue = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  useEffect(() => {
    onSnapshot({
      state: queue.state,
      playlistSuggestionSource,
      setCurrentClimb: queue.setCurrentClimb,
      setQueue: queue.setQueue,
    });
  }, [queue.state, playlistSuggestionSource, queue.setCurrentClimb, queue.setQueue, onSnapshot]);
  return null;
}

describe('QueueProvider angle-change re-grade of the playlist suggestion peek', () => {
  beforeEach(() => {
    ws.client.on.mockClear();
    ws.client.subscribe.mockClear();
    activeBoard.getStoredActiveBoard.mockReset();
    activeBoard.getStoredActiveBoard.mockResolvedValue(activeBoard.stored);
    for (const mutation of Object.values(queueMutations) as Array<ReturnType<typeof vi.fn>>) {
      mutation.mockReset();
      mutation.mockResolvedValue(undefined);
    }
    graph.execute.mockReset();
    http.request.mockReset();
  });

  it('re-grades the next-up source climb to the live board angle and patches the source', async () => {
    // Current climb is already at the live angle (25); the next playlist climb
    // carries a stale grade baked at 40, so it must be re-graded to 25.
    const currentClimb = makeClimb('climb-current', 25, 'V3');
    const nextClimb = makeClimb('climb-next', 40, 'V7');
    const source: PlaylistSuggestionSource = {
      playlistUuid: 'playlist-1',
      activatedClimbUuid: 'climb-current',
      boardKey: 'kilter:1:10:1,2',
      climbs: [currentClimb, nextClimb],
    };

    // GET_CLIMB for the next climb at angle 25 returns the angle-25 grade.
    http.request.mockImplementation(async (_query: string, variables: { climbUuid: string; angle: number }) => {
      if (variables.climbUuid === 'climb-next' && variables.angle === 25) {
        return { climb: makeClimb('climb-next', 25, 'V5') };
      }
      return { climb: null };
    });

    const snapshots: Snapshot[] = [];
    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (snap) => snapshots.push(snap) })));

    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

    // Activate the playlist: current climb + suggestion source. The peek resolves
    // to the next source climb (baked at 40).
    await act(async () => {
      snapshots.at(-1)?.setCurrentClimb(makeItem(currentClimb), { playlistSuggestionSource: source });
    });

    // The self-healing re-grade effect re-fetches the peek climb at the live angle
    // and patches it back into the suggestion source.
    await waitFor(() => {
      const patched = snapshots.at(-1)?.playlistSuggestionSource?.climbs.find((climb) => climb.uuid === 'climb-next');
      expect(patched?.angle).toBe(25);
      expect(patched?.difficulty).toBe('V5');
    });

    // It fetched ONLY the displayed next-up climb, never the whole playlist.
    const fetchedUuids = http.request.mock.calls.map((call) => (call[1] as { climbUuid: string }).climbUuid);
    expect(fetchedUuids).toContain('climb-next');
    expect(fetchedUuids).not.toContain('climb-current');
  });

  it('re-grades the previous-in-list peek a back swipe can land on (#4829)', async () => {
    // Swipes are list-first, so a back swipe from the current climb shows the
    // list predecessor — which is NOT in the queue and carries the grade baked at
    // activation (40). It must be re-graded to the live angle (25) like the
    // next-up peek.
    const prevClimb = makeClimb('climb-prev', 40, 'V6');
    const currentClimb = makeClimb('climb-current', 25, 'V3');
    const nextClimb = makeClimb('climb-next', 40, 'V7');
    const source: PlaylistSuggestionSource = {
      playlistUuid: 'playlist-1',
      activatedClimbUuid: 'climb-current',
      boardKey: 'kilter:1:10:1,2',
      climbs: [prevClimb, currentClimb, nextClimb],
    };

    http.request.mockImplementation(async (_query: string, variables: { climbUuid: string; angle: number }) => {
      if (variables.angle !== 25) return { climb: null };
      if (variables.climbUuid === 'climb-prev') return { climb: makeClimb('climb-prev', 25, 'V4') };
      if (variables.climbUuid === 'climb-next') return { climb: makeClimb('climb-next', 25, 'V5') };
      return { climb: null };
    });

    const snapshots: Snapshot[] = [];
    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (snap) => snapshots.push(snap) })));
    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

    await act(async () => {
      snapshots.at(-1)?.setCurrentClimb(makeItem(currentClimb), { playlistSuggestionSource: source });
    });

    await waitFor(() => {
      const climbs = snapshots.at(-1)?.playlistSuggestionSource?.climbs ?? [];
      const prev = climbs.find((climb) => climb.uuid === 'climb-prev');
      const next = climbs.find((climb) => climb.uuid === 'climb-next');
      expect(prev?.angle).toBe(25);
      expect(prev?.difficulty).toBe('V4');
      expect(next?.angle).toBe(25);
    });

    const fetchedUuids = http.request.mock.calls.map((call) => (call[1] as { climbUuid: string }).climbUuid);
    expect(fetchedUuids).toContain('climb-prev');
    expect(fetchedUuids).toContain('climb-next');
    expect(fetchedUuids).not.toContain('climb-current');
  });

  it('re-grades upcoming items but never re-fetches history on angle change', async () => {
    // Live board angle is 25. Queue laid out as [history, current, upcoming]:
    //   - history climb baked at 40 (already sent — keeps its climbed-at angle)
    //   - current climb already at the live angle 25 (nothing to fetch)
    //   - upcoming climb baked at 40 (stale — must be re-graded to 25)
    // Only the upcoming climb should be fetched; history must be left alone.
    const historyClimb = makeClimb('climb-history', 40, 'V7');
    const currentClimb = makeClimb('climb-current', 25, 'V3');
    const upcomingClimb = makeClimb('climb-upcoming', 40, 'V6');

    http.request.mockImplementation(async (_query: string, variables: { climbUuid: string; angle: number }) => {
      if (variables.climbUuid === 'climb-upcoming' && variables.angle === 25) {
        return { climb: makeClimb('climb-upcoming', 25, 'V4') };
      }
      return { climb: null };
    });

    const snapshots: Snapshot[] = [];
    render(createElement(QueueProvider, null, createElement(Probe, { onSnapshot: (snap) => snapshots.push(snap) })));

    await waitFor(() => expect(snapshots.at(-1)).toBeTruthy());

    // Seed the exact history/current/upcoming arrangement. The current item is
    // in the queue so the history/upcoming split is positional (currentIndex 1).
    await act(async () => {
      snapshots
        .at(-1)
        ?.setQueue([makeItem(historyClimb), makeItem(currentClimb), makeItem(upcomingClimb)], makeItem(currentClimb));
    });

    // The upcoming climb is re-graded to the live angle.
    await waitFor(() => {
      const patched = snapshots.at(-1)?.state.queue.find((item) => item.climb.uuid === 'climb-upcoming');
      expect(patched?.climb.angle).toBe(25);
      expect(patched?.climb.difficulty).toBe('V4');
    });

    const fetchedUuids = http.request.mock.calls.map((call) => (call[1] as { climbUuid: string }).climbUuid);
    expect(fetchedUuids).toContain('climb-upcoming');
    // History is never fetched, and the already-live current item isn't either.
    expect(fetchedUuids).not.toContain('climb-history');
    expect(fetchedUuids).not.toContain('climb-current');

    // History keeps the grade for the angle it was climbed at.
    const history = snapshots.at(-1)?.state.queue.find((item) => item.climb.uuid === 'climb-history');
    expect(history?.climb.angle).toBe(40);
    expect(history?.climb.difficulty).toBe('V7');
  });
});
