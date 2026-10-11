// The stateful half of the download keep-awake (issue #4310): the user-started
// set and its settings mirror, the one boolean the root component subscribes
// to, the ten-minute cap, and the suspension telemetry. Driven with fake timers
// so every deadline is exact.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SyncProgress } from '@boardsesh/offline-sync';

const mockSettingsStorage = new Map<string, string>();
vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString: (key: string) => mockSettingsStorage.get(key),
    set: (key: string, value: string) => void mockSettingsStorage.set(key, value),
    remove: (key: string) => void mockSettingsStorage.delete(key),
    clearAll: () => mockSettingsStorage.clear(),
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

type AppStateListener = (state: string) => void;
const appState = vi.hoisted(() => ({
  currentState: 'active',
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_event: string, listener: AppStateListener) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

import { getSetting, getUserStartedDownloads, resetAllSettings, setSetting } from '../../settings';
import {
  KEEP_AWAKE_MAX_HOLD_MS,
  KEEP_AWAKE_MIN_HOLD_CHARGE_MS,
  KEEP_AWAKE_PROGRESS_STALE_MS,
  HEARTBEAT_INTERVAL_MS,
} from '../download-keep-awake';
import {
  __resetDownloadKeepAwakeForTests,
  clearUserStartedDownload,
  getPendingUserStartedDownloads,
  isDownloadKeepAwakeActive,
  markUserStartedDownload,
  noteDownloadProgress,
  subscribeDownloadKeepAwake,
  takeDownloadTelemetry,
} from '../download-keep-awake-store';

const KILTER = 'kilter:1:10';
const TENSION = 'tension:9:1';

const bootstrapFrame = (scopeKey: string): SyncProgress => ({
  phase: 'bootstrap',
  currentTable: scopeKey,
  documentsProcessed: 0,
  snapshot: { scopeKey, stage: 'download', fraction: 0.5, wireBytes: 110_000_000, wireBytesDone: 55_000_000 },
});
const pagedFrame = (scopeKey: string): SyncProgress => ({
  phase: 'board_data',
  currentTable: `board_climbs:${scopeKey}`,
  documentsProcessed: 500,
  currentTableProcessed: 500,
});
const SHARED_FRAME: SyncProgress = { phase: 'user_data', currentTable: 'boardsesh_ticks', documentsProcessed: 10 };
const IDLE_FRAME: SyncProgress = { phase: 'idle', currentTable: null, documentsProcessed: 10 };

function setAppState(state: string): void {
  appState.currentState = state;
  for (const listener of appState.listeners) listener(state);
}

/** Enable the boards and mark them the way a tap does. */
function startDownloads(...scopeKeys: string[]): void {
  setSetting('syncEnabledBoards', [...getSetting('syncEnabledBoards'), ...scopeKeys]);
  for (const scopeKey of scopeKeys) markUserStartedDownload(scopeKey);
}

/** Mount a consumer the way the root component does, counting how often it is told to re-read. */
function mountConsumer() {
  const onFlip = vi.fn();
  const unsubscribe = subscribeDownloadKeepAwake(onFlip);
  return { onFlip, unsubscribe };
}

/** Keep the download lively for `durationMs`: one frame every 10 s of fake time. */
function runDownloadFor(scopeKey: string, durationMs: number): void {
  for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += 10_000) {
    noteDownloadProgress(bootstrapFrame(scopeKey));
    vi.advanceTimersByTime(Math.min(10_000, durationMs - elapsedMs));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00.000Z'));
  __resetDownloadKeepAwakeForTests();
  resetAllSettings();
  appState.currentState = 'active';
  appState.listeners.clear();
});

afterEach(() => {
  __resetDownloadKeepAwakeForTests();
  vi.useRealTimers();
});

describe('the user-started set', () => {
  it('mirrors a marked download to settings and reports it pending', () => {
    startDownloads(KILTER);

    expect(getUserStartedDownloads()).toEqual([KILTER]);
    expect(getPendingUserStartedDownloads()).toEqual([KILTER]);
  });

  it('picks a download back up from settings after a relaunch', () => {
    startDownloads(KILTER);
    // A relaunch keeps settings and loses every module-level variable.
    __resetDownloadKeepAwakeForTests();

    expect(getPendingUserStartedDownloads()).toEqual([KILTER]);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));
    expect(isDownloadKeepAwakeActive()).toBe(true);
  });

  it('forgets a download once it is cleared', () => {
    startDownloads(KILTER);
    clearUserStartedDownload(KILTER);

    expect(getUserStartedDownloads()).toEqual([]);
    expect(getPendingUserStartedDownloads()).toEqual([]);
  });

  it('drops a board the moment it leaves syncEnabledBoards', () => {
    startDownloads(KILTER, TENSION);

    // What removing a board and turning it off do first, and sign-out does last.
    setSetting('syncEnabledBoards', [TENSION]);

    expect(getPendingUserStartedDownloads()).toEqual([TENSION]);
    expect(getUserStartedDownloads()).toEqual([TENSION]);
  });

  it('ignores a mark for a board that is not enabled', () => {
    markUserStartedDownload(KILTER);

    expect(getPendingUserStartedDownloads()).toEqual([]);
    expect(getUserStartedDownloads()).toEqual([]);
  });

  it('drops a stored board that is no longer enabled when it first reads settings', () => {
    setSetting('offlineUserStartedDownloads', [KILTER]);

    expect(getPendingUserStartedDownloads()).toEqual([]);
    expect(getUserStartedDownloads()).toEqual([]);
  });
});

