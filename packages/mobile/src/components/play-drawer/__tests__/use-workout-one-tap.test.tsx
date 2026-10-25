// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { logbookClimbAngleKey, type LogbookEntry, type SaveTickOptions } from '@boardsesh/board-react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import type { Climb } from '@boardsesh/shared-schema';

// One-tap Fell / Sent in a timed workout block (#6231). The save runs through the
// real useTickSaver, so these pin what the climber's tap writes: the tick, its
// flash rule, and what the rest timer and the workout's tick log hear about it.
// The mutation itself is a double that settles at once, except where a test
// saves through React Query to pin what happens when the row is gone first.
// While the row is up it says what a tap did (the notice); the toast is only for
// a save that lands after the row is gone, since the player hides root toasts.

const CLIMB_UUID = 'climb-1';
const QUEUE_ITEM_UUID = 'item-1';
const SESSION_ID = 'session-1';
const ANGLE = 40;
const START_MS = 1_760_000_000_000;

const saveMock = vi.hoisted(() => {
  const state = {
    failure: null as unknown,
    isPending: false,
    result: undefined as { savedTick: { uuid: string } } | undefined,
    /** Save through a real React Query mutation instead of the double. */
    throughReactQuery: false,
  };
  return {
    state,
    // Settles before it returns: `then` runs its handler at once, so a tap's side
    // effects are done when the tap returns.
    mutateAsync: vi.fn((_input: unknown) => ({
      // oxlint-disable-next-line unicorn/no-thenable -- a save double that settles before it returns
      then: (onSaved: (result: unknown) => void, onFailed: (error: unknown) => void) => {
        if (state.failure) onFailed(state.failure);
        else onSaved(state.result);
      },
    })),
  };
});
const boardState = vi.hoisted(() => ({ current: null as unknown }));
const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
const presenceState = vi.hoisted(() => ({ enabled: false, boardId: null as number | null }));
const activeBoardState = vi.hoisted(() => ({
  current: null as { uuid?: string; boardType: string; layoutId: number; sizeId: number; setIds: string } | null,
}));

// Keeps the climb name a toast carries, so a test can tell which climb it named.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key),
  }),
}));
vi.mock('@boardsesh/analytics', async (importOriginal) => {
  const { boardTypeProperty } = await importOriginal<typeof import('@boardsesh/analytics')>();
  return {
    boardTypeProperty,
    SHARED_EVENTS: { QuickTickFailed: 'Quick Tick Failed', TickLogged: 'Tick Logged' },
  };
});
vi.mock('@boardsesh/board-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-react')>();
  const { useMutation } = await import('@tanstack/react-query');
  return {
    ...actual,
    useOptionalBoardActions: () => boardState.current,
    useOptionalBoardLogbook: () => boardState.current,
    useSaveTick: () => {
      const reactQuerySave = useMutation({
        mutationFn: (input: unknown) => Promise.resolve(saveMock.mutateAsync(input)),
      });
      return saveMock.state.throughReactQuery
        ? reactQuerySave
        : { mutateAsync: saveMock.mutateAsync, isPending: saveMock.state.isPending };
    },
  };
});
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toastMock }));
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => presenceState,
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoardState.current }),
}));
vi.mock('../../../providers/rogue-timer-provider', () => ({ useOptionalRogueTimer: () => null }));
vi.mock('../../../hooks/use-local-ticks', () => ({ useLocalPendingTicks: () => ({ data: 0 }) }));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => false }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: vi.fn() }));
vi.mock('../../../lib/clock', () => ({ nowMs: () => START_MS, nowDate: () => new Date(START_MS) }));
vi.mock('../../../lib/preference-store', () => ({
  getPreference: vi.fn(async () => null),
  setPreference: vi.fn(async () => {}),
  removePreference: vi.fn(async () => {}),
}));
vi.mock('../../../hooks/use-effective-rest-pacing', () => ({
  getEffectiveRestPacing: () => ({ mode: 'afterTick' }),
}));
vi.mock('../../../lib/rest-timer-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/rest-timer-store')>();
  return { ...actual, noteRestTimerTick: vi.fn() };
});
vi.mock('../../privacy/use-publication-audience', () => ({
  usePublicationAudience: () => ({
    enabled: false,
    isPrivate: false,
    audience: 'public',
    publication: undefined,
    chooseAudience: () => {},
  }),
}));

