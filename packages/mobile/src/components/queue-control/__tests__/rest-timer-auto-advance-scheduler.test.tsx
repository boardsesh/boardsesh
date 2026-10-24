// @vitest-environment jsdom
//
// The scheduler's failure mode is "the wall changed under a climber", so every
// "it fires" case here is paired with an "it does not fire" case. The store is
// REAL — the cycle guard only means anything if it is exercised end to end.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const nextClimb = vi.fn();
const showToast = vi.fn();
const keepAwakeCalls: { active: boolean; tag: string }[] = [];
let canNext = true;
let atTrackEnd = false;
let moreToLoad = false;
let suggestionSource: { playlistUuid: string } | null = null;
const trackPagingInputs: Record<string, unknown>[] = [];
let isCrewSession = false;
let inAppBoardConnection = 'connectedByMe';
let settings: Record<string, unknown> = {};
let currentNowMs = Date.parse('2026-09-11T10:00:00.000Z');
let appStateListener: ((state: string) => void) | null = null;

// The gym roster behind this is a React Query hook reaching the GraphQL client,
// which pulls react-native's Flow source into a harness that mocks it narrowly.
// An empty set is "no other board in reach" — the behaviour these tests describe.
vi.mock('../../../providers/queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListener = listener;
      return {
        remove: () => {
          appStateListener = null;
        },
      };
    },
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Partial mock: @boardsesh/profile-stats (reached through the real rest-timer
// store) reads other exports of this package at module load.
vi.mock('@boardsesh/play-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/play-view')>()),
  computeNavigationStateWithSuggestions: () => ({
    canNext,
    canPrevious: false,
    nextItem: null,
    prevItem: null,
    remainingCount: 0,
    atTrackEnd,
  }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ nextClimb, getQueueSnapshot: vi.fn(), refreshPlaylistSuggestionSource: vi.fn() }),
  useQueueData: () => ({ queue: [], currentClimbQueueItem: { uuid: 'queue-current', climb: { uuid: 'current' } } }),
  // The wall-driver rule's crew input. Deliberately not `useIsSharedSession`:
  // that one is gated on the browse rollout flag, and a flag-off crew is still a
  // crew whose wall a passenger's timer must not move.
  useIsCrewSession: () => isCrewSession,
  usePlaylistSuggestionSource: () => suggestionSource,
}));

// The pager is pinned in its own tests; here, only whether more of the list is
// still on its way, and that the scheduler asks for it.
vi.mock('../../../lib/playlists/track-pager', () => ({ canLoadMoreOfTrack: () => moreToLoad }));
vi.mock('../../play-drawer/use-track-paging', () => ({
  useTrackPaging: (inputs: Record<string, unknown>) => {
    trackPagingInputs.push(inputs);
  },
}));

vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', layoutId: 1 } }),
}));

vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({ inAppBoardConnection }),
}));

vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));

vi.mock('../../../hooks/use-keep-awake-while', () => ({
  useKeepAwakeWhile: (active: boolean, tag: string) => {
    keepAwakeCalls.push({ active, tag });
  },
}));

vi.mock('../../../settings', () => ({
  useSetting: (key: string) => [settings[key], vi.fn()],
}));

vi.mock('../../../lib/clock', () => ({ nowMs: () => currentNowMs }));

// The scheduler names the moment; which haptic and sound that is lives in the
// cue module and is pinned by its own tests.
vi.mock('../../../lib/rest-timer-cues', () => ({ playRestTimerCue: vi.fn() }));

import { playRestTimerCue } from '../../../lib/rest-timer-cues';
import type { RestTimerCueKind } from '../../../lib/rest-timer-cues';
import {
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
} from '../../../lib/rest-timer-store';
import { RestTimerAutoAdvanceScheduler } from '../RestTimerAutoAdvanceScheduler';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');

/** How many times the scheduler played one kind of cue. */
function cueCount(kind: RestTimerCueKind): number {
  return vi.mocked(playRestTimerCue).mock.calls.filter(([cue]) => cue.kind === kind).length;
}

