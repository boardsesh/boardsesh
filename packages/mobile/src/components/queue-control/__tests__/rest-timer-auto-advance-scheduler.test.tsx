// @vitest-environment jsdom
//
// The scheduler's failure mode is "the wall changed under a climber", so every
// "it fires" case here is paired with an "it does not fire" case. The store is
// REAL — the cycle guard only means anything if it is exercised end to end.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

const nextClimb = vi.fn();
const showToast = vi.fn();
const keepAwakeCalls: { active: boolean; tag: string }[] = [];
let canNext = true;
let atTrackEnd = false;
let moreToLoad = false;
let suggestionSource: PlaylistSuggestionSource | null = null;
// The real selection, for the cases that pin the scheduler to what Next does.
let useRealNavigation = false;
const currentQueueItem = { uuid: 'queue-current', climb: { uuid: 'current' } } as ClimbQueueItem;
let queue: ClimbQueueItem[] = [];

/** A track holding the current climb, then `after`. */
function trackOf(playlistUuid: string, after: string[] = []): PlaylistSuggestionSource {
  return {
    playlistUuid,
    activatedClimbUuid: 'current',
    boardKey: 'kilter:1:1:1',
    climbs: [{ uuid: 'current' }, ...after.map((uuid) => ({ uuid }))] as PlaylistSuggestionSource['climbs'],
  };
}
const trackPagingInputs: Record<string, unknown>[] = [];
let isCrewSession = false;
let inAppBoardConnection = 'connectedByMe';
let settings: Record<string, unknown> = {};
let currentNowMs = Date.parse('2026-09-11T10:00:00.000Z');
let appStateListener: ((state: string) => void) | null = null;
// Stands in for a workout stage or the crew clock pacing the rest, which only
// changes what the wake lock does: the seam resolves settings alone on main.
let pacingSourceOverride: 'stage' | 'crew' | null = null;

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
vi.mock('@boardsesh/play-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/play-view')>();
  return {
    ...actual,
    computeNavigationStateWithSuggestions: (
      ...args: Parameters<typeof actual.computeNavigationStateWithSuggestions>
    ) =>
      useRealNavigation
        ? actual.computeNavigationStateWithSuggestions(...args)
        : {
            canNext,
            canPrevious: false,
            nextItem: null,
            prevItem: null,
            remainingCount: 0,
            atTrackEnd,
          },
  };
});

vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ nextClimb, getQueueSnapshot: vi.fn(), refreshPlaylistSuggestionSource: vi.fn() }),
  useQueueData: () => ({ queue, currentClimbQueueItem: currentQueueItem }),
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

vi.mock('../../../hooks/use-effective-rest-pacing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/use-effective-rest-pacing')>();
  return {
    ...actual,
    useEffectiveRestPacing: () => {
      const pacing = actual.useEffectiveRestPacing();
      return pacingSourceOverride === null ? pacing : { ...pacing, source: pacingSourceOverride };
    },
  };
});

// The scheduler names the moment; which haptic and sound that is lives in the
// cue module and is pinned by its own tests.
vi.mock('../../../lib/rest-timer-cues', () => ({ playRestTimerCue: vi.fn() }));