describe('holding the screen awake', () => {
  it('holds while a user-started download makes progress, and tells the consumer once', () => {
    startDownloads(KILTER);
    const { onFlip } = mountConsumer();
    expect(isDownloadKeepAwakeActive()).toBe(false);

    noteDownloadProgress(bootstrapFrame(KILTER));
    for (let frameIndex = 0; frameIndex < 50; frameIndex += 1) {
      vi.advanceTimersByTime(400);
      noteDownloadProgress(bootstrapFrame(KILTER));
    }

    expect(isDownloadKeepAwakeActive()).toBe(true);
    // 51 frames, one notification: the root never re-renders per frame.
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it('never holds for a board nobody asked for, whether it bootstraps or crawls', () => {
    setSetting('syncEnabledBoards', [TENSION]);
    const { onFlip } = mountConsumer();

    noteDownloadProgress(bootstrapFrame(TENSION));
    noteDownloadProgress(SHARED_FRAME);
    noteDownloadProgress(pagedFrame(TENSION));

    expect(isDownloadKeepAwakeActive()).toBe(false);
    expect(onFlip).not.toHaveBeenCalled();
  });

  it('holds through the shared work between the import and the last pages', () => {
    startDownloads(KILTER);
    mountConsumer();

    noteDownloadProgress(bootstrapFrame(KILTER));
    vi.advanceTimersByTime(KEEP_AWAKE_PROGRESS_STALE_MS - 1_000);
    noteDownloadProgress(SHARED_FRAME);
    vi.advanceTimersByTime(KEEP_AWAKE_PROGRESS_STALE_MS - 1_000);

    expect(isDownloadKeepAwakeActive()).toBe(true);
  });

  it('holds for the paged crawl of a user-started download', () => {
    startDownloads(KILTER);
    mountConsumer();

    noteDownloadProgress(pagedFrame(KILTER));

    expect(isDownloadKeepAwakeActive()).toBe(true);
  });

  it('releases a minute after the last progress frame', () => {
    startDownloads(KILTER);
    const { onFlip } = mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));

    vi.advanceTimersByTime(KEEP_AWAKE_PROGRESS_STALE_MS - 1);
    expect(isDownloadKeepAwakeActive()).toBe(true);
    vi.advanceTimersByTime(1);

    expect(isDownloadKeepAwakeActive()).toBe(false);
    expect(onFlip).toHaveBeenCalledTimes(2);
  });

  it('does not let another board keep a stalled download alive', () => {
    startDownloads(KILTER);
    setSetting('syncEnabledBoards', [KILTER, TENSION]);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));

    for (let elapsedMs = 0; elapsedMs < KEEP_AWAKE_PROGRESS_STALE_MS; elapsedMs += 5_000) {
      vi.advanceTimersByTime(5_000);
      noteDownloadProgress(pagedFrame(TENSION));
    }

    expect(isDownloadKeepAwakeActive()).toBe(false);
  });

  it('holds again when a stalled download starts moving', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));
    vi.advanceTimersByTime(KEEP_AWAKE_PROGRESS_STALE_MS);
    expect(isDownloadKeepAwakeActive()).toBe(false);

    noteDownloadProgress(bootstrapFrame(KILTER));

    expect(isDownloadKeepAwakeActive()).toBe(true);
  });

  it('releases when the cycle ends', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));

    noteDownloadProgress(IDLE_FRAME);

    expect(isDownloadKeepAwakeActive()).toBe(false);
  });

  it('releases the moment the download completes, though the cycle carries on', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(pagedFrame(KILTER));

    clearUserStartedDownload(KILTER);
    noteDownloadProgress(SHARED_FRAME);

    expect(isDownloadKeepAwakeActive()).toBe(false);
  });

  it('releases when the board is removed mid-download', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));

    setSetting('syncEnabledBoards', []);

    expect(isDownloadKeepAwakeActive()).toBe(false);
  });

  it('releases in the background and holds again on return while progress is fresh', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));

    setAppState('background');
    expect(isDownloadKeepAwakeActive()).toBe(false);

    setAppState('active');
    expect(isDownloadKeepAwakeActive()).toBe(true);
  });

  it('keeps holding through the transient inactive state', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));

    setAppState('inactive');

    expect(isDownloadKeepAwakeActive()).toBe(true);
  });

  it('does not hold when the app is already backgrounded at mount', () => {
    appState.currentState = 'background';
    startDownloads(KILTER);
    mountConsumer();

    noteDownloadProgress(bootstrapFrame(KILTER));

    expect(isDownloadKeepAwakeActive()).toBe(false);
  });

  it('is inactive with no consumer mounted, and lets go when the last one leaves', () => {
    startDownloads(KILTER);
    noteDownloadProgress(bootstrapFrame(KILTER));
    expect(isDownloadKeepAwakeActive()).toBe(false);

    const { unsubscribe } = mountConsumer();
    expect(isDownloadKeepAwakeActive()).toBe(true);
    unsubscribe();

    expect(isDownloadKeepAwakeActive()).toBe(false);
    expect(appState.listeners.size).toBe(0);
  });
});