import { MESSAGE_NOTICE_MS, ONE_TAP_GUARD_MS, SAVED_NOTICE_MS, useWorkoutOneTap } from '../use-workout-one-tap';
import { WALL_MOVED_GRACE_MS, type WorkoutOutcomeTarget } from '../workout-outcome';
import { track } from '../../../lib/analytics';
import { hapticError, hapticSuccess } from '../../../lib/haptics';
import { announceQueued } from '../../../lib/announce-queued';
import { noteRestTimerTick } from '../../../lib/rest-timer-store';
import {
  getWorkoutRunLog,
  noteWorkoutRunTick,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
} from '../../../lib/workout-run-store';
import { QueueActionsContext } from '../../../providers/queue/queue-contexts';

const LIMIT_RUN: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['warm-1'] },
    {
      id: 'limit',
      kind: 'limitBouldering',
      itemUuids: [QUEUE_ITEM_UUID, 'item-2'],
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
  ],
};

function climb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: CLIMB_UUID,
    name: 'Crimp line',
    // The angle the queue item is up at: a one-tap counts for it only there.
    angle: ANGLE,
    ascensionist_count: 12,
    benchmark_difficulty: null,
    ...overrides,
  } as Climb;
}

function target(overrides: Partial<WorkoutOutcomeTarget> = {}): WorkoutOutcomeTarget {
  return {
    climb: climb(),
    queueItemUuid: QUEUE_ITEM_UUID,
    sessionId: SESSION_ID,
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: ANGLE,
    isMirror: false,
    ...overrides,
  };
}

/** The committed current queue item, as the queue provider's snapshot reports it. */
const queueSnapshot = { current: { uuid: QUEUE_ITEM_UUID, climb: { uuid: CLIMB_UUID } } as unknown };
const queueActions = {
  getQueueSnapshot: () => ({ queue: [], currentClimbQueueItem: queueSnapshot.current, playlistSuggestionSource: null }),
} as unknown as NonNullable<React.ContextType<typeof QueueActionsContext>>;
let queryClient = new QueryClient();
const withQueue = ({ children }: { children: ReactNode }) =>
  createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(QueueActionsContext.Provider, { value: queueActions }, children),
  );

function renderOneTap(initialTarget = target(), openLogSheet = vi.fn()) {
  const rendered = renderHook(
    (props: { target: WorkoutOutcomeTarget }) => useWorkoutOneTap(props.target, openLogSheet),
    {
      initialProps: { target: initialTarget },
      wrapper: withQueue,
    },
  );
  return { ...rendered, openLogSheet };
}

/** A logbook that has been fetched for the climb, holding `count` ticks at the angle (`isAscent` says which kind). */
function logbook(count: number, isAscent = false) {
  return {
    logbook: [],
    logbookByClimbAngle: new Map<string, LogbookEntry[]>(
      count > 0
        ? [
            [
              logbookClimbAngleKey(CLIMB_UUID, ANGLE),
              Array.from(
                { length: count },
                () => ({ climb_uuid: CLIMB_UUID, angle: ANGLE, is_ascent: isAscent }) as unknown as LogbookEntry,
              ),
            ],
          ]
        : [],
    ),
    fetchedLogbookClimbUuids: new Set([CLIMB_UUID]),
    getLogbook: vi.fn(),
  };
}

function sentInput(callIndex = 0): SaveTickOptions {
  return saveMock.mutateAsync.mock.calls[callIndex][0] as SaveTickOptions;
}