import { playRestTimerCue } from '../../../lib/rest-timer-cues';
import type { RestTimerCueKind } from '../../../lib/rest-timer-cues';
import {
  armRestTimer,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimer,
  resetRestTimerStoreForTests,
  resumeRestTimer,
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

/**
 * Advance a few milliseconds at a time, so each countdown cue lands on time.
 * `advance` moves the clock first, so a cue it flushes reads as late.
 */
function advanceInSteps(ms: number, stepMs = 50) {
  for (let elapsedMs = 0; elapsedMs < ms; elapsedMs += stepMs) advance(Math.min(stepMs, ms - elapsedMs));
}

/** Every cue played so far, in order, with the countdown's seconds spelled out. */
function playedCues(): string[] {
  return vi
    .mocked(playRestTimerCue)
    .mock.calls.map(([cue]) => (cue.kind === 'countdownTick' ? `tick:${cue.secondsLeft}` : cue.kind));
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
  useRealNavigation = false;
  queue = [];
  trackPagingInputs.length = 0;
  isCrewSession = false;
  inAppBoardConnection = 'connectedByMe';
  currentNowMs = T0;
  appStateListener = null;
  pacingSourceOverride = null;
  settings = {
    restTimerTargetSeconds: 60,
    restTimerAutoAdvance: true,
    restTimerMode: 'afterTick',
    restTimerCountdownCues: true,
  };
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
    suggestionSource = trackOf('playlist:projects');
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
    suggestionSource = trackOf('playlist:projects');
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
    suggestionSource = trackOf('playlist:projects');
    canNext = false;
    atTrackEnd = true;
    moreToLoad = true;
    armWithTick();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);
    advance(60_000);

    inAppBoardConnection = 'heldByPeer';
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    suggestionSource = trackOf('playlist:projects');
    canNext = true;
    atTrackEnd = false;
    moreToLoad = false;
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('says the list ended once the page it waited for ends the track', () => {
    suggestionSource = trackOf('playlist:projects');
    canNext = false;
    atTrackEnd = true;
    moreToLoad = true;
    armWithTick();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);
    advance(60_000);

    // The page failed or was the last: the track ends where it is.
    suggestionSource = trackOf('playlist:projects');
    moreToLoad = false;
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    expect(nextClimb).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('mobile.restTimer.listEndedToast', 'info');
  });

  it('pages the list the climber is on with the player closed', () => {
    suggestionSource = trackOf('smart:projects:user');
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    expect(trackPagingInputs.at(-1)).toMatchObject({
      source: suggestionSource,
      listClimbUuid: 'current',
      previewTrack: false,
    });
  });

  // #6777: while a queued climb plays in the middle of the list, the list's
  // place is the list climb it left, not the queued climb on the wall.
  it('pages from the list climb it left while Up next plays', () => {
    const listEntry = { uuid: 'queue-list-climb', climb: { uuid: 'list-climb' } } as ClimbQueueItem;
    queue = [listEntry, currentQueueItem];
    suggestionSource = {
      ...trackOf('playlist:projects'),
      climbs: [{ uuid: 'list-climb' }, { uuid: 'after' }] as PlaylistSuggestionSource['climbs'],
      resume: { climbUuid: 'list-climb', queueItemUuid: 'queue-list-climb' },
    };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    expect(trackPagingInputs.at(-1)).toMatchObject({ listClimbUuid: 'list-climb' });
  });
});