// A consumer that throws stands in for any failure inside the store. These
// three entry points are called from code that has nothing to do with it.
describe('never throwing into unrelated code', () => {
  function mountBrokenConsumer(): void {
    subscribeDownloadKeepAwake(() => {
      throw new Error('consumer failed');
    });
  }

  it('does not fail the settings write that removes a board', () => {
    startDownloads(KILTER);
    mountBrokenConsumer();
    expect(() => noteDownloadProgress(bootstrapFrame(KILTER))).toThrow('consumer failed');

    expect(() => setSetting('syncEnabledBoards', [])).not.toThrow();
    expect(getSetting('syncEnabledBoards')).toEqual([]);
  });

  it('does not throw out of an app-state event', () => {
    startDownloads(KILTER);
    mountBrokenConsumer();
    expect(() => noteDownloadProgress(bootstrapFrame(KILTER))).toThrow('consumer failed');

    expect(() => setAppState('background')).not.toThrow();
  });

  it('does not throw out of the stall timer', () => {
    startDownloads(KILTER);
    mountBrokenConsumer();
    expect(() => noteDownloadProgress(bootstrapFrame(KILTER))).toThrow('consumer failed');

    expect(() => vi.advanceTimersByTime(KEEP_AWAKE_PROGRESS_STALE_MS)).not.toThrow();
  });
});