/** Moves the wall clock the tap guard reads. */
function advanceClock(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START_MS);
  saveMock.mutateAsync.mockClear();
  saveMock.state.failure = null;
  saveMock.state.isPending = false;
  saveMock.state.result = { savedTick: { uuid: 'tick-1' } };
  saveMock.state.throughReactQuery = false;
  queryClient = new QueryClient();
  boardState.current = logbook(0);
  presenceState.enabled = false;
  presenceState.boardId = null;
  activeBoardState.current = null;
  queueSnapshot.current = { uuid: QUEUE_ITEM_UUID, climb: { uuid: CLIMB_UUID } };
  toastMock.showToast.mockClear();
  vi.mocked(hapticSuccess).mockClear();
  vi.mocked(hapticError).mockClear();
  vi.mocked(announceQueued).mockClear();
  vi.mocked(track).mockClear();
  vi.mocked(noteRestTimerTick).mockClear();
  resetWorkoutRunStoreForTests();
  setWorkoutRun(SESSION_ID, LIMIT_RUN);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWorkoutOneTap: Fell', () => {
  it('logs one try at once, for the session, from the workout runner', () => {
    const { result } = renderOneTap();

    act(() => result.current.onFell());

    expect(saveMock.mutateAsync).toHaveBeenCalledTimes(1);
    expect(sentInput()).toMatchObject({
      climbUuid: CLIMB_UUID,
      status: 'attempt',
      attemptCount: 1,
      angle: ANGLE,
      isMirror: false,
      quality: null,
      difficulty: null,
      comment: '',
      sessionId: SESSION_ID,
      climbedAt: new Date(START_MS).toISOString(),
    });
    expect(track).toHaveBeenCalledWith(
      'Tick Logged',
      expect.objectContaining({ surface: 'mobile_workout_runner', status: 'attempt', attemptCount: 1 }),
    );
    expect(result.current.notice).toEqual({
      kind: 'saved',
      status: 'attempt',
      queueItemUuid: QUEUE_ITEM_UUID,
      message: 'playView.workoutOutcome.attemptLogged:Crimp line',
    });
  });

  it('tells the rest timer and the workout’s tick log which queue item fell', () => {
    const { result } = renderOneTap();

    act(() => result.current.onFell());

    expect(noteRestTimerTick).toHaveBeenCalledWith(
      new Date(START_MS).toISOString(),
      'afterTick',
      START_MS,
      { status: 'attempt', queueItemUuid: QUEUE_ITEM_UUID },
      START_MS,
    );
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([
      {
        queueItemUuid: QUEUE_ITEM_UUID,
        status: 'attempt',
        climbedAt: new Date(START_MS).toISOString(),
        tickUuid: 'tick-1',
      },
    ]);
  });

  it('still logs a fall at another angle than the climb is up at, but for no queue item', () => {
    // The board moved to 45° and the queue has not regraded the climb yet.
    const { result } = renderOneTap(target({ angle: 45 }));

    act(() => result.current.onFell());

    expect(sentInput()).toMatchObject({ climbUuid: CLIMB_UUID, status: 'attempt', angle: 45 });
    expect(noteRestTimerTick).toHaveBeenCalledWith(
      expect.any(String),
      'afterTick',
      START_MS,
      { status: 'attempt', queueItemUuid: null },
      START_MS,
    );
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([]);
  });

  it('dates the go by the app clock, which screenshot mode freezes', () => {
    const { result } = renderOneTap();

    // The wall clock moves on; the app clock (mocked here as frozen) does not.
    advanceClock(90_000);
    act(() => result.current.onFell());

    expect(sentInput()).toMatchObject({ climbedAt: new Date(START_MS).toISOString() });
  });

  it('never sends a climb revision: revisions were retired and the server ignores one', () => {
    const { result } = renderOneTap(target({ boardName: 'spray', climb: climb({ ascensionist_count: 0 }) }));

    act(() => result.current.onFell());

    expect(sentInput()).not.toHaveProperty('climbRevision');
  });

  it('logs each fall as its own tick, so an early end loses none', () => {
    const { result } = renderOneTap();

    act(() => result.current.onFell());
    advanceClock(ONE_TAP_GUARD_MS);
    act(() => result.current.onFell());
    advanceClock(ONE_TAP_GUARD_MS);
    act(() => result.current.onFell());

    expect(saveMock.mutateAsync).toHaveBeenCalledTimes(3);
    expect(getWorkoutRunLog(SESSION_ID).map((entry) => entry.status)).toEqual(['attempt', 'attempt', 'attempt']);
  });

  it('logs a fall on a spray climb nobody has sent: a try sets no grade', () => {
    const { result, openLogSheet } = renderOneTap(
      target({ boardName: 'spray', climb: climb({ ascensionist_count: 0 }) }),
    );

    act(() => result.current.onFell());

    expect(openLogSheet).not.toHaveBeenCalled();
    expect(sentInput()).toMatchObject({ status: 'attempt', attemptCount: 1 });
  });
});

