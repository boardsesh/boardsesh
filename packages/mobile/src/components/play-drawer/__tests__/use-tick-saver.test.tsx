// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { logbookClimbAngleKey, type LogbookEntry, type SaveTickOptions } from '@boardsesh/board-react';
import { MIN_ATTEMPT_COUNT } from '@boardsesh/play-view';

// The one save path every mobile tick takes. The Log ascent sheet's behaviour on
// top of it (labels, tries control, reset after save) is covered by
// use-quick-tick-form.test.tsx; this file pins the contract the later callers
// (the workout player's one-tap buttons) build on: what reaches the mutation,
// the order of the side effects after a save, and the error copy.

const CLIMB_UUID = 'climb-1';
const ANGLE = 40;
const NOW_MS = 1_760_000_000_000;

// Every side effect after a save writes here, so one assertion can pin their order.
const callLog = vi.hoisted(() => [] as string[]);

const saveMock = vi.hoisted(() => {
  const state = {
    failure: null as unknown,
    isPending: false,
    result: undefined as { savedTick: { uuid: string } } | undefined,
    boardNames: [] as Array<string | null>,
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
const presenceState = vi.hoisted(() => ({ enabled: false, boardId: null as number | null }));
const activeBoardState = vi.hoisted(() => ({
  current: null as { uuid?: string; boardType: string; layoutId: number; sizeId: number; setIds: string } | null,
}));
const connectivityState = vi.hoisted(() => ({ isOffline: false }));
const localPendingState = vi.hoisted(() => ({ count: 0, boardNames: [] as string[] }));
const rogueState = vi.hoisted(() => ({
  timer: null as { startStopwatch: () => Promise<void> } | null,
}));
const settingsState = vi.hoisted(() => ({ restTimerMode: 'afterTick' as 'afterTick' | 'onTheMinute' }));
const privacyState = vi.hoisted(() => ({
  publication: undefined as { audience: 'public' | 'followers' | 'only_me'; privacyRevision: number } | undefined,
}));

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
    useSaveTick: (boardName: string | null) => {
      saveMock.state.boardNames.push(boardName);
      return { mutate: saveMock.mutate, isPending: saveMock.state.isPending };
    },
  };
});
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => presenceState,
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoardState.current }),
}));
vi.mock('../../../providers/rogue-timer-provider', () => ({
  useOptionalRogueTimer: () => rogueState.timer,
}));
vi.mock('../../../hooks/use-local-ticks', () => ({
  useLocalPendingTicks: (_climbUuid: string, boardName: string) => {
    localPendingState.boardNames.push(boardName);
    return { data: localPendingState.count };
  },
}));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => connectivityState.isOffline }));
vi.mock('../../../lib/analytics', () => ({
  track: vi.fn((eventName: string) => {
    callLog.push(`track:${eventName}`);
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../lib/clock', () => ({ nowMs: () => NOW_MS }));
vi.mock('../../../settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../settings')>();
  return {
    ...actual,
    getSetting: (key: string) => (key === 'restTimerMode' ? settingsState.restTimerMode : undefined),
  };
});
vi.mock('../../../lib/rest-timer-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/rest-timer-store')>();
  return {
    ...actual,
    noteRestTimerTick: vi.fn(() => {
      callLog.push('restTimer');
    }),
  };
});
vi.mock('../../privacy/use-publication-audience', () => ({
  usePublicationAudience: () => ({
    enabled: false,
    isPrivate: false,
    audience: 'public',
    publication: privacyState.publication,
    chooseAudience: () => {},
  }),
}));

import {
  useTickSaver,
  useHasPriorTickHistory,
  isFirstAscentTick,
  type TickSaveFields,
  type UseTickSaverInput,
} from '../use-tick-saver';
import { track } from '../../../lib/analytics';
import { hapticError } from '../../../lib/haptics';
import { noteRestTimerTick } from '../../../lib/rest-timer-store';

const SAVER_INPUT: UseTickSaverInput = {
  climbUuid: CLIMB_UUID,
  boardName: 'kilter',
  layoutId: 1,
  sessionId: 'session-1',
  surface: 'mobile_quick_tick',
};

function fields(overrides: Partial<TickSaveFields> = {}): TickSaveFields {
  return {
    status: 'send',
    attemptCount: 2,
    angle: ANGLE,
    isMirror: false,
    isBenchmark: false,
    quality: null,
    difficulty: null,
    comment: '',
    climbedAtIso: '2026-10-24T09:30:00.000Z',
    ...overrides,
  };
}

function renderSaver(overrides: Partial<UseTickSaverInput> = {}) {
  return renderHook((props: UseTickSaverInput) => useTickSaver(props), {
    initialProps: { ...SAVER_INPUT, ...overrides },
  });
}

function sentInput(callIndex = 0): SaveTickOptions {
  return saveMock.mutate.mock.calls[callIndex][0] as SaveTickOptions;
}

beforeEach(() => {
  callLog.length = 0;
  saveMock.mutate.mockClear();
  saveMock.state.failure = null;
  saveMock.state.isPending = false;
  saveMock.state.result = undefined;
  saveMock.state.boardNames = [];
  boardState.current = null;
  presenceState.enabled = false;
  presenceState.boardId = null;
  activeBoardState.current = null;
  connectivityState.isOffline = false;
  localPendingState.count = 0;
  localPendingState.boardNames = [];
  rogueState.timer = null;
  settingsState.restTimerMode = 'afterTick';
  privacyState.publication = undefined;
  vi.mocked(track).mockClear();
  vi.mocked(hapticError).mockClear();
  vi.mocked(noteRestTimerTick).mockClear();
});

describe('useTickSaver save input', () => {
  it('sends the climb, the fields, the session and the board in one tick', () => {
    const { result } = renderSaver();

    expect(result.current.save(fields({ quality: 3, difficulty: 18, comment: 'heel hook', isMirror: true }))).toBe(
      true,
    );

    expect(saveMock.mutate).toHaveBeenCalledTimes(1);
    expect(sentInput()).toEqual({
      climbUuid: CLIMB_UUID,
      angle: ANGLE,
      isMirror: true,
      status: 'send',
      attemptCount: 2,
      quality: 3,
      difficulty: 18,
      isBenchmark: false,
      baseAscensionistCount: undefined,
      comment: 'heel hook',
      climbedAt: '2026-10-24T09:30:00.000Z',
      sessionId: 'session-1',
      layoutId: 1,
    });
  });

  it('clamps the tries to the server rules: a flash is one try, nothing goes below the floor', () => {
    const { result } = renderSaver();

    result.current.save(fields({ status: 'flash', attemptCount: 4 }));
    result.current.save(fields({ status: 'attempt', attemptCount: 0 }));

    expect(sentInput(0)).toMatchObject({ status: 'flash', attemptCount: 1 });
    expect(sentInput(1)).toMatchObject({ status: 'attempt', attemptCount: MIN_ATTEMPT_COUNT });
  });

  it('treats zero stars as no rating', () => {
    const { result } = renderSaver();

    result.current.save(fields({ quality: 0 }));

    expect(sentInput()).toMatchObject({ quality: null });
    expect(track).toHaveBeenCalledWith('Tick Logged', expect.objectContaining({ hasQuality: false }));
  });

  it('leaves the session off a tick logged outside one', () => {
    const { result } = renderSaver({ sessionId: null });

    result.current.save(fields());

    expect(sentInput()).not.toHaveProperty('sessionId');
  });

  it('carries the climber’s privacy choice when there is one', () => {
    privacyState.publication = { audience: 'followers', privacyRevision: 7 };
    const { result } = renderSaver();

    result.current.save(fields());

    expect(sentInput()).toMatchObject({ privacy: { audience: 'followers', privacyRevision: 7 } });
  });

  it('never names a climb version', () => {
    const { result } = renderSaver();

    result.current.save(fields());

    expect(sentInput()).not.toHaveProperty('climbRevision');
  });

  it('sends nothing and says so while a save is still in flight', () => {
    saveMock.state.isPending = true;
    const { result } = renderSaver();

    expect(result.current.save(fields())).toBe(false);
    expect(result.current.isPending).toBe(true);
    expect(saveMock.mutate).not.toHaveBeenCalled();
  });
});

describe('useTickSaver board', () => {
  it('logs on the climb’s own board, which may not be the one the caller named', () => {
    const { result } = renderSaver({ climb: { boardType: 'tension', layoutId: 9 } });

    expect(result.current.tickBoardName).toBe('tension');
    expect(saveMock.state.boardNames.at(-1)).toBe('tension');
  });

  it('stamps the bound wall on a climb that lives on it', () => {
    presenceState.enabled = true;
    presenceState.boardId = 4242;
    activeBoardState.current = { uuid: 'wall-1', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
    const { result } = renderSaver({ sizeId: 10, setIds: '1,20' });

    result.current.save(fields());

    expect(sentInput()).toMatchObject({ layoutId: 1, sizeId: 10, setIds: '1,20', boardId: 4242, boardUuid: 'wall-1' });
  });

  it('keeps the board it opened on while active, and takes a fresh one for the next climb', () => {
    presenceState.enabled = true;
    presenceState.boardId = 4242;
    activeBoardState.current = { uuid: 'wall-1', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
    const input = { ...SAVER_INPUT, sizeId: 10, setIds: '1,20' };
    const { result, rerender } = renderSaver(input);

    presenceState.boardId = 777;
    activeBoardState.current = { uuid: 'wall-2', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
    rerender(input);
    result.current.save(fields());
    expect(sentInput(0)).toMatchObject({ boardId: 4242, boardUuid: 'wall-1' });

    rerender({ ...input, climbUuid: 'climb-2' });
    result.current.save(fields());
    expect(sentInput(1)).toMatchObject({ climbUuid: 'climb-2', boardId: 777, boardUuid: 'wall-2' });
  });

  it('takes a fresh board when it turns active again', () => {
    presenceState.enabled = true;
    presenceState.boardId = 4242;
    activeBoardState.current = { uuid: 'wall-1', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
    const input = { ...SAVER_INPUT, sizeId: 10, setIds: '1,20' };
    const { result, rerender } = renderSaver({ ...input, active: true });

    rerender({ ...input, active: false });
    presenceState.boardId = 777;
    rerender({ ...input, active: true });
    result.current.save(fields());

    expect(sentInput()).toMatchObject({ boardId: 777 });
  });
});

describe('useTickSaver after a save', () => {
  it('runs analytics, then the gym timer, then the rest timer, then hands back to the caller', () => {
    const startStopwatch = vi.fn(() => {
      callLog.push('rogue');
      return Promise.resolve();
    });
    rogueState.timer = { startStopwatch };
    saveMock.state.result = { savedTick: { uuid: 'tick-9' } };
    const onSaved = vi.fn(() => {
      callLog.push('saved');
    });
    const { result } = renderSaver();

    result.current.save(fields(), { onSaved });

    expect(callLog).toEqual(['track:Tick Logged', 'rogue', 'restTimer', 'saved']);
    expect(onSaved).toHaveBeenCalledWith('tick-9');
  });

  it('anchors the rest timer on the exact climbedAt it sent, in the climber’s cadence', () => {
    settingsState.restTimerMode = 'onTheMinute';
    const { result } = renderSaver();

    result.current.save(fields({ climbedAtIso: '2026-10-24T09:31:15.000Z' }));

    expect(sentInput().climbedAt).toBe('2026-10-24T09:31:15.000Z');
    expect(noteRestTimerTick).toHaveBeenCalledWith('2026-10-24T09:31:15.000Z', 'onTheMinute', NOW_MS);
  });

  it('reports one Tick Logged with the surface and the clamped tries', () => {
    const { result } = renderSaver({ surface: 'mobile_workout_runner', boardName: 'spray', layoutId: 90_412 });

    result.current.save(fields({ status: 'flash', attemptCount: 3, difficulty: 18, gradeName: 'V5', comment: 'x' }));

    expect(vi.mocked(track).mock.calls).toEqual([
      [
        'Tick Logged',
        {
          climbUuid: CLIMB_UUID,
          layoutId: 90_412,
          boardType: 'spray',
          status: 'flash',
          platform: 'mobile',
          surface: 'mobile_workout_runner',
          attemptCount: 1,
          hasQuality: false,
          hasDifficulty: true,
          difficulty: 18,
          grade: 'V5',
          hasComment: true,
        },
      ],
    ]);
  });

  it('hands back no uuid when the save returned none', () => {
    const onSaved = vi.fn();
    const { result } = renderSaver();

    result.current.save(fields(), { onSaved });

    expect(onSaved).toHaveBeenCalledWith(null);
  });
});

describe('useTickSaver when a save fails', () => {
  function failWith(error: unknown) {
    saveMock.state.failure = error;
    const handlers = { onSaved: vi.fn(), onFailed: vi.fn() };
    const { result } = renderSaver();
    result.current.save(fields(), handlers);
    return handlers;
  }

  it('touches no timer, logs no tick and reports the failure', () => {
    const startStopwatch = vi.fn(() => Promise.resolve());
    rogueState.timer = { startStopwatch };

    const { onSaved, onFailed } = failWith(new Error('Board is offline'));

    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith('Board is offline');
    expect(startStopwatch).not.toHaveBeenCalled();
    expect(noteRestTimerTick).not.toHaveBeenCalled();
    expect(hapticError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(track).mock.calls).toEqual([['Quick Tick Failed', { climbUuid: CLIMB_UUID, layoutId: 1 }]]);
  });

  it('says the privacy choice went stale on a revision conflict', () => {
    const { onFailed } = failWith(
      Object.assign(new Error('conflict'), { extensions: { code: 'PRIVACY_REVISION_CONFLICT' } }),
    );

    expect(onFailed).toHaveBeenCalledWith('privacy.revisionChanged');
  });

  it('says it in the climber’s language while offline', () => {
    connectivityState.isOffline = true;

    const { onFailed } = failWith(new Error('Network request failed'));

    expect(onFailed).toHaveBeenCalledWith('mobile.logAscent.offlineErrorMessage');
  });

  it('says the climb was deleted on CLIMB_NOT_FOUND', () => {
    const { onFailed } = failWith(
      Object.assign(new Error('Climb not found'), { extensions: { code: 'CLIMB_NOT_FOUND' } }),
    );

    expect(onFailed).toHaveBeenCalledWith('mobile.logAscent.climbDeletedMessage');
  });

  it('falls back to the catalog message when the failure carries none', () => {
    const { onFailed } = failWith(new Error(''));

    expect(onFailed).toHaveBeenCalledWith('mobile.logAscent.errorMessage');
  });
});

describe('useHasPriorTickHistory', () => {
  function logbook(entries: Array<[number, number]>, fetched = true) {
    return {
      logbook: [],
      logbookByClimbAngle: new Map<string, LogbookEntry[]>(
        entries.map(([angle, count]) => [
          logbookClimbAngleKey(CLIMB_UUID, angle),
          Array.from({ length: count }, () => ({ climb_uuid: CLIMB_UUID, angle }) as unknown as LogbookEntry),
        ]),
      ),
      fetchedLogbookClimbUuids: new Set(fetched ? [CLIMB_UUID] : []),
      getLogbook: vi.fn(),
    };
  }

  function history(angle = ANGLE): boolean {
    return renderHook(() => useHasPriorTickHistory(CLIMB_UUID, 'kilter', angle)).result.current;
  }

  it('is known only once the climb’s logbook has been fetched', () => {
    boardState.current = logbook([[ANGLE, 1]]);
    expect(history()).toBe(true);

    boardState.current = logbook([]);
    expect(history()).toBe(false);
  });

  it('asks about the angle being logged', () => {
    boardState.current = logbook([[ANGLE, 1]]);
    expect(history(45)).toBe(false);
  });

  it('assumes history while it can’t know, so nobody logs a phantom flash', () => {
    boardState.current = null;
    expect(history()).toBe(true);

    boardState.current = logbook([], false);
    expect(history()).toBe(true);
  });

  it('counts a tick still waiting in the outbox', () => {
    boardState.current = logbook([]);
    localPendingState.count = 1;
    expect(history()).toBe(true);
    expect(localPendingState.boardNames.at(-1)).toBe('kilter');
  });

  it('asks the logbook for the climb once per climb', () => {
    const board = logbook([]);
    boardState.current = board;
    const { rerender } = renderHook(
      (props: { climbUuid: string }) => useHasPriorTickHistory(props.climbUuid, 'kilter', ANGLE),
      { initialProps: { climbUuid: CLIMB_UUID } },
    );

    rerender({ climbUuid: CLIMB_UUID });
    rerender({ climbUuid: 'climb-2' });

    expect(board.getLogbook.mock.calls).toEqual([[[CLIMB_UUID]], [['climb-2']]]);
  });
});

describe('isFirstAscentTick', () => {
  it('is a spray climb nobody has sent', () => {
    expect(isFirstAscentTick('spray', 0)).toBe(true);
    expect(isFirstAscentTick('spray', 1)).toBe(false);
    expect(isFirstAscentTick('kilter', 0)).toBe(false);
    expect(isFirstAscentTick(undefined, 0)).toBe(false);
  });
});