describe('the ten-minute cap', () => {
  it('releases a lively download at ten minutes and does not take the lock back', () => {
    startDownloads(KILTER);
    mountConsumer();

    runDownloadFor(KILTER, KEEP_AWAKE_MAX_HOLD_MS - 10_000);
    expect(isDownloadKeepAwakeActive()).toBe(true);
    runDownloadFor(KILTER, 10_000);
    expect(isDownloadKeepAwakeActive()).toBe(false);

    noteDownloadProgress(bootstrapFrame(KILTER));
    expect(isDownloadKeepAwakeActive()).toBe(false);
  });

  it('adds up separate stretches of the same download', () => {
    startDownloads(KILTER);
    mountConsumer();

    runDownloadFor(KILTER, 6 * 60_000);
    noteDownloadProgress(IDLE_FRAME);
    vi.advanceTimersByTime(30 * 60_000);
    runDownloadFor(KILTER, 4 * 60_000 - 10_000);
    expect(isDownloadKeepAwakeActive()).toBe(true);
    runDownloadFor(KILTER, 10_000);

    expect(isDownloadKeepAwakeActive()).toBe(false);
  });

  it('gives each download its own cap', () => {
    startDownloads(KILTER, TENSION);
    mountConsumer();
    runDownloadFor(KILTER, KEEP_AWAKE_MAX_HOLD_MS);
    expect(isDownloadKeepAwakeActive()).toBe(false);

    noteDownloadProgress(bootstrapFrame(TENSION));

    expect(isDownloadKeepAwakeActive()).toBe(true);
  });

  it('starts a fresh cap when the person asks again', () => {
    startDownloads(KILTER);
    mountConsumer();
    runDownloadFor(KILTER, KEEP_AWAKE_MAX_HOLD_MS);
    expect(isDownloadKeepAwakeActive()).toBe(false);

    markUserStartedDownload(KILTER);
    noteDownloadProgress(bootstrapFrame(KILTER));

    expect(isDownloadKeepAwakeActive()).toBe(true);
  });

  // The engine names a board before it requests that board's first page, so a
  // download whose cycle fails right after the naming frame takes and drops the
  // lock on every 30 s scheduler retry. Each re-take restarts the phone's own
  // auto-lock countdown: uncapped, that keeps the screen on for as long as the
  // retries last while charging half a second a time.
  describe('a download that fails just after it starts, on every retry', () => {
    const NAMING_FRAME: SyncProgress = {
      phase: 'board_data',
      currentTable: `board_climbs:${KILTER}`,
      documentsProcessed: 0,
      currentTableProcessed: 0,
    };
    const FAILED_IDLE_FRAME: SyncProgress = { phase: 'idle', currentTable: null, documentsProcessed: 0, failed: true };
    const RETRY_EVERY_MS = 30_000;

    /** Replay `simulatedMs` of retries, each holding for `aliveMs` before it fails. */
    function replayFailingRetries(simulatedMs: number, aliveMs: number) {
      startDownloads(KILTER);
      let holds = 0;
      let heldMs = 0;
      let heldSince: number | null = null;
      let lastHoldTakenAtMs = 0;
      const startedAt = Date.now();
      subscribeDownloadKeepAwake(() => {
        if (isDownloadKeepAwakeActive()) {
          holds += 1;
          heldSince = Date.now();
          lastHoldTakenAtMs = Date.now() - startedAt;
        } else if (heldSince !== null) {
          heldMs += Date.now() - heldSince;
          heldSince = null;
        }
      });
      for (let elapsedMs = 0; elapsedMs < simulatedMs; elapsedMs += RETRY_EVERY_MS) {
        noteDownloadProgress(NAMING_FRAME);
        vi.advanceTimersByTime(aliveMs);
        noteDownloadProgress(FAILED_IDLE_FRAME);
        vi.advanceTimersByTime(RETRY_EVERY_MS - aliveMs);
      }
      return { holds, heldMs, lastHoldTakenAtMs };
    }

    it('takes the lock at most 20 times in four hours, all inside the first ten minutes', () => {
      const { holds, heldMs, lastHoldTakenAtMs } = replayFailingRetries(4 * 60 * 60_000, 500);

      // 480 retries. Without the minimum charge every one of them takes the lock.
      expect(holds).toBe(KEEP_AWAKE_MAX_HOLD_MS / KEEP_AWAKE_MIN_HOLD_CHARGE_MS);
      expect(holds).toBe(20);
      expect(heldMs).toBe(20 * 500);
      expect(lastHoldTakenAtMs).toBeLessThan(KEEP_AWAKE_MAX_HOLD_MS);
      expect(isDownloadKeepAwakeActive()).toBe(false);
    });

    it('stays bounded when each retry gets a little further before it fails', () => {
      const { holds, heldMs } = replayFailingRetries(4 * 60 * 60_000, 20_000);

      expect(holds).toBeLessThanOrEqual(20);
      expect(heldMs).toBeLessThanOrEqual(KEEP_AWAKE_MAX_HOLD_MS);
    });

    it('gives the full ten minutes back to a person who taps again', () => {
      replayFailingRetries(60 * 60_000, 500);
      expect(isDownloadKeepAwakeActive()).toBe(false);

      markUserStartedDownload(KILTER);
      noteDownloadProgress(NAMING_FRAME);

      expect(isDownloadKeepAwakeActive()).toBe(true);
    });
  });

  it('charges a stretch for what it held when that is more than the minimum', () => {
    startDownloads(KILTER);
    mountConsumer();

    // Two stretches of five minutes: the minimum charge must not shorten them.
    runDownloadFor(KILTER, 5 * 60_000);
    noteDownloadProgress(IDLE_FRAME);
    runDownloadFor(KILTER, 5 * 60_000 - 10_000);
    expect(isDownloadKeepAwakeActive()).toBe(true);
    runDownloadFor(KILTER, 10_000);

    expect(isDownloadKeepAwakeActive()).toBe(false);
  });

  // The lock is never let go here, so the consumer hears nothing: the store
  // has to close one board's stretch and start timing the other's cap itself.
  it('passes the hold straight from one tapped board to the next, on the next board’s own cap', () => {
    startDownloads(KILTER, TENSION);
    const { onFlip } = mountConsumer();
    // Tension has ten seconds of its cap left from an earlier cycle.
    runDownloadFor(TENSION, KEEP_AWAKE_MAX_HOLD_MS - 10_000);
    noteDownloadProgress(IDLE_FRAME);
    onFlip.mockClear();

    noteDownloadProgress(bootstrapFrame(KILTER));
    vi.advanceTimersByTime(1_000);
    noteDownloadProgress(bootstrapFrame(TENSION));

    // Taken once for Kilter; the hand-over is not a release and a re-take.
    expect(onFlip).toHaveBeenCalledTimes(1);
    expect(isDownloadKeepAwakeActive()).toBe(true);
    expect(takeDownloadTelemetry(KILTER).keepAwake).toBe(true);
    expect(takeDownloadTelemetry(TENSION).keepAwake).toBe(true);

    // Kilter's timer was set for the one-minute stall rule. Tension's cap
    // comes first, and no further frame arrives to enforce it.
    vi.advanceTimersByTime(9_999);
    expect(isDownloadKeepAwakeActive()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isDownloadKeepAwakeActive()).toBe(false);
    expect(onFlip).toHaveBeenCalledTimes(2);
  });

  it('charges the board that handed the hold over, so it cannot be passed back and forth for free', () => {
    startDownloads(KILTER, TENSION);
    mountConsumer();

    // Twenty hand-overs away from Kilter, a second each.
    for (let handOver = 0; handOver < 20; handOver += 1) {
      noteDownloadProgress(bootstrapFrame(KILTER));
      vi.advanceTimersByTime(1_000);
      noteDownloadProgress(bootstrapFrame(TENSION));
      vi.advanceTimersByTime(1_000);
    }
    noteDownloadProgress(IDLE_FRAME);

    noteDownloadProgress(bootstrapFrame(KILTER));
    expect(isDownloadKeepAwakeActive()).toBe(false);
  });

  it('does not charge the cap for time the app spent suspended', () => {
    startDownloads(KILTER);
    mountConsumer();
    runDownloadFor(KILTER, 60_000);

    // The transfer runs on in the background session while JS is stopped: no
    // timer fires, and the clock is eleven minutes on when the app returns.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    noteDownloadProgress(bootstrapFrame(KILTER));

    expect(isDownloadKeepAwakeActive()).toBe(true);
  });
});