describe('useWorkoutOneTap: Sent', () => {
  it('logs a flash on a climb with no history and no falls here', () => {
    const { result } = renderOneTap();

    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ status: 'flash', attemptCount: 1, sessionId: SESSION_ID });
    expect(noteRestTimerTick).toHaveBeenCalledWith(
      expect.any(String),
      'afterTick',
      START_MS,
      { status: 'flash', queueItemUuid: QUEUE_ITEM_UUID },
      START_MS,
    );
    expect(result.current.notice).toMatchObject({
      kind: 'saved',
      status: 'flash',
      message: 'playView.workoutOutcome.flashLogged:Crimp line',
    });
  });

  it('logs a send when the climber has logged the climb at this angle before', () => {
    boardState.current = logbook(1);
    const { result } = renderOneTap();

    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ status: 'send', attemptCount: 1 });
    expect(result.current.notice).toMatchObject({
      kind: 'saved',
      status: 'send',
      message: 'playView.workoutOutcome.sendLogged:Crimp line',
    });
  });

  it('logs a send after a fall on this queue item, before the logbook has caught up', () => {
    // The logbook still says nothing about the climb: only the workout's own log knows.
    noteWorkoutRunTick(SESSION_ID, { queueItemUuid: QUEUE_ITEM_UUID, status: 'attempt', climbedAt: 'earlier' });
    const { result } = renderOneTap();

    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ status: 'send', attemptCount: 1 });
  });

  it('still flashes when the fall was on another queue item', () => {
    noteWorkoutRunTick(SESSION_ID, { queueItemUuid: 'item-2', status: 'attempt', climbedAt: 'earlier' });
    const { result } = renderOneTap();

    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ status: 'flash' });
  });

  it('logs a send while it can’t know the history, never a phantom flash', () => {
    boardState.current = null;
    const { result } = renderOneTap();

    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ status: 'send' });
  });

  it('opens Log ascent for a spray climb nobody has sent, which needs a grade, and logs nothing', () => {
    const { result, openLogSheet } = renderOneTap(
      target({ boardName: 'spray', climb: climb({ ascensionist_count: 0 }) }),
    );

    act(() => result.current.onSent());

    expect(openLogSheet).toHaveBeenCalledTimes(1);
    expect(saveMock.mutateAsync).not.toHaveBeenCalled();
  });

  it('logs a sent spray climb someone has already sent in one tap', () => {
    const { result, openLogSheet } = renderOneTap(
      target({ boardName: 'spray', climb: climb({ ascensionist_count: 3 }) }),
    );

    act(() => result.current.onSent());

    expect(openLogSheet).not.toHaveBeenCalled();
    expect(saveMock.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('marks a benchmark climb as one', () => {
    const { result } = renderOneTap(target({ climb: climb({ benchmark_difficulty: '22' }) }));

    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ isBenchmark: true, baseAscensionistCount: 12 });
  });
});