// #6777: the beat makes the same selection as Next, so it plays Up next before
// the list goes on, and only says the list ended once both are done.
describe('Up next before the list', () => {
  beforeEach(() => {
    useRealNavigation = true;
  });

  it('moves on into Up next from the last climb of the list', () => {
    queue = [currentQueueItem, { uuid: 'queued', climb: { uuid: 'queued-climb' } } as ClimbQueueItem];
    suggestionSource = trackOf('playlist:projects');
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('says the list ended once Up next is played too', () => {
    const listEntry = { uuid: 'queue-list-climb', climb: { uuid: 'list-climb' } } as ClimbQueueItem;
    queue = [listEntry, currentQueueItem];
    suggestionSource = {
      ...trackOf('playlist:projects'),
      climbs: [{ uuid: 'list-climb' }] as PlaylistSuggestionSource['climbs'],
      resume: { climbUuid: 'list-climb', queueItemUuid: 'queue-list-climb' },
    };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('mobile.restTimer.listEndedToast', 'info');
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
  it('never moves the wall on its own, and does not wedge the timer holding the screen awake', () => {
    act(() => armRestTimer('afterTick', currentNowMs, 'session-1'));
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

  it('leaves a running rest alone: the wall moves when that rest is up, not before', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    // Yesterday's climb, logged 10 s into today's rest.
    advance(10_000);
    act(() => {
      noteRestTimerTick(new Date(currentNowMs - 300_000).toISOString(), 'afterTick', currentNowMs);
    });
    expect(getRestTimerState().anchorMs).toBe(T0);

    advance(49_000);
    expect(nextClimb).not.toHaveBeenCalled();
    advance(1_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
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
// reached success) and the countdown's selection tick.
describe('cues', () => {
  it('counts the last three seconds down, then plays the advance with the move', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_999);
    expect(playedCues()).toEqual([]);
    advanceInSteps(1);
    expect(playedCues()).toEqual(['tick:3']);
    advanceInSteps(2_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1']);
    expect(nextClimb).not.toHaveBeenCalled();

    advanceInSteps(999);
    expect(nextClimb).not.toHaveBeenCalled();
    advanceInSteps(1);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'advance']);
  });

  it('warns once instead, with per-second cues off', () => {
    settings = { ...settings, restTimerCountdownCues: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_999);
    expect(cueCount('warning')).toBe(0);
    advance(1);
    expect(cueCount('warning')).toBe(1);
    expect(nextClimb).not.toHaveBeenCalled();

    advance(3_000);
    expect(nextClimb).toHaveBeenCalledTimes(1);
    expect(playedCues()).toEqual(['warning', 'advance']);
  });

  it.each([
    { targetSeconds: 120, ticks: ['tick:4', 'tick:3', 'tick:2', 'tick:1'] },
    { targetSeconds: 180, ticks: ['tick:5', 'tick:4', 'tick:3', 'tick:2', 'tick:1'] },
  ])('counts a longer lead before a $targetSeconds s rest', ({ targetSeconds, ticks }) => {
    settings = { ...settings, restTimerTargetSeconds: targetSeconds };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(targetSeconds * 1000 - ticks.length * 1000 - 1);
    expect(playedCues()).toEqual([]);
    advanceInSteps(ticks.length * 1000 + 1);
    expect(playedCues()).toEqual([...ticks, 'advance']);
  });

  it('keeps at most six timeouts for one rest: five cues and the advance', () => {
    settings = { ...settings, restTimerTargetSeconds: 300 };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    expect(vi.getTimerCount()).toBe(6);
  });

  it('counts down before the reached cue with auto-advance off, and leaves the queue alone', () => {
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_000);
    advanceInSteps(4_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('counts down and buzzes every beat on the minute with auto-advance off', () => {
    settings = { ...settings, restTimerAutoAdvance: false, restTimerMode: 'onTheMinute', restTimerTargetSeconds: 20 };
    act(() => {
      armRestTimer('onTheMinute', currentNowMs, 'session-1');
    });
    render(<RestTimerAutoAdvanceScheduler />);

    advanceInSteps(20_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);
    advanceInSteps(20_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached', 'tick:3', 'tick:2', 'tick:1', 'reached']);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  // The gap SEAM pinned in "one terminal cue per deadline" (docs/rest-timer.md,
  // Cues): a dead end used to show the toast and play neither `advance` nor
  // `reached`. The countdown closes it: the rest ran out and the wall did not
  // move, so it is `reached`.
  it.each([
    { where: 'the queue', endsAtTrack: false },
    { where: 'a list', endsAtTrack: true },
  ])('counts down, then plays the reached cue at the end of $where, where the wall did not move', ({ endsAtTrack }) => {
    canNext = false;
    atTrackEnd = endsAtTrack;
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_000);
    advanceInSteps(4_000);
    expect(nextClimb).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);

    // The latch holds the rest past its mark: no second `reached`, no countdown
    // to a beat that will not come.
    advanceInSteps(120_000, 500);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);
  });

  // One terminal cue per rest end: the `reached` cue keeps the advance's 5 s
  // grace, so a JS stall that still lets the advance move the wall never leaves
  // a dead end or a rest with auto-advance off silent.
  it.each([
    { where: 'with the move', wallMoves: true, terminalCue: 'advance' },
    { where: 'at a dead end', wallMoves: false, terminalCue: 'reached' },
  ])('plays the terminal cue $where when the rest end lands 1.5 s late', ({ wallMoves, terminalCue }) => {
    canNext = wallMoves;
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_000);
    advanceInSteps(3_999);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1']);

    // The JS thread stalls across the rest's end and the fire lands 1.5 s late.
    advance(1_501);
    expect(nextClimb).toHaveBeenCalledTimes(wallMoves ? 1 : 0);
    expect(getRestTimerState().queueEnded).toBe(!wallMoves);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', terminalCue]);
  });

  it('plays the reached cue a stall held up 1 s with auto-advance off', () => {
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_000);
    advanceInSteps(3_999);
    advance(1_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);
  });

  it('plays no reached cue for a rest end past the advance grace', () => {
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_000);
    advanceInSteps(3_999);
    advance(5_002);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1']);
  });

  it('plays one reached cue at a dead end on the minute, and no beats after it', () => {
    canNext = false;
    settings = { ...settings, restTimerMode: 'onTheMinute', restTimerTargetSeconds: 20 };
    act(() => {
      armRestTimer('onTheMinute', currentNowMs, 'session-1');
    });
    render(<RestTimerAutoAdvanceScheduler />);

    advanceInSteps(20_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);
    advanceInSteps(60_000, 500);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);
  });

  it('never adds a reached cue to a beat the advance already fired on', () => {
    // Turning auto-advance off straight after an on-the-minute advance must not
    // replay that beat as `reached`.
    settings = { ...settings, restTimerMode: 'onTheMinute', restTimerTargetSeconds: 20 };
    act(() => {
      armRestTimer('onTheMinute', currentNowMs, 'session-1');
    });
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);

    advanceInSteps(20_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'advance']);

    settings = { ...settings, restTimerAutoAdvance: false };
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    advanceInSteps(100);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'advance']);

    advanceInSteps(19_900);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'advance', 'tick:3', 'tick:2', 'tick:1', 'reached']);
  });

  it('gives a passenger the countdown and the reached cue, never the advance', () => {
    isCrewSession = true;
    inAppBoardConnection = 'heldByPeer';
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_000);
    advanceInSteps(4_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);
  });

  it('never plays ticks and the warning for one rest when the setting flips mid-countdown', () => {
    armWithTick();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);

    advance(56_000);
    advanceInSteps(1_500);
    expect(playedCues()).toEqual(['tick:3']);

    settings = { ...settings, restTimerCountdownCues: false };
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    advanceInSteps(2_500);
    // This rest keeps the countdown it started; the next one warns.
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'advance']);

    advance(56_000);
    advanceInSteps(4_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'advance', 'warning', 'advance']);
  });

  it('takes a setting changed before the countdown starts', () => {
    armWithTick();
    const { rerender } = render(<RestTimerAutoAdvanceScheduler />);

    advance(30_000);
    settings = { ...settings, restTimerCountdownCues: false };
    act(() => rerender(<RestTimerAutoAdvanceScheduler />));
    advance(26_000);
    advanceInSteps(4_000);
    expect(playedCues()).toEqual(['warning', 'advance']);
  });

  it('drops the rest of the countdown when a new tick starts another rest', () => {
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_000);
    advanceInSteps(2_500);
    expect(playedCues()).toEqual(['tick:3', 'tick:2']);

    act(() => {
      noteRestTimerTick(new Date(currentNowMs).toISOString(), 'afterTick', currentNowMs);
    });
    advanceInSteps(2_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2']);
    expect(nextClimb).not.toHaveBeenCalled();
  });

  it('says nothing for cues the app slept through', () => {
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    // The JS timer queue froze at 0:50 and flushes ten minutes later.
    advance(50_000);
    act(() => {
      currentNowMs += 600_000;
      vi.advanceTimersByTime(600_000);
    });
    expect(playedCues()).toEqual([]);
  });
});