describe('download telemetry', () => {
  it('reports a download that never held the screen as keepAwake false with no suspension', () => {
    expect(takeDownloadTelemetry(KILTER)).toEqual({ keepAwake: false, suspendedMs: 0 });
  });

  it('reports keepAwake for a download that held the screen', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));

    expect(takeDownloadTelemetry(KILTER)).toEqual({ keepAwake: true, suspendedMs: 0 });
  });

  it('keeps keepAwake across cycles and reads until the download finishes', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));
    noteDownloadProgress(IDLE_FRAME);

    expect(takeDownloadTelemetry(KILTER).keepAwake).toBe(true);
    expect(takeDownloadTelemetry(KILTER).keepAwake).toBe(true);
    clearUserStartedDownload(KILTER);
    expect(takeDownloadTelemetry(KILTER).keepAwake).toBe(false);
  });

  // Left behind, the record would mark the next download of this board as
  // held, including an automatic one that never took the lock.
  it('drops a board’s record when the board leaves syncEnabledBoards', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));
    expect(isDownloadKeepAwakeActive()).toBe(true);

    setSetting('syncEnabledBoards', []);

    expect(takeDownloadTelemetry(KILTER)).toEqual({ keepAwake: false, suspendedMs: 0 });
  });

  it('does not carry keepAwake into a later download of the same board', () => {
    startDownloads(KILTER);
    mountConsumer();
    noteDownloadProgress(bootstrapFrame(KILTER));
    clearUserStartedDownload(KILTER);

    expect(takeDownloadTelemetry(KILTER).keepAwake).toBe(false);
  });

  it('counts a heartbeat gap over three seconds against the board that was downloading', () => {
    setSetting('syncEnabledBoards', [KILTER]);
    noteDownloadProgress(bootstrapFrame(KILTER));
    vi.advanceTimersByTime(5 * HEARTBEAT_INTERVAL_MS);

    // Suspended for eight minutes: the clock moves, no timer runs.
    vi.setSystemTime(Date.now() + 480_000);

    expect(takeDownloadTelemetry(KILTER)).toEqual({ keepAwake: false, suspendedMs: 480_000 });
  });

  it('counts nothing while the heartbeat keeps time', () => {
    setSetting('syncEnabledBoards', [KILTER]);
    noteDownloadProgress(bootstrapFrame(KILTER));

    vi.advanceTimersByTime(120_000);

    expect(takeDownloadTelemetry(KILTER).suspendedMs).toBe(0);
  });

  it('resets on each read, so one cycle’s events never count a gap twice', () => {
    setSetting('syncEnabledBoards', [KILTER]);
    noteDownloadProgress(bootstrapFrame(KILTER));
    vi.setSystemTime(Date.now() + 60_000);

    expect(takeDownloadTelemetry(KILTER).suspendedMs).toBe(60_000);
    expect(takeDownloadTelemetry(KILTER).suspendedMs).toBe(0);
  });

  it('charges a gap to the board the previous frame named, not the next one', () => {
    setSetting('syncEnabledBoards', [KILTER, TENSION]);
    noteDownloadProgress(bootstrapFrame(KILTER));
    vi.setSystemTime(Date.now() + 90_000);
    noteDownloadProgress(bootstrapFrame(TENSION));

    expect(takeDownloadTelemetry(KILTER).suspendedMs).toBe(90_000);
    expect(takeDownloadTelemetry(TENSION).suspendedMs).toBe(0);
  });

  it('charges no board for a gap during shared work', () => {
    setSetting('syncEnabledBoards', [KILTER]);
    noteDownloadProgress(bootstrapFrame(KILTER));
    noteDownloadProgress(SHARED_FRAME);
    vi.setSystemTime(Date.now() + 90_000);

    expect(takeDownloadTelemetry(KILTER).suspendedMs).toBe(0);
  });

  it('does not carry suspension from one cycle into the next', () => {
    setSetting('syncEnabledBoards', [KILTER]);
    noteDownloadProgress(bootstrapFrame(KILTER));
    vi.setSystemTime(Date.now() + 90_000);
    noteDownloadProgress(IDLE_FRAME);

    noteDownloadProgress(pagedFrame(KILTER));

    expect(takeDownloadTelemetry(KILTER).suspendedMs).toBe(0);
  });

  it('stops the heartbeat when the cycle ends', () => {
    setSetting('syncEnabledBoards', [KILTER]);
    noteDownloadProgress(bootstrapFrame(KILTER));
    expect(vi.getTimerCount()).toBe(1);

    noteDownloadProgress(IDLE_FRAME);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('noteDownloadProgress', () => {
  it('tells the caller what the frame was about', () => {
    expect(noteDownloadProgress(bootstrapFrame(KILTER))).toBe('scope');
    expect(noteDownloadProgress(SHARED_FRAME)).toBe('shared');
    expect(noteDownloadProgress(IDLE_FRAME)).toBe('idle');
  });
});