describe('useWorkoutOneTap: the tap guard', () => {
  it('drops a second tap within the guard, on either button', () => {
    const { result } = renderOneTap();

    act(() => result.current.onFell());
    advanceClock(ONE_TAP_GUARD_MS - 1);
    act(() => result.current.onFell());
    act(() => result.current.onSent());

    expect(saveMock.mutateAsync).toHaveBeenCalledTimes(1);
    expect(sentInput()).toMatchObject({ status: 'attempt' });
  });

  it('takes the next tap once the guard has passed', () => {
    const { result } = renderOneTap();

    act(() => result.current.onFell());
    advanceClock(ONE_TAP_GUARD_MS);
    act(() => result.current.onSent());

    expect(saveMock.mutateAsync).toHaveBeenCalledTimes(2);
    expect(sentInput(1)).toMatchObject({ status: 'send' });
  });

  it('holds across a climb change, so a double tap astride an advance logs one go', () => {
    const { result, rerender } = renderOneTap();

    act(() => result.current.onSent());
    rerender({ target: target({ climb: climb({ uuid: 'climb-2' }), queueItemUuid: 'item-2' }) });
    act(() => result.current.onSent());

    expect(saveMock.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while a save is still in flight', () => {
    saveMock.state.isPending = true;
    const { result } = renderOneTap();

    act(() => result.current.onFell());

    expect(saveMock.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.notice).toBeNull();
    expect(toastMock.showToast).not.toHaveBeenCalled();
  });
});

describe('useWorkoutOneTap: failure', () => {
  it('says why in the row and leaves the workout’s log alone', () => {
    saveMock.state.failure = new Error('Server said no');
    const { result } = renderOneTap();

    act(() => result.current.onFell());

    expect(result.current.notice).toEqual({ kind: 'message', tone: 'error', message: 'Server said no' });
    expect(toastMock.showToast).not.toHaveBeenCalled();
    // One buzz: the saver's. No success haptic for a go that didn't save.
    expect(hapticError).toHaveBeenCalledTimes(1);
    expect(hapticSuccess).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledWith('Server said no');
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([]);
    expect(noteRestTimerTick).not.toHaveBeenCalled();
    // Told apart from a Log ascent sheet failure, which has a Quick Tick Opened before it.
    expect(track).toHaveBeenCalledExactlyOnceWith('Quick Tick Failed', {
      climbUuid: CLIMB_UUID,
      layoutId: 1,
      surface: 'mobile_workout_runner',
    });
  });
});

// The row lives only while it shows: a swipe to a preview, the wall moving out of
// the timed block, or closing the player unmounts it, and a save can still be in
// flight then (a 9 s local-write budget under lock contention, a network round
// trip on the web). React Query drops a per-call `mutate` callback once the row's
// observer is gone, so these save through React Query itself.
describe('useWorkoutOneTap: the row is gone before the save lands', () => {
  function deferSave() {
    const settle: { resolve: (result: unknown) => void; reject: (error: unknown) => void } = {
      resolve: () => {},
      reject: () => {},
    };
    saveMock.mutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          settle.resolve = resolve;
          settle.reject = reject;
        }) as unknown as ReturnType<typeof saveMock.mutateAsync>,
    );
    return settle;
  }

  it('still tells the rest timer, the workout’s log and analytics, and says so', async () => {
    saveMock.state.throughReactQuery = true;
    const settle = deferSave();
    const { result, unmount } = renderOneTap();

    act(() => result.current.onFell());
    unmount();
    // React Query reaches the mutation function a few microtasks after the tap.
    await vi.waitFor(() => expect(saveMock.mutateAsync).toHaveBeenCalledTimes(1));
    settle.resolve({ savedTick: { uuid: 'tick-7' } });

    await vi.waitFor(() => expect(noteRestTimerTick).toHaveBeenCalledTimes(1));
    expect(noteRestTimerTick).toHaveBeenCalledWith(
      new Date(START_MS).toISOString(),
      'afterTick',
      START_MS,
      { status: 'attempt', queueItemUuid: QUEUE_ITEM_UUID },
      START_MS,
    );
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([
      {
        queueItemUuid: QUEUE_ITEM_UUID,
        status: 'attempt',
        climbedAt: new Date(START_MS).toISOString(),
        tickUuid: 'tick-7',
      },
    ]);
    expect(track).toHaveBeenCalledWith('Tick Logged', expect.objectContaining({ surface: 'mobile_workout_runner' }));
    // No row left to say it, so the toast does, and it owns the haptic.
    expect(toastMock.showToast).toHaveBeenCalledWith('playView.workoutOutcome.attemptLogged:Crimp line', 'success');
    expect(hapticSuccess).not.toHaveBeenCalled();
    expect(announceQueued).not.toHaveBeenCalled();
  });

  it('still says why a save failed', async () => {
    saveMock.state.throughReactQuery = true;
    const settle = deferSave();
    const { result, unmount } = renderOneTap();

    act(() => result.current.onSent());
    unmount();
    await vi.waitFor(() => expect(saveMock.mutateAsync).toHaveBeenCalledTimes(1));
    settle.reject(new Error('Server said no'));

    await vi.waitFor(() => expect(toastMock.showToast).toHaveBeenCalledWith('Server said no', 'error'));
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([]);
  });
});