/** Advance the fake clock and the timer queue together, so they never disagree. */
function advance(ms: number) {
  act(() => {
    currentNowMs += ms;
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetRestTimerStoreForTests();
  keepAwakeCalls.length = 0;
  canNext = true;
  atTrackEnd = false;
  moreToLoad = false;
  suggestionSource = null;
  trackPagingInputs.length = 0;
  isCrewSession = false;
  inAppBoardConnection = 'connectedByMe';
  currentNowMs = T0;
  appStateListener = null;
  settings = { restTimerTargetSeconds: 60, restTimerAutoAdvance: true, restTimerMode: 'afterTick' };
});

afterEach(() => {
  vi.useRealTimers();
});

/** Arm and land a tick, so the store has a live anchor at T0. */
function armWithTick() {
  act(() => {
    armRestTimer('afterTick', currentNowMs, 'session-1');
    noteRestTimerTick(new Date(currentNowMs).toISOString(), 'afterTick', currentNowMs);
  });
}

describe('firing', () => {
  it('advances the queue once when the rest is up', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(59_000);
    expect(nextClimb).not.toHaveBeenCalled();

    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(cueCount('advance')).toBe(1);
  });

  it('re-anchors after firing and advances again on the next interval', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);

    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(2);
  });

  it('holds the beat in on-the-minute mode rather than re-anchoring on the tick', () => {
    settings = { ...settings, restTimerMode: 'onTheMinute' };
    act(() => {
      armRestTimer('onTheMinute', currentNowMs, 'session-1');
    });
    render(<RestTimerAutoAdvanceScheduler />);

    // A send 20s in must not push the beat out to 1:20.
    advance(20_000);
    act(() => {
      noteRestTimerTick(new Date(currentNowMs).toISOString(), 'onTheMinute', currentNowMs);
    });
    expect(getRestTimerState().anchorMs).toBe(T0);

    advance(40_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });
});