describe('the wake lock around a reached cue', () => {
  it('holds the screen up until the reached cue when a workout stage paces the rest', () => {
    pacingSourceOverride = 'stage';
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);
    expect(keepAwakeCalls.at(-1)).toEqual({ active: true, tag: 'rest-timer' });

    advance(56_000);
    advanceInSteps(4_000);
    expect(cueCount('reached')).toBe(1);
    // The cue has landed; nothing is left to wait for.
    expect(keepAwakeCalls.at(-1)).toEqual({ active: false, tag: 'rest-timer' });
  });

  it('keeps it through every beat for a crew passenger on the minute', () => {
    pacingSourceOverride = 'crew';
    isCrewSession = true;
    inAppBoardConnection = 'heldByPeer';
    settings = { ...settings, restTimerMode: 'onTheMinute', restTimerTargetSeconds: 20 };
    act(() => {
      armRestTimer('onTheMinute', currentNowMs, 'session-1');
    });
    render(<RestTimerAutoAdvanceScheduler />);

    advanceInSteps(20_000);
    expect(cueCount('reached')).toBe(1);
    expect(keepAwakeCalls.at(-1)).toEqual({ active: true, tag: 'rest-timer' });
  });

  it('never holds it for a climber’s own rest with auto-advance off', () => {
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    expect(keepAwakeCalls.every(({ active }) => !active)).toBe(true);
    advance(56_000);
    advanceInSteps(4_000);
    expect(keepAwakeCalls.every(({ active }) => !active)).toBe(true);
  });

  it('lets go at a dead end even when a stage paces the rest', () => {
    pacingSourceOverride = 'stage';
    canNext = false;
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(56_000);
    advanceInSteps(4_000);
    expect(getRestTimerState().queueEnded).toBe(true);
    expect(keepAwakeCalls.at(-1)).toEqual({ active: false, tag: 'rest-timer' });
  });
});

