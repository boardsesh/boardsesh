// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { logbookClimbAngleKey, type LogbookEntry, type SaveTickOptions } from '@boardsesh/board-react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import type { Climb } from '@boardsesh/shared-schema';

// One-tap Fell / Sent in a timed workout block (#6231). The save runs through the
// real useTickSaver, so these pin what the climber's tap writes: the tick, its
// flash rule, and what the rest timer and the workout's tick log hear about it.

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
  };
  return {
    state,
    mutate: vi.fn(
      (_input: unknown, callbacks?: { onSuccess?: (result: unknown) => void; onError?: (error: unknown) => void }) => {
        if (state.failure) callbacks?.onError?.(state.failure);
        else callbacks?.onSuccess?.(state.result);
      },
    ),
  };
});
const boardState = vi.hoisted(() => ({ current: null as unknown }));
const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/analytics', async (importOriginal) => {
  const { boardTypeProperty } = await importOriginal<typeof import('@boardsesh/analytics')>();
  return {
    boardTypeProperty,
    SHARED_EVENTS: { QuickTickFailed: 'Quick Tick Failed', TickLogged: 'Tick Logged' },
  };
});
vi.mock('@boardsesh/board-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-react')>();
  return {
    ...actual,
    useOptionalBoardActions: () => boardState.current,
    useOptionalBoardLogbook: () => boardState.current,
    useSaveTick: () => ({ mutate: saveMock.mutate, isPending: saveMock.state.isPending }),
  };
});
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toastMock }));
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ enabled: false, boardId: null }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../providers/rogue-timer-provider', () => ({ useOptionalRogueTimer: () => null }));
vi.mock('../../../hooks/use-local-ticks', () => ({ useLocalPendingTicks: () => ({ data: 0 }) }));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => false }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../lib/clock', () => ({ nowMs: () => START_MS }));
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

import { ONE_TAP_GUARD_MS, useWorkoutOneTap } from '../use-workout-one-tap';
import type { WorkoutOutcomeTarget } from '../workout-outcome';
import { track } from '../../../lib/analytics';
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
const withQueue = ({ children }: { children: ReactNode }) =>
  createElement(QueueActionsContext.Provider, { value: queueActions }, children);

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

/** A logbook that has been fetched for the climb, holding `count` ticks at the angle. */
function logbook(count: number) {
  return {
    logbook: [],
    logbookByClimbAngle: new Map<string, LogbookEntry[]>(
      count > 0
        ? [
            [
              logbookClimbAngleKey(CLIMB_UUID, ANGLE),
              Array.from(
                { length: count },
                () => ({ climb_uuid: CLIMB_UUID, angle: ANGLE }) as unknown as LogbookEntry,
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
  return saveMock.mutate.mock.calls[callIndex][0] as SaveTickOptions;
}

/** Moves the wall clock the tap guard reads. */
function advanceClock(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START_MS);
  saveMock.mutate.mockClear();
  saveMock.state.failure = null;
  saveMock.state.isPending = false;
  saveMock.state.result = { savedTick: { uuid: 'tick-1' } };
  boardState.current = logbook(0);
  queueSnapshot.current = { uuid: QUEUE_ITEM_UUID, climb: { uuid: CLIMB_UUID } };
  toastMock.showToast.mockClear();
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

    expect(saveMock.mutate).toHaveBeenCalledTimes(1);
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
    expect(toastMock.showToast).toHaveBeenCalledWith('playView.workoutOutcome.attemptLogged', 'success');
  });

  it('tells the rest timer and the workout’s tick log which queue item fell', () => {
    const { result } = renderOneTap();

    act(() => result.current.onFell());

    expect(noteRestTimerTick).toHaveBeenCalledWith(new Date(START_MS).toISOString(), 'afterTick', START_MS, {
      status: 'attempt',
      queueItemUuid: QUEUE_ITEM_UUID,
    });
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([
      {
        queueItemUuid: QUEUE_ITEM_UUID,
        status: 'attempt',
        climbedAt: new Date(START_MS).toISOString(),
        tickUuid: 'tick-1',
      },
    ]);
  });

  it('logs each fall as its own tick, so an early end loses none', () => {
    const { result } = renderOneTap();

    act(() => result.current.onFell());
    advanceClock(ONE_TAP_GUARD_MS);
    act(() => result.current.onFell());
    advanceClock(ONE_TAP_GUARD_MS);
    act(() => result.current.onFell());

    expect(saveMock.mutate).toHaveBeenCalledTimes(3);
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
    expect(noteRestTimerTick).toHaveBeenCalledWith(expect.any(String), 'afterTick', START_MS, {
      status: 'flash',
      queueItemUuid: QUEUE_ITEM_UUID,
    });
    expect(toastMock.showToast).toHaveBeenCalledWith('playView.workoutOutcome.flashLogged', 'success');
  });

  it('logs a send when the climber has logged the climb at this angle before', () => {
    boardState.current = logbook(1);
    const { result } = renderOneTap();

    act(() => result.current.onSent());

    expect(sentInput()).toMatchObject({ status: 'send', attemptCount: 1 });
    expect(toastMock.showToast).toHaveBeenCalledWith('playView.workoutOutcome.sendLogged', 'success');
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
    expect(saveMock.mutate).not.toHaveBeenCalled();
  });

  it('logs a sent spray climb someone has already sent in one tap', () => {
    const { result, openLogSheet } = renderOneTap(
      target({ boardName: 'spray', climb: climb({ ascensionist_count: 3 }) }),
    );

    act(() => result.current.onSent());

    expect(openLogSheet).not.toHaveBeenCalled();
    expect(saveMock.mutate).toHaveBeenCalledTimes(1);
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

    expect(saveMock.mutate).toHaveBeenCalledTimes(1);
    expect(sentInput()).toMatchObject({ status: 'attempt' });
  });

  it('takes the next tap once the guard has passed', () => {
    const { result } = renderOneTap();

    act(() => result.current.onFell());
    advanceClock(ONE_TAP_GUARD_MS);
    act(() => result.current.onSent());

    expect(saveMock.mutate).toHaveBeenCalledTimes(2);
    expect(sentInput(1)).toMatchObject({ status: 'send' });
  });

  it('holds across a climb change, so a double tap astride an advance logs one go', () => {
    const { result, rerender } = renderOneTap();

    act(() => result.current.onSent());
    rerender({ target: target({ climb: climb({ uuid: 'climb-2' }), queueItemUuid: 'item-2' }) });
    act(() => result.current.onSent());

    expect(saveMock.mutate).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while a save is still in flight', () => {
    saveMock.state.isPending = true;
    const { result } = renderOneTap();

    act(() => result.current.onFell());

    expect(saveMock.mutate).not.toHaveBeenCalled();
    expect(toastMock.showToast).not.toHaveBeenCalled();
  });
});

describe('useWorkoutOneTap: failure', () => {
  it('says why in a toast and leaves the workout’s log alone', () => {
    saveMock.state.failure = new Error('Server said no');
    const { result } = renderOneTap();

    act(() => result.current.onFell());

    expect(toastMock.showToast).toHaveBeenCalledWith('Server said no', 'error');
    expect(getWorkoutRunLog(SESSION_ID)).toEqual([]);
    expect(noteRestTimerTick).not.toHaveBeenCalled();
  });
});