describe('not firing', () => {
  it('does not advance with auto-advance switched off', () => {
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(120_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('does not advance for a passenger in a crew session', () => {
    isCrewSession = true;
    inAppBoardConnection = 'heldByPeer';
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(120_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('does not advance for anyone in a crew while nobody holds the wall', () => {
    isCrewSession = true;
    inAppBoardConnection = 'disconnected';
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(120_000);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(cueCount('advance')).toBe(0);
  });

  it('does advance solo with no board connected at all', () => {
    inAppBoardConnection = 'disconnected';
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('does advance for the climber driving the wall in a crew session', () => {
    isCrewSession = true;
    inAppBoardConnection = 'connectedByMe';
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('does not advance while paused', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(10_000);
    act(() => pauseRestTimer(currentNowMs));
    advance(300_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('does not advance with no target set', () => {
    settings = { ...settings, restTimerTargetSeconds: null };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(300_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('does not advance while disarmed', () => {
    render(<RestTimerAutoAdvanceScheduler />);
    advance(300_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('cancels the pending advance and reschedules when a new tick lands', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(50_000);
    act(() => {
      noteRestTimerTick(new Date(currentNowMs).toISOString(), 'afterTick', currentNowMs);
    });

    // The original deadline passes; the cancelled cycle must not fire.
    advance(10_000);
    expect(nextClimb).not.toHaveBeenCalled();

    advance(50_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('clears its timeout on unmount', () => {
    armWithTick();
    const { unmount } = render(<RestTimerAutoAdvanceScheduler />);
    unmount();

    advance(300_000);
    expect(nextClimb).not.toHaveBeenCalled();
  });
});

describe('the end of the queue', () => {
  it('says so once and stops retrying instead of silently doing nothing', () => {
    canNext = false;
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('mobile.restTimer.queueEndedToast', 'info');
    expect(getRestTimerState().queueEnded).toBe(true);

    // Another two intervals: no second toast, no retry.
    advance(120_000);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(nextClimb).not.toHaveBeenCalled();
  });
});

// Issue #6664: swipes and Next stop at the end of the list being walked, and so
// does the hands-free beat. The queue behind the list is still there.
describe('the end of a list', () => {
  it('says the list ended, not the queue', () => {
    canNext = false;
    atTrackEnd = true;
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('mobile.restTimer.listEndedToast', 'info');
    expect(getRestTimerState()).toMatchObject({ queueEnded: true, listEnded: true });
  });

  it('waits without a word while more of the list is loading, then takes the beat when it lands', () => {
    suggestionSource = { playlistUuid: 'playlist:projects' };
    canNext = false;
    atTrackEnd = true;
    moreToLoad = true;
    armWithTick();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(showToast).not.toHaveBeenCalled();
    expect(nextClimb).not.toHaveBeenCalled();
    // Not latched as ended: the pill must not say "End of the list" meanwhile.
    expect(getRestTimerState()).toMatchObject({ queueEnded: false });

    // The page lands as a longer track. The beat was due already, so it goes
    // now, not after another whole rest (#6664 second review).
    suggestionSource = { playlistUuid: 'playlist:projects' };
    canNext = true;
    atTrackEnd = false;
    moreToLoad = false;
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('drops the waiting beat if the climber stops driving the wall before the page lands', () => {
    // A late page must not move a crew's shared queue from a passenger's phone.
    isCrewSession = true;
    inAppBoardConnection = 'connectedByMe';
    suggestionSource = { playlistUuid: 'playlist:projects' };
    canNext = false;
    atTrackEnd = true;
    moreToLoad = true;
    armWithTick();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);
    advance(60_000);

    inAppBoardConnection = 'heldByPeer';
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    suggestionSource = { playlistUuid: 'playlist:projects' };
    canNext = true;
    atTrackEnd = false;
    moreToLoad = false;
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('says the list ended once the page it waited for ends the track', () => {
    suggestionSource = { playlistUuid: 'playlist:projects' };
    canNext = false;
    atTrackEnd = true;
    moreToLoad = true;
    armWithTick();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);
    advance(60_000);

    // The page failed or was the last: the track ends where it is.
    suggestionSource = { playlistUuid: 'playlist:projects' };
    moreToLoad = false;
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    expect(nextClimb).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('mobile.restTimer.listEndedToast', 'info');
  });

  it('pages the list the climber is on with the player closed', () => {
    suggestionSource = { playlistUuid: 'smart:projects:user' };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    expect(trackPagingInputs.at(-1)).toMatchObject({
      source: suggestionSource,
      displayedClimbUuid: 'current',
      previewTrack: false,
    });
  });
});

describe('target reached with auto-advance off', () => {
  it('plays the reached cue once and does not touch the queue', () => {
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(cueCount('reached')).toBe(1);
    expect(nextClimb).not.toHaveBeenCalled();

    // Still counting past the target; the cue must not repeat.
    advance(120_000);
    expect(cueCount('reached')).toBe(1);
  });

  it('stays silent while auto-advance is on, so the two cues never double up', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(cueCount('reached')).toBe(0);
  });
});

describe('backgrounding', () => {
  it('re-anchors instead of advancing when AppState wins the race on resume', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    // The JS timer queue was frozen: jump the clock, tell the app it woke, and
    // only then let the overdue timeout flush.
    act(() => {
      currentNowMs += 600_000;
      appStateListener?.('active');
    });

    expect(nextClimb).not.toHaveBeenCalled();
    expect(getRestTimerState().anchorMs).toBe(currentNowMs);

    // And the rest simply restarts rather than the timer going dead.
    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });

  it('refuses an overdue timeout that flushes BEFORE AppState reports the resume', () => {
    // Nothing orders the AppState listener ahead of the timer queue on resume —
    // both ride the same UIApplicationDidBecomeActive. This is the ordering the
    // guard has to survive, and the one a clock-only test silently skips.
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    act(() => {
      currentNowMs += 600_000;
      vi.advanceTimersByTime(600_000);
    });

    expect(nextClimb).not.toHaveBeenCalled();
    expect(cueCount('advance')).toBe(0);

    // And the resume that follows still leaves the timer usable, not wedged.
    act(() => appStateListener?.('active'));
    expect(getRestTimerState().anchorMs).toBe(currentNowMs);
  });

  it('still advances a deadline that came due while the app was awake', () => {
    // The grace window must not swallow an ordinary, on-time advance.
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });
});

describe('a back-dated tick', () => {
  it('never moves the wall, and does not wedge the timer holding the screen awake', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    // The tick sheet's date picker, moved back five minutes.
    act(() => {
      noteRestTimerTick(new Date(currentNowMs - 300_000).toISOString(), 'afterTick', currentNowMs);
    });

    advance(600_000);
    expect(nextClimb).not.toHaveBeenCalled();
    // Nothing is pending, so the wake lock is released rather than held forever.
    expect(keepAwakeCalls.at(-1)).toEqual({ active: false, tag: 'rest-timer' });
  });
});

describe('the target buzz', () => {
  it('buzzes again at the new mark when the rest is lengthened mid-cycle', () => {
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(cueCount('reached')).toBe(1);

    // Same cycle, longer rest: a cycle-only latch would swallow this silently.
    settings = { ...settings, restTimerTargetSeconds: 300 };
    rerender(<RestTimerAutoAdvanceScheduler />);
    advance(240_000);
    expect(cueCount('reached')).toBe(2);
  });
});

describe('a refilled queue', () => {
  it('picks the beat back up without waiting for the next tick', () => {
    canNext = false;
    armWithTick();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(getRestTimerState().queueEnded).toBe(true);
    expect(nextClimb).not.toHaveBeenCalled();

    // Someone adds climbs. The latch must clear on its own.
    canNext = true;
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    expect(getRestTimerState().queueEnded).toBe(false);

    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
  });
});

describe('the screen wake lock', () => {
  it('holds the lock only while an advance is pending', () => {
    armWithTick();
    const { unmount } = render(<RestTimerAutoAdvanceScheduler />);
    expect(keepAwakeCalls.at(-1)).toEqual({ active: true, tag: 'rest-timer' });

    act(() => pauseRestTimer(currentNowMs));
    expect(keepAwakeCalls.at(-1)).toEqual({ active: false, tag: 'rest-timer' });
    unmount();
  });
});

// What the climber hears and feels. Each moment names a cue; the cue module maps
// it to the same haptic the timer always played (warning light, advance medium,
// reached success).
describe('cues', () => {
  it('warns once ahead of the advance, then plays the advance cue with the move', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_999);
    expect(cueCount('warning')).toBe(0);
    advance(1);
    expect(cueCount('warning')).toBe(1);
    expect(nextClimb).not.toHaveBeenCalled();

    advance(3_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(vi.mocked(playRestTimerCue).mock.calls.map(([cue]) => cue.kind)).toEqual(['warning', 'advance']);
  });

  // The one gap in "one terminal cue per deadline" (docs/rest-timer.md, Cues):
  // a dead end shows the toast and plays neither `advance` nor `reached`. The
  // countdown (#5396) closes it; flip these assertions there, not by accident.
  it.each([
    { where: 'the queue', endsAtTrack: false },
    { where: 'a list', endsAtTrack: true },
  ])('plays the warning and no terminal cue at the end of $where, where the wall did not move', ({ endsAtTrack }) => {
    canNext = false;
    atTrackEnd = endsAtTrack;
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(playRestTimerCue).mock.calls.map(([cue]) => cue.kind)).toEqual(['warning']);

    // The latch holds the rest past its mark: still no late `reached`.
    advance(120_000);
    expect(cueCount('reached')).toBe(0);
    expect(cueCount('advance')).toBe(0);
  });

  it('gives a passenger the reached cue, never the warning or the advance', () => {
    isCrewSession = true;
    inAppBoardConnection = 'heldByPeer';
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(vi.mocked(playRestTimerCue).mock.calls.map(([cue]) => cue.kind)).toEqual(['reached']);
  });
});