// The reached latch belongs to one rest, and a rest is its anchor (#6730
// review). Whatever an earlier rest cued says nothing about the next one, and a
// mark the climber already heard is never played again because the anchor moved
// under it.
describe('the reached cue across rests', () => {
  it.each([
    {
      boundary: 'a disarm and a re-arm',
      nextMode: 'afterTick',
      startNextRest: () => {
        disarmRestTimer();
        armRestTimer('afterTick', currentNowMs, 'session-1');
        noteRestTimerTick(new Date(currentNowMs).toISOString(), 'afterTick', currentNowMs);
      },
    },
    { boundary: 'a reset', nextMode: 'afterTick', startNextRest: () => resetRestTimer(currentNowMs) },
    {
      // The sheet's cadence switch re-arms with the scheduler still mounted.
      boundary: 'a cadence switch',
      nextMode: 'onTheMinute',
      startNextRest: () => armRestTimer('onTheMinute', currentNowMs, 'session-1'),
    },
  ])(
    'cues the next rest’s mark once after $boundary, with the clock set back in between',
    ({ nextMode, startNextRest }) => {
      settings = { ...settings, restTimerAutoAdvance: false, restTimerTargetSeconds: 300 };
      armWithTick();
      const { rerender } = render(<RestTimerAutoAdvanceScheduler />);

      advance(300_000);
      expect(cueCount('reached')).toBe(1);

      // The phone's clock is corrected back ten minutes (NTP, or the climber).
      // The timer queue runs on a monotonic clock and does not move.
      currentNowMs -= 600_000;
      settings = { ...settings, restTimerTargetSeconds: 60, restTimerMode: nextMode };
      act(() => {
        startNextRest();
        rerender(<RestTimerAutoAdvanceScheduler />);
      });

      advance(60_000);
      expect(cueCount('reached')).toBe(2);
      advance(30_000);
      expect(cueCount('reached')).toBe(2);
    },
  );

  it('never replays the reached cue when a rest paused just past its mark resumes', () => {
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(cueCount('reached')).toBe(1);

    // Paused at 1:01. Resume rebases the anchor on the paused elapsed, so the
    // clock picks up at 1:01, past a mark the climber already heard.
    advance(1_500);
    act(() => pauseRestTimer(currentNowMs));
    advance(8_000);
    act(() => resumeRestTimer(currentNowMs));
    advance(120_000);
    expect(cueCount('reached')).toBe(1);
  });

  it('keeps one countdown and one reached cue per beat on the minute across a pause', () => {
    settings = { ...settings, restTimerAutoAdvance: false, restTimerMode: 'onTheMinute', restTimerTargetSeconds: 20 };
    act(() => {
      armRestTimer('onTheMinute', currentNowMs, 'session-1');
    });
    render(<RestTimerAutoAdvanceScheduler />);

    advanceInSteps(20_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);

    // Paused a second and a half into the next beat, resumed at 0:01 of it.
    advance(1_500);
    act(() => pauseRestTimer(currentNowMs));
    advance(8_000);
    act(() => resumeRestTimer(currentNowMs));
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached']);

    advanceInSteps(19_000);
    expect(playedCues()).toEqual(['tick:3', 'tick:2', 'tick:1', 'reached', 'tick:3', 'tick:2', 'tick:1', 'reached']);
  });

  it('never replays the reached cue the last mount played when a re-arm brings the same tick back', () => {
    // RestTimerRuntime unmounts the scheduler on a disarm, and on the re-arm
    // RestTimerSessionSync hands the store the session's last tick again.
    settings = { ...settings, restTimerAutoAdvance: false };
    armWithTick();
    const tickAt = new Date(currentNowMs).toISOString();
    const firstMount = render(<RestTimerAutoAdvanceScheduler />);

    advance(60_000);
    expect(cueCount('reached')).toBe(1);

    advance(1_000);
    act(() => disarmRestTimer());
    firstMount.unmount();

    advance(1_000);
    act(() => armRestTimer('afterTick', currentNowMs, 'session-1'));
    render(<RestTimerAutoAdvanceScheduler />);
    act(() => noteRestTimerTick(tickAt, 'afterTick', currentNowMs));

    advance(10_000);
    expect(cueCount('reached')).toBe(1);
  });
});