describe('useWorkoutOneTap: the wall', () => {
  it('logs each tap on the wall as it is then, so a board bound mid-block counts', () => {
    presenceState.enabled = true;
    activeBoardState.current = { uuid: 'wall-1', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
    const { result, rerender } = renderOneTap();

    act(() => result.current.onFell());
    // The climber connects from the bulb while the same climb stays up.
    presenceState.boardId = 4242;
    rerender({ target: target() });
    advanceClock(ONE_TAP_GUARD_MS);
    act(() => result.current.onFell());

    expect(sentInput(0)).not.toHaveProperty('boardId');
    expect(sentInput(1)).toMatchObject({ climbUuid: CLIMB_UUID, boardId: 4242, boardUuid: 'wall-1' });
  });
});

describe('useWorkoutOneTap: a spray climb the climber sent first', () => {
  const firstAscentTarget = () => target({ boardName: 'spray', climb: climb({ ascensionist_count: 0 }) });

  it('logs a later Sent in one tap once this block has their send', () => {
    // The queue's copy of the climb still says nobody has sent it.
    noteWorkoutRunTick(SESSION_ID, { queueItemUuid: QUEUE_ITEM_UUID, status: 'send', climbedAt: 'earlier' });
    const { result, openLogSheet } = renderOneTap(firstAscentTarget());

    act(() => result.current.onSent());

    expect(openLogSheet).not.toHaveBeenCalled();
    expect(sentInput()).toMatchObject({ status: 'send', attemptCount: 1 });
  });

  it('logs a later Sent in one tap once their logbook has an ascent at this angle', () => {
    boardState.current = logbook(1, true);
    const { result, openLogSheet } = renderOneTap(firstAscentTarget());

    act(() => result.current.onSent());

    expect(openLogSheet).not.toHaveBeenCalled();
    expect(sentInput()).toMatchObject({ status: 'send' });
  });

  it('still opens Log ascent when the block only has their falls', () => {
    noteWorkoutRunTick(SESSION_ID, { queueItemUuid: QUEUE_ITEM_UUID, status: 'attempt', climbedAt: 'earlier' });
    boardState.current = logbook(1, false);
    const { result, openLogSheet } = renderOneTap(firstAscentTarget());

    act(() => result.current.onSent());

    expect(openLogSheet).toHaveBeenCalledTimes(1);
    expect(saveMock.mutateAsync).not.toHaveBeenCalled();
  });
});

// An on-the-minute beat moves the wall whether the climber logged or not, so a
// climber who topped out just before it taps after it.
describe('useWorkoutOneTap: just after the wall moved on', () => {
  const NEXT_QUEUE_ITEM_UUID = 'item-2';
  const nextTarget = () =>
    target({ climb: climb({ uuid: 'climb-2', name: 'Pinch roof' }), queueItemUuid: NEXT_QUEUE_ITEM_UUID });

  function moveTheWall(rerender: (props: { target: WorkoutOutcomeTarget }) => void) {
    queueSnapshot.current = { uuid: NEXT_QUEUE_ITEM_UUID, climb: { uuid: 'climb-2' } };
    rerender({ target: nextTarget() });
  }

  it('logs the tap for the climb the wall left, against its queue item, and names it', () => {
    const { result, rerender } = renderOneTap();

    moveTheWall(rerender);
    advanceClock(WALL_MOVED_GRACE_MS - 1);
    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ climbUuid: CLIMB_UUID, status: 'flash' });
    expect(noteRestTimerTick).toHaveBeenCalledWith(
      expect.any(String),
      'afterTick',
      START_MS,
      { status: 'flash', queueItemUuid: QUEUE_ITEM_UUID },
      START_MS,
    );
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([expect.objectContaining({ queueItemUuid: QUEUE_ITEM_UUID })]);
    // The notice keeps the queue item it logged, so the row can name the climb
    // that is no longer on screen.
    expect(result.current.notice).toEqual({
      kind: 'saved',
      status: 'flash',
      queueItemUuid: QUEUE_ITEM_UUID,
      message: 'playView.workoutOutcome.flashLogged:Crimp line',
    });
  });

  it('keeps the flash rule of the climb it left: a fall there makes it a send', () => {
    noteWorkoutRunTick(SESSION_ID, { queueItemUuid: QUEUE_ITEM_UUID, status: 'attempt', climbedAt: 'earlier' });
    const { result, rerender } = renderOneTap();

    moveTheWall(rerender);
    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ climbUuid: CLIMB_UUID, status: 'send' });
  });

  it('logs the climb now on the wall once the grace has passed', () => {
    const { result, rerender } = renderOneTap();

    moveTheWall(rerender);
    advanceClock(WALL_MOVED_GRACE_MS);
    act(() => result.current.onFell());

    expect(sentInput()).toMatchObject({ climbUuid: 'climb-2', status: 'attempt' });
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([expect.objectContaining({ queueItemUuid: NEXT_QUEUE_ITEM_UUID })]);
    expect(result.current.notice).toEqual({
      kind: 'saved',
      status: 'attempt',
      queueItemUuid: NEXT_QUEUE_ITEM_UUID,
      message: 'playView.workoutOutcome.attemptLogged:Pinch roof',
    });
  });

  it('says where to log a first ascent on the climb it left, since the sheet would open on the new one', () => {
    const { result, rerender, openLogSheet } = renderOneTap(
      target({ boardName: 'spray', climb: climb({ ascensionist_count: 0 }) }),
    );

    queueSnapshot.current = { uuid: NEXT_QUEUE_ITEM_UUID, climb: { uuid: 'climb-2' } };
    rerender({
      target: target({
        boardName: 'spray',
        climb: climb({ uuid: 'climb-2', name: 'Pinch roof', ascensionist_count: 4 }),
        queueItemUuid: NEXT_QUEUE_ITEM_UUID,
      }),
    });
    act(() => result.current.onSent());

    expect(openLogSheet).not.toHaveBeenCalled();
    expect(saveMock.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({
      kind: 'message',
      tone: 'info',
      message: 'playView.workoutOutcome.wallMovedFirstAscent:Crimp line',
    });
  });

  it('treats a refreshed copy of the same queue item as no move', () => {
    const { result, rerender } = renderOneTap();

    rerender({ target: target({ climb: climb({ name: 'Crimp line (renamed)' }) }) });
    act(() => result.current.onSent());

    expect(result.current.notice).toMatchObject({
      queueItemUuid: QUEUE_ITEM_UUID,
      message: 'playView.workoutOutcome.flashLogged:Crimp line (renamed)',
    });
  });
});

