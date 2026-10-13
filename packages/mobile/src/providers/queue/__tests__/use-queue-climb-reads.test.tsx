// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, StrictMode, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import {
  initialState,
  queueReducer,
  type Climb,
  type ClimbQueueItem,
  type PlaylistSuggestionSource,
} from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { QueueClimbReads, useQueueClimbReads, type QueueClimbReadDemand } from '../use-queue-climb-reads';
import { useQueueResolveClimbs } from '../use-queue-resolve-climbs';
import { useQueueRegrade } from '../use-queue-regrade';
import { createBoardFeedSuggestionSource } from '../../../lib/playlists/board-feed-suggestion-source';

const reads = vi.hoisted(() => ({ request: vi.fn(), generation: 0 }));
vi.mock('../../../lib/graphql/offline-request', () => ({ offlineAwareRequest: reads.request }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({ getPrivacyRevocationGeneration: () => reads.generation }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'generated' }));

function board(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board',
    slug: 'board',
    ownerId: 'owner',
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
    createdAt: '2026-01-01',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
    ...overrides,
  };
}

function climb(uuid: string, angle = 25, thin = false): Climb {
  return {
    uuid,
    angle,
    name: thin ? '' : `Climb ${uuid}`,
    frames: thin ? '' : 'p1r12',
    setter_username: 'setter',
    ascensionist_count: 1,
    difficulty: 'V5',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
  };
}

function item(uuid: string, angle = 25, thin = false): ClimbQueueItem {
  return { uuid: `slot-${uuid}`, climb: climb(uuid, angle, thin) };
}