// The player is a native modal on iOS and the root toast overlay draws behind
// it, so while the row is up it is the row that says what a tap did.
// The wall left the timed block (an on-the-minute beat onto a climb outside
// it), so the player holds the row for the climb it left: a tap already on its
// way to Fell must land there, never on the next climb and never on the angle
// button the normal row puts in the same place.
describe('useWorkoutOneTap: held for the climb the wall left', () => {
  const COOL_DOWN_ITEM = 'item-cool';

  function renderHeld(heldTarget = target(), openLogSheet = vi.fn()) {
    // The wall is on the cool-down climb now.
    queueSnapshot.current = { uuid: COOL_DOWN_ITEM, climb: { uuid: 'climb-cool' } };
    const rendered = renderHook(
      (props: { target: WorkoutOutcomeTarget; wallLeftAtMs: number | null }) =>
        useWorkoutOneTap(props.target, openLogSheet, props.wallLeftAtMs),
      { initialProps: { target: heldTarget, wallLeftAtMs: START_MS }, wrapper: withQueue },
    );
    return { ...rendered, openLogSheet };
  }

  it('logs a Fell 300 ms after the beat on the climb it left, against its queue item', () => {
    const { result } = renderHeld();

    advanceClock(300);
    act(() => result.current.onFell());

    expect(saveMock.mutateAsync).toHaveBeenCalledTimes(1);
    expect(sentInput()).toMatchObject({ climbUuid: CLIMB_UUID, status: 'attempt', attemptCount: 1 });
    expect(noteRestTimerTick).toHaveBeenCalledWith(
      expect.any(String),
      'afterTick',
      START_MS,
      { status: 'attempt', queueItemUuid: QUEUE_ITEM_UUID },
      START_MS,
    );
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([expect.objectContaining({ queueItemUuid: QUEUE_ITEM_UUID })]);
    expect(result.current.notice).toMatchObject({ kind: 'saved', status: 'attempt', queueItemUuid: QUEUE_ITEM_UUID });
  });

  it('logs a Sent there too, with that climb’s flash rule', () => {
    noteWorkoutRunTick(SESSION_ID, { queueItemUuid: QUEUE_ITEM_UUID, status: 'attempt', climbedAt: 'earlier' });
    const { result } = renderHeld();

    advanceClock(300);
    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ climbUuid: CLIMB_UUID, status: 'send' });
  });

  it('drops a tap once the grace has run out, before the row swaps', () => {
    const { result } = renderHeld();

    advanceClock(WALL_MOVED_GRACE_MS);
    act(() => result.current.onFell());
    act(() => result.current.onSent());

    expect(saveMock.mutateAsync).not.toHaveBeenCalled();
    expect(noteRestTimerTick).not.toHaveBeenCalled();
    expect(result.current.notice).toBeNull();
  });

  it('never opens Log ascent, which would open on the climb now on screen', () => {
    const { result, openLogSheet } = renderHeld(
      target({ boardName: 'spray', climb: climb({ ascensionist_count: 0 }) }),
    );

    advanceClock(300);
    act(() => result.current.onSent());

    expect(openLogSheet).not.toHaveBeenCalled();
    expect(saveMock.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({
      kind: 'message',
      tone: 'info',
      message: 'playView.workoutOutcome.wallMovedFirstAscent:Crimp line',
    });
  });

  it('keeps the tap guard and the notice from before the hold', () => {
    queueSnapshot.current = { uuid: QUEUE_ITEM_UUID, climb: { uuid: CLIMB_UUID } };
    const openLogSheet = vi.fn();
    const { result, rerender } = renderHook(
      (props: { wallLeftAtMs: number | null }) => useWorkoutOneTap(target(), openLogSheet, props.wallLeftAtMs),
      { initialProps: { wallLeftAtMs: null as number | null }, wrapper: withQueue },
    );

    act(() => result.current.onFell());
    // The beat, a moment after the tap.
    queueSnapshot.current = { uuid: COOL_DOWN_ITEM, climb: { uuid: 'climb-cool' } };
    rerender({ wallLeftAtMs: Date.now() });
    act(() => result.current.onFell());

    expect(saveMock.mutateAsync).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toMatchObject({ kind: 'saved', status: 'attempt', queueItemUuid: QUEUE_ITEM_UUID });
  });
});