type Answer = { climb: Climb | null };
function deferred() {
  let resolve!: (answer: Answer) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Answer>((resolveAnswer, rejectAnswer) => {
    resolve = resolveAnswer;
    reject = rejectAnswer;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function harness(
  strict = false,
  deriveDisplay?: (source: PlaylistSuggestionSource | null) => PlaylistSuggestionSource | null,
) {
  return renderHook(
    () => {
      const [activeBoard, setBoard] = useState<UserBoard | null>(board());
      const [generation, setGeneration] = useState(reads.generation);
      const [state, dispatch] = useReducer(queueReducer, {}, initialState);
      const [source, setSource] = useState<PlaylistSuggestionSource | null>(null);
      const displayedSource = deriveDisplay ? deriveDisplay(source) : source;
      const sourceRef = useRef(displayedSource);
      useLayoutEffect(() => {
        sourceRef.current = displayedSource;
      }, [displayedSource]);
      const climbReads = useQueueClimbReads({ activeBoard, privacyRevocationGeneration: generation });
      useQueueRegrade({
        activeBoard,
        privacyRevocationGeneration: generation,
        queue: state.queue,
        currentClimbQueueItem: state.currentClimbQueueItem,
        playlistSuggestionSourceRef: sourceRef,
        playlistSuggestionSource: displayedSource,
        rawPlaylistSuggestionSource: source,
        dispatch,
        setPlaylistSuggestionSourceState: setSource,
        climbReads,
      });
      useQueueResolveClimbs({
        activeBoard,
        privacyRevocationGeneration: generation,
        queue: state.queue,
        currentClimbQueueItem: state.currentClimbQueueItem,
        dispatch,
        climbReads,
      });
      return { state, dispatch, source, displayedSource, setSource, setBoard, setGeneration };
    },
    strict ? { wrapper: ({ children }) => createElement(StrictMode, null, children) } : undefined,
  );
}

describe('queue climb read lifetimes (#6325)', () => {
  beforeEach(() => {
    reads.request.mockReset();
    reads.generation = 0;
    onlineManager.setOnline(true);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    onlineManager.setOnline(true);
  });

  it.each([25, 40])('restores 15 staggered thin references fetched at %i with exactly 15 reads', async (oldAngle) => {
    const pending = new Map<string, ReturnType<typeof deferred>>();
    reads.request.mockImplementation((_document: string, variables: { climbUuid: string }) => {
      const answer = deferred();
      pending.set(variables.climbUuid, answer);
      return answer.promise;
    });
    const { result } = harness();
    const queue = Array.from({ length: 15 }, (_, index) => item(`climb-${index}`, oldAngle, true));
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue, currentClimbQueueItem: queue[0] } }));
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(15);
    for (const [uuid, answer] of pending) {
      await act(async () => {
        answer.resolve({ climb: climb(uuid) });
      });
      expect(reads.request).toHaveBeenCalledTimes(15);
    }
    expect(result.current.state.queue.every((queued) => queued.climb.name && queued.climb.angle === 25)).toBe(true);
  });

  it('retains pending reads across metadata edits and applies the latest slot metadata', async () => {
    const answer = deferred();
    reads.request.mockReturnValue(answer.promise);
    const { result } = harness();
    const original = item('thin', 25, true);
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [original] } }));
    await flush();
    const changed = { ...original, addedBy: 'crew', tickedBy: ['climber'], suggested: true };
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [changed, item('already-ready')] } }));
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer.resolve({ climb: climb('thin') });
    });
    expect(result.current.state.queue[0]).toMatchObject({ addedBy: 'crew', tickedBy: ['climber'], suggested: true });
    expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
  });

  it('shares a read between mirrored current and queue representations', async () => {
    const answer = deferred();
    reads.request.mockReturnValue(answer.promise);
    const { result } = harness();
    const queued = item('thin', 40, true);
    const current = { ...queued, climb: { ...queued.climb, mirrored: true } };
    act(() =>
      result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [queued], currentClimbQueueItem: current } }),
    );
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer.resolve({ climb: climb('thin') });
    });
    expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
    expect(result.current.state.queue[0].climb.mirrored).toBeUndefined();
    expect(result.current.state.currentClimbQueueItem?.climb.name).toBe('Climb thin');
    expect(result.current.state.currentClimbQueueItem?.climb.mirrored).toBe(true);
  });

  it('reads a newly stale FullSync object and new slot after success without a time grace', async () => {
    reads.request.mockImplementation(async (_document: string, variables: { climbUuid: string }) => ({
      climb: climb(variables.climbUuid),
    }));
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(2);
    act(() =>
      result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [{ ...item('thin', 25, true), uuid: 'new-slot' }] },
      }),
    );
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(3);
    expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
  });

  it('recovers when the same batch overwrites hydration with the original thin object', async () => {
    const first = deferred();
    const second = deferred();
    reads.request.mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
    const { result } = harness();
    const original = item('thin', 25, true);
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [original] } }));
    await flush();
    await act(async () => {
      first.resolve({ climb: climb('thin') });
      await Promise.resolve();
      result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [original] } });
    });
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve({ climb: climb('thin') });
    });
    expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
  });

  it('applies a ready regrade while another request is hung', async () => {
    const pending = new Map<string, ReturnType<typeof deferred>>();
    reads.request.mockImplementation((_document: string, variables: { climbUuid: string }) => {
      const answer = deferred();
      pending.set(variables.climbUuid, answer);
      return answer.promise;
    });
    const { result } = harness();
    act(() =>
      result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('ready', 40), item('hung', 40)] } }),
    );
    await flush();
    await act(async () => {
      pending.get('ready')!.resolve({ climb: climb('ready') });
    });
    expect(result.current.state.queue[0].climb.angle).toBe(25);
    expect(result.current.state.queue[1].climb.angle).toBe(40);
    expect(reads.request).toHaveBeenCalledTimes(2);
  });

  it('shares one read for a thin queue reference and a stale playlist peek', async () => {
    const answer = deferred();
    reads.request.mockReturnValue(answer.promise);
    const { result } = harness();
    const current = item('current');
    act(() => {
      result.current.setSource({
        playlistUuid: 'list',
        activatedClimbUuid: 'current',
        boardKey: 'kilter:1:10:1,2',
        climbs: [current.climb, climb('next', 40)],
      });
      result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [item('next', 40, true)], currentClimbQueueItem: current },
      });
    });
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer.resolve({ climb: climb('next') });
    });
    expect(result.current.state.queue[0].climb.angle).toBe(25);
    expect(result.current.source?.climbs[1].angle).toBe(25);
  });

  it('keeps history at its climbed angle and ignores thin and resolved foreign-board climbs', async () => {
    reads.request.mockImplementation(async (_document: string, variables: { climbUuid: string; angle: number }) => ({
      climb: climb(variables.climbUuid, variables.angle),
    }));
    const { result } = harness();
    const history = item('history', 20, true);
    const current = item('current', 40, true);
    const foreignThin = {
      ...item('foreign-thin', 40, true),
      climb: { ...climb('foreign-thin', 40, true), boardType: 'tension' },
    };
    const foreignResolved = { ...item('foreign-ready', 40), climb: { ...climb('foreign-ready', 40), layoutId: 9 } };
    act(() =>
      result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [history, current, foreignThin, foreignResolved], currentClimbQueueItem: current },
      }),
    );
    await flush();
    expect(reads.request.mock.calls.map((call) => [call[1].climbUuid, call[1].angle])).toEqual([
      ['history', 20],
      ['current', 25],
    ]);
    expect(result.current.state.queue[0].climb.angle).toBe(20);
    expect(result.current.state.queue[1].climb.angle).toBe(25);
  });

  it('ignores removed/reused slots and retires the attempt when demand disappears', async () => {
    const oldAnswer = deferred();
    const newAnswer = deferred();
    reads.request.mockReturnValueOnce(oldAnswer.promise).mockReturnValueOnce(newAnswer.promise);
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('old', 25, true)] } }));
    await flush();
    act(() =>
      result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [{ ...item('replacement', 25, true), uuid: 'slot-old' }] },
      }),
    );
    await flush();
    await act(async () => {
      oldAnswer.resolve({ climb: climb('old') });
    });
    expect(result.current.state.queue[0].climb.uuid).toBe('replacement');
    expect(result.current.state.queue[0].climb.name).toBe('');
    await act(async () => {
      newAnswer.resolve({ climb: climb('replacement') });
    });
    expect(result.current.state.queue[0].climb.name).toBe('Climb replacement');
  });

  it.each(['boardType', 'layoutId', 'sizeId', 'setIds', 'angle', 'privacy'] as const)(
    'fences old completions across %s changes',
    async (boundary) => {
      const oldAnswer = deferred();
      const newAnswer = deferred();
      reads.request.mockReturnValueOnce(oldAnswer.promise).mockReturnValue(newAnswer.promise);
      const { result } = harness();
      act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
      await flush();
      act(() => {
        if (boundary === 'privacy') {
          reads.generation++;
          result.current.setGeneration(reads.generation);
        } else {
          const overrides: Partial<UserBoard> =
            boundary === 'boardType'
              ? { boardType: 'tension' }
              : boundary === 'layoutId'
                ? { layoutId: 2 }
                : boundary === 'sizeId'
                  ? { sizeId: 11 }
                  : boundary === 'setIds'
                    ? { setIds: '3' }
                    : { angle: 40 };
          result.current.setBoard(board(overrides));
        }
      });
      await flush();
      await act(async () => {
        oldAnswer.resolve({ climb: climb('thin') });
      });
      expect(result.current.state.queue[0].climb.name).toBe('');
      await act(async () => {
        newAnswer.resolve({ climb: climb('thin', boundary === 'angle' ? 40 : 25) });
      });
      expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
    },
  );

  it('retains reads when the active board object changes without changing scope', async () => {
    const answer = deferred();
    reads.request.mockReturnValue(answer.promise);
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    act(() => result.current.setBoard(board({ name: 'Renamed board' })));
    await flush();
    await act(async () => {
      answer.resolve({ climb: climb('thin') });
    });
    expect(reads.request).toHaveBeenCalledTimes(1);
    expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
  });

  it('preserves request tokens when setScope receives the same serialized scope again', async () => {
    const tracker = new QueueClimbReads();
    tracker.setScope(board(), reads.generation);
    const answer = deferred();
    reads.request.mockReturnValue(answer.promise);
    const apply = vi.fn();
    tracker.register('resolve', [
      { climbUuid: 'thin', angle: 25, expectedClimb: climb('thin', 25, true), targetKey: 'queue:slot', apply },
    ]);
    await flush();
    tracker.setScope(board({ name: 'Renamed' }), reads.generation);
    answer.resolve({ climb: climb('thin') });
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(reads.request).toHaveBeenCalledTimes(1);
    tracker.retire();
  });

  it.each([{ uuid: 'wrong-climb' }, { angle: 40 }, { boardType: 'tension' }, { layoutId: 9 }, { name: '' }])(
    'rejects a response outside its climb/angle/board identity: %j',
    async (overrides) => {
      reads.request.mockResolvedValue({ climb: { ...climb('thin'), ...overrides } });
      const { result } = harness();
      act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
      await flush();
      expect(result.current.state.queue[0].climb.name).toBe('');
      expect(reads.request).toHaveBeenCalledTimes(1);
    },
  );

  it('does not revive a superseded attempt when returning to its earlier angle', async () => {
    const first25 = deferred();
    const answer40 = deferred();
    const second25 = deferred();
    reads.request
      .mockReturnValueOnce(first25.promise)
      .mockReturnValueOnce(answer40.promise)
      .mockReturnValue(second25.promise);
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    act(() => result.current.setBoard(board({ angle: 40 })));
    await flush();
    act(() => result.current.setBoard(board({ angle: 25 })));
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(3);
    await act(async () => {
      first25.resolve({ climb: climb('thin') });
      answer40.resolve({ climb: climb('thin', 40) });
    });
    expect(result.current.state.queue[0].climb.name).toBe('');
    await act(async () => {
      second25.resolve({ climb: climb('thin') });
    });
    expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
  });

  it('retains a pending history read when the live angle changes', async () => {
    const answer = deferred();
    reads.request.mockReturnValue(answer.promise);
    const { result } = harness();
    const history = item('history', 20, true);
    const current = item('current');
    act(() =>
      result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [history, current], currentClimbQueueItem: current },
      }),
    );
    await flush();
    act(() => result.current.setBoard(board({ angle: 40 })));
    await flush();
    expect(reads.request.mock.calls.filter((call) => call[1].climbUuid === 'history')).toHaveLength(1);
    await act(async () => {
      answer.resolve({ climb: climb('history', 20) });
    });
    expect(result.current.state.queue[0].climb.name).toBe('Climb history');
    expect(result.current.state.queue[0].climb.angle).toBe(20);
  });

  it('gives the whole read 20 seconds, retries once after one second, then stops', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const retry = deferred();
    reads.request.mockReturnValueOnce(first.promise).mockReturnValue(retry.promise);
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(reads.request).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(reads.request).toHaveBeenCalledTimes(2);
    await act(async () => {
      first.resolve({ climb: climb('thin') });
    });
    expect(result.current.state.queue[0].climb.name).toBe('');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(reads.request).toHaveBeenCalledTimes(2);
    act(() =>
      result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [...result.current.state.queue, item('ready')] },
      }),
    );
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(2);
    await act(async () => {
      retry.resolve({ climb: climb('thin') });
    });
    expect(result.current.state.queue[0].climb.name).toBe('');
  });

  it('retries recognized transport failures once, and reconnect re-arms exhausted demand', async () => {
    vi.useFakeTimers();
    reads.request.mockRejectedValue(new TypeError('Network request failed'));
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(reads.request).toHaveBeenCalledTimes(2);
    reads.request.mockResolvedValue({ climb: climb('thin') });
    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(3);
    expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
  });

  it.each([
    { response: { status: 500 } },
    { response: { status: 200, errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } },
  ])('bounds server outage retries and re-arms them on reconnect: %j', async (error) => {
    vi.useFakeTimers();
    reads.request.mockRejectedValue(error);
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(reads.request).toHaveBeenCalledTimes(2);
    reads.request.mockResolvedValue({ climb: climb('thin') });
    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(3);
    expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
  });

  it.each([true, false])('reconnect only retries null results recorded offline (online=%s)', async (online) => {
    onlineManager.setOnline(online);
    reads.request.mockResolvedValue({ climb: null });
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    reads.request.mockResolvedValue({ climb: climb('thin') });
    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(online ? 1 : 2);
    expect(result.current.state.queue[0].climb.name).toBe(online ? '' : 'Climb thin');
  });

  it('does not retry a denied read on churn or reconnect', async () => {
    vi.useFakeTimers();
    reads.request.mockRejectedValue({ response: { status: 200, errors: [{ extensions: { code: 'FORBIDDEN' } }] } });
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(1);
  });

  it('recovers when an offline null finishes after connectivity returned', async () => {
    onlineManager.setOnline(false);
    const oldAnswer = deferred();
    reads.request.mockReturnValueOnce(oldAnswer.promise).mockResolvedValue({ climb: climb('thin') });
    const { result } = harness();
    act(() => result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [item('thin', 25, true)] } }));
    await flush();
    act(() => onlineManager.setOnline(true));
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(1);
    await act(async () => {
      oldAnswer.resolve({ climb: null });
    });
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(2);
    expect(result.current.state.queue[0].climb.name).toBe('Climb thin');
  });

  it('marks only the demand snapshot addressed when applying registers a replacement', async () => {
    const tracker = new QueueClimbReads();
    tracker.setScope(board(), reads.generation);
    const first = deferred();
    const second = deferred();
    reads.request.mockReturnValueOnce(first.promise).mockReturnValue(second.promise);
    const replacementApply = vi.fn();
    tracker.register('resolve', [
      {
        climbUuid: 'thin',
        angle: 25,
        expectedClimb: climb('thin', 25, true),
        targetKey: 'queue:slot',
        apply: () =>
          tracker.register('resolve', [
            {
              climbUuid: 'thin',
              angle: 25,
              expectedClimb: climb('thin', 25, true),
              targetKey: 'queue:slot',
              apply: replacementApply,
            },
          ]),
      },
    ]);
    await flush();
    first.resolve({ climb: climb('thin') });
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(2);
    second.resolve({ climb: climb('thin') });
    await flush();
    expect(replacementApply).toHaveBeenCalledTimes(1);
    tracker.retire();
  });

  it('recovers from StrictMode setup replay and hydrates a current-only reference', async () => {
    reads.request.mockResolvedValue({ climb: climb('current') });
    const { result } = harness(true);
    act(() =>
      result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [], currentClimbQueueItem: item('current', 40, true) },
      }),
    );
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(1);
    expect(result.current.state.queue).toEqual([]);
    expect(result.current.state.currentClimbQueueItem?.climb.name).toBe('Climb current');
  });

  it('clears pending deadlines and scheduled retries on unmount', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    reads.request.mockReturnValueOnce(pending.promise).mockRejectedValue(new TypeError('Network request failed'));
    const { result, unmount } = harness();
    act(() =>
      result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [item('hung', 25, true), item('retry', 25, true)] },
      }),
    );
    await flush();
    expect(reads.request).toHaveBeenCalledTimes(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve({ climb: climb('hung') });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(reads.request).toHaveBeenCalledTimes(2);
  });

  it('does not patch a newly activated playlist with an old activation response', async () => {
    const oldAnswer = deferred();
    const newAnswer = deferred();
    reads.request.mockReturnValueOnce(oldAnswer.promise).mockReturnValue(newAnswer.promise);
    const { result } = harness();
    const current = item('current');
    const source: PlaylistSuggestionSource = {
      boardKey: 'kilter:1:10:1,2',
      playlistUuid: 'old-list',
      activatedClimbUuid: 'current',
      climbs: [current.climb, climb('peek', 40)],
    };
    act(() => {
      result.current.setSource(source);
      result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [], currentClimbQueueItem: current } });
    });
    await flush();
    act(() =>
      result.current.setSource({ ...source, playlistUuid: 'new-list', climbs: [current.climb, climb('new-peek', 40)] }),
    );
    await flush();
    await act(async () => {
      oldAnswer.resolve({ climb: climb('peek') });
    });
    expect(result.current.source?.climbs[1].angle).toBe(40);
    await act(async () => {
      newAnswer.resolve({ climb: climb('new-peek') });
    });
    expect(result.current.source?.climbs[1].angle).toBe(25);
  });

  it.each(['separate', 'same-batch'] as const)(
    'patches derived playlist peeks without changing the backing activation (%s answers)',
    async (answerTiming) => {
      const answers = new Map<string, ReturnType<typeof deferred>>();
      reads.request.mockImplementation((_document: string, variables: { climbUuid: string }) => {
        const answer = deferred();
        answers.set(variables.climbUuid, answer);
        return answer.promise;
      });
      const current = item('current');
      const foreign = { ...climb('foreign'), boardType: 'tension', layoutId: 9 };
      const previous = climb('previous', 40);
      const next = climb('next', 40);
      const backing: PlaylistSuggestionSource = {
        playlistUuid: 'backing-list',
        activatedClimbUuid: foreign.uuid,
        boardKey: 'kilter:1:10:1,2',
        climbs: [foreign, previous, current.climb, next],
      };
      const { result } = harness(false, (source) =>
        source
          ? createBoardFeedSuggestionSource({
              anchorClimb: current.climb,
              feedClimbs: source.climbs.filter((listed) => listed !== foreign),
              boardKey: source.boardKey,
            })
          : null,
      );
      act(() => {
        result.current.setSource(backing);
        result.current.dispatch({ type: 'UPDATE_QUEUE', payload: { queue: [], currentClimbQueueItem: current } });
      });
      await flush();
      expect(reads.request).toHaveBeenCalledTimes(2);
      expect(result.current.displayedSource?.playlistUuid).toBe('board-feed');
      await act(async () => {
        answers.get('next')!.resolve({ climb: { ...next, angle: 25, difficulty: 'V6' } });
        if (answerTiming === 'same-batch')
          answers.get('previous')!.resolve({ climb: { ...previous, angle: 25, difficulty: 'V4' } });
      });
      expect(result.current.source?.climbs.find(({ uuid }) => uuid === 'next')?.difficulty).toBe('V6');
      expect(result.current.source).not.toBe(backing);
      if (answerTiming === 'separate') {
        expect(result.current.source?.climbs.find(({ uuid }) => uuid === 'previous')).toBe(previous);
        await act(async () => {
          answers.get('previous')!.resolve({ climb: { ...previous, angle: 25, difficulty: 'V4' } });
        });
      }
      expect(result.current.source?.playlistUuid).toBe('backing-list');
      expect(result.current.source?.activatedClimbUuid).toBe(foreign.uuid);
      expect(
        result.current.displayedSource?.climbs
          .filter((listed) => ['previous', 'next'].includes(listed.uuid))
          .map((listed) => [listed.angle, listed.difficulty]),
      ).toEqual([
        [25, 'V4'],
        [25, 'V6'],
      ]);
      expect(reads.request).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects a captured normalized-peek update after the backing activation changes with the same climb object', async () => {
    const tracker = new QueueClimbReads();
    let demands: QueueClimbReadDemand[] = [];
    vi.spyOn(tracker, 'register').mockImplementation((_owner, registered) => {
      demands = registered;
    });
    const current = item('current');
    const next = climb('next', 40);
    const original: PlaylistSuggestionSource = {
      playlistUuid: 'old-list',
      activatedClimbUuid: 'old-anchor',
      boardKey: 'kilter:1:10:1,2',
      climbs: [current.climb, next],
    };
    const { result } = renderHook(() => {
      const [source, setSource] = useState<PlaylistSuggestionSource | null>(original);
      const displayed = source
        ? createBoardFeedSuggestionSource({
            anchorClimb: current.climb,
            feedClimbs: source.climbs,
            boardKey: source.boardKey,
          })
        : null;
      const sourceRef = useRef(displayed);
      useLayoutEffect(() => {
        sourceRef.current = displayed;
      }, [displayed]);
      useQueueRegrade({
        activeBoard: board(),
        queue: [],
        currentClimbQueueItem: current,
        playlistSuggestionSourceRef: sourceRef,
        playlistSuggestionSource: displayed,
        rawPlaylistSuggestionSource: source,
        climbReads: tracker,
        dispatch: vi.fn(),
        setPlaylistSuggestionSourceState: setSource,
      });
      return { source, setSource };
    });
    const capturedApply = demands.find((demand) => demand.climbUuid === next.uuid)!.apply;
    const replacement = { ...original, playlistUuid: 'new-list', activatedClimbUuid: 'new-anchor' };
    act(() => result.current.setSource(replacement));
    expect(result.current.source?.climbs[1]).toBe(next);
    act(() => capturedApply({ ...next, angle: 25, difficulty: 'V9' }));
    expect(result.current.source).toBe(replacement);
    expect(result.current.source?.climbs[1].difficulty).toBe('V5');
    expect(reads.request).not.toHaveBeenCalled();
    tracker.retire();
  });
});