describe('useWorkoutOneTap: what the row says', () => {
  function withNoticeClock() {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(START_MS);
  }

  it('confirms a saved go with the success haptic and says it aloud, never through a toast', () => {
    const { result } = renderOneTap();

    act(() => result.current.onFell());

    expect(hapticSuccess).toHaveBeenCalledTimes(1);
    expect(announceQueued).toHaveBeenCalledExactlyOnceWith('playView.workoutOutcome.attemptLogged:Crimp line');
    expect(toastMock.showToast).not.toHaveBeenCalled();
  });

  it('lets a saved go’s line go after a moment', () => {
    withNoticeClock();
    const { result } = renderOneTap();

    act(() => result.current.onFell());
    act(() => {
      vi.advanceTimersByTime(SAVED_NOTICE_MS - 1);
    });
    expect(result.current.notice).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(result.current.notice).toBeNull();
  });

  it('restarts the moment for the next go, which replaces the last', () => {
    withNoticeClock();
    const { result } = renderOneTap();

    act(() => result.current.onFell());
    act(() => {
      vi.advanceTimersByTime(SAVED_NOTICE_MS - 100);
    });
    act(() => result.current.onSent());
    act(() => {
      vi.advanceTimersByTime(SAVED_NOTICE_MS - 1);
    });

    expect(result.current.notice).toMatchObject({ kind: 'saved', status: 'send' });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.notice).toBeNull();
  });

  it('holds a failure long enough to read, unless the climber taps it away', () => {
    withNoticeClock();
    saveMock.state.failure = new Error('Server said no');
    const { result } = renderOneTap();

    act(() => result.current.onFell());
    act(() => {
      vi.advanceTimersByTime(MESSAGE_NOTICE_MS - 1);
    });
    expect(result.current.notice).toMatchObject({ kind: 'message', tone: 'error' });
    act(() => result.current.dismissNotice());

    expect(result.current.notice).toBeNull();
  });

  it('lets a failure go on its own after a while', () => {
    withNoticeClock();
    saveMock.state.failure = new Error('Server said no');
    const { result } = renderOneTap();

    act(() => result.current.onFell());
    act(() => {
      vi.advanceTimersByTime(MESSAGE_NOTICE_MS);
    });

    expect(result.current.notice).toBeNull();
  });

  it('keeps the line across the wall moving on, so the row can still name the climb', () => {
    const { result, rerender } = renderOneTap();

    act(() => result.current.onSent());
    rerender({ target: target({ climb: climb({ uuid: 'climb-2', name: 'Pinch roof' }), queueItemUuid: 'item-2' }) });

    expect(result.current.notice).toMatchObject({ queueItemUuid: QUEUE_ITEM_UUID, status: 'flash' });
  });
});
