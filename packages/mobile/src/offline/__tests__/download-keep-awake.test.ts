// The pure half of the download keep-awake (issue #4310): which board a progress
// frame is about, whether that board's download should hold the screen on, and
// what a heartbeat gap says about a suspended JS thread. No timers, no store.

import { describe, it, expect } from 'vitest';
import type { SyncProgress } from '@boardsesh/offline-sync';
import {
  IDLE_KEEP_AWAKE_TRACKING,
  KEEP_AWAKE_MAX_HOLD_MS,
  KEEP_AWAKE_MIN_HOLD_CHARGE_MS,
  KEEP_AWAKE_PROGRESS_STALE_MS,
  SUSPENSION_GAP_MS,
  chargedHoldMs,
  downloadProgressSubject,
  isUserStartedTrigger,
  msUntilKeepAwakeLapses,
  shouldKeepScreenAwake,
  suspendedMsForHeartbeatGap,
  trackDownloadProgress,
  type KeepAwakeDecisionInput,
} from '../download-keep-awake';

const SCOPE_KEY = 'kilter:1:10';

describe('downloadProgressSubject', () => {
  it('names the board from a snapshot frame', () => {
    const frame: SyncProgress = {
      phase: 'bootstrap',
      currentTable: SCOPE_KEY,
      documentsProcessed: 0,
      snapshot: { scopeKey: SCOPE_KEY, stage: 'download', fraction: 0.4, wireBytes: 110_000_000, wireBytesDone: 44 },
    };
    expect(downloadProgressSubject(frame)).toEqual({ kind: 'scope', scopeKey: SCOPE_KEY });
  });

  it('names the board from the bootstrap frame that carries no snapshot detail', () => {
    expect(downloadProgressSubject({ phase: 'bootstrap', currentTable: SCOPE_KEY, documentsProcessed: 0 })).toEqual({
      kind: 'scope',
      scopeKey: SCOPE_KEY,
    });
  });

  it('strips the table name off a paged-crawl frame', () => {
    for (const tableName of ['board_climbs', 'board_climb_stats', 'board_climb_grades', 'spray_walls']) {
      expect(
        downloadProgressSubject({
          phase: 'board_data',
          currentTable: `${tableName}:${SCOPE_KEY}`,
          documentsProcessed: 500,
          currentTableProcessed: 500,
        }),
      ).toEqual({ kind: 'scope', scopeKey: SCOPE_KEY });
    }
  });

  it('reads the work every board waits behind as shared', () => {
    const sharedFrames: SyncProgress[] = [
      { phase: 'bootstrap', currentTable: null, documentsProcessed: 0 },
      { phase: 'deletions', currentTable: null, documentsProcessed: 12 },
      { phase: 'user_data', currentTable: 'boardsesh_ticks', documentsProcessed: 40 },
    ];
    for (const frame of sharedFrames) expect(downloadProgressSubject(frame)).toEqual({ kind: 'shared' });
  });

  it('reads every terminal frame as idle, failed and interrupted included', () => {
    expect(downloadProgressSubject({ phase: 'idle', currentTable: null, documentsProcessed: 0 })).toEqual({
      kind: 'idle',
    });
    expect(downloadProgressSubject({ phase: 'idle', currentTable: null, documentsProcessed: 0, failed: true })).toEqual(
      { kind: 'idle' },
    );
    expect(
      downloadProgressSubject({ phase: 'idle', currentTable: null, documentsProcessed: 0, interrupted: true }),
    ).toEqual({ kind: 'idle' });
  });
});

describe('trackDownloadProgress', () => {
  const isUserStarted = (scopeKey: string) => scopeKey === SCOPE_KEY;

  it('starts tracking when a frame names a download the person started', () => {
    expect(
      trackDownloadProgress(IDLE_KEEP_AWAKE_TRACKING, { kind: 'scope', scopeKey: SCOPE_KEY }, isUserStarted, 1_000),
    ).toEqual({ scopeKey: SCOPE_KEY, lastProgressAt: 1_000 });
  });

  it('ignores a board nobody asked for, so routine sync never starts a hold', () => {
    expect(
      trackDownloadProgress(IDLE_KEEP_AWAKE_TRACKING, { kind: 'scope', scopeKey: 'tension:9:1' }, isUserStarted, 1_000),
    ).toBe(IDLE_KEEP_AWAKE_TRACKING);
  });

  it('does not let another board refresh the tracked download', () => {
    const tracking = { scopeKey: SCOPE_KEY, lastProgressAt: 1_000 };
    expect(trackDownloadProgress(tracking, { kind: 'scope', scopeKey: 'tension:9:1' }, isUserStarted, 50_000)).toBe(
      tracking,
    );
  });

  it('counts shared work as progress only once the download has been seen this cycle', () => {
    expect(trackDownloadProgress(IDLE_KEEP_AWAKE_TRACKING, { kind: 'shared' }, isUserStarted, 2_000)).toBe(
      IDLE_KEEP_AWAKE_TRACKING,
    );
    expect(
      trackDownloadProgress({ scopeKey: SCOPE_KEY, lastProgressAt: 1_000 }, { kind: 'shared' }, isUserStarted, 2_000),
    ).toEqual({ scopeKey: SCOPE_KEY, lastProgressAt: 2_000 });
  });

  it('stops tracking when the cycle ends', () => {
    expect(
      trackDownloadProgress({ scopeKey: SCOPE_KEY, lastProgressAt: 1_000 }, { kind: 'idle' }, isUserStarted, 2_000),
    ).toBe(IDLE_KEEP_AWAKE_TRACKING);
  });
});

describe('shouldKeepScreenAwake', () => {
  const holding: KeepAwakeDecisionInput = {
    userStartedDownloadInFlight: true,
    isForeground: true,
    msSinceProgress: 1_000,
    heldMs: 0,
    screenshotMode: false,
  };

  it('holds while a download the person started is running in the foreground', () => {
    expect(shouldKeepScreenAwake(holding)).toBe(true);
  });

  it('releases when no user-started download is in flight', () => {
    expect(shouldKeepScreenAwake({ ...holding, userStartedDownloadInFlight: false })).toBe(false);
  });

  it('releases in the background', () => {
    expect(shouldKeepScreenAwake({ ...holding, isForeground: false })).toBe(false);
  });

  it('releases once a minute passes with no progress, and not a millisecond sooner', () => {
    expect(shouldKeepScreenAwake({ ...holding, msSinceProgress: KEEP_AWAKE_PROGRESS_STALE_MS - 1 })).toBe(true);
    expect(shouldKeepScreenAwake({ ...holding, msSinceProgress: KEEP_AWAKE_PROGRESS_STALE_MS })).toBe(false);
  });

  it('releases before the first progress frame', () => {
    expect(shouldKeepScreenAwake({ ...holding, msSinceProgress: null })).toBe(false);
  });

  it('releases at the ten-minute cap however lively the download is', () => {
    expect(shouldKeepScreenAwake({ ...holding, heldMs: KEEP_AWAKE_MAX_HOLD_MS - 1 })).toBe(true);
    expect(shouldKeepScreenAwake({ ...holding, heldMs: KEEP_AWAKE_MAX_HOLD_MS })).toBe(false);
  });

  it('never holds in screenshot mode', () => {
    expect(shouldKeepScreenAwake({ ...holding, screenshotMode: true })).toBe(false);
  });

  it('treats a wall clock that moved backwards as fresh progress', () => {
    expect(shouldKeepScreenAwake({ ...holding, msSinceProgress: -5_000 })).toBe(true);
  });
});

describe('msUntilKeepAwakeLapses', () => {
  it('is the time left before the stall rule fires', () => {
    expect(msUntilKeepAwakeLapses({ msSinceProgress: 10_000, heldMs: 0 })).toBe(KEEP_AWAKE_PROGRESS_STALE_MS - 10_000);
  });

  it('is the time left on the cap when that comes first', () => {
    expect(msUntilKeepAwakeLapses({ msSinceProgress: 0, heldMs: KEEP_AWAKE_MAX_HOLD_MS - 5_000 })).toBe(5_000);
  });

  it('never goes negative', () => {
    expect(msUntilKeepAwakeLapses({ msSinceProgress: KEEP_AWAKE_PROGRESS_STALE_MS + 1, heldMs: 0 })).toBe(0);
  });
});

describe('chargedHoldMs', () => {
  it('charges a short stretch the minimum, so a re-take is never free', () => {
    expect(chargedHoldMs(0)).toBe(KEEP_AWAKE_MIN_HOLD_CHARGE_MS);
    expect(chargedHoldMs(500)).toBe(KEEP_AWAKE_MIN_HOLD_CHARGE_MS);
  });

  it('charges a longer stretch what it held', () => {
    expect(chargedHoldMs(KEEP_AWAKE_MIN_HOLD_CHARGE_MS + 1)).toBe(KEEP_AWAKE_MIN_HOLD_CHARGE_MS + 1);
    expect(chargedHoldMs(300_000)).toBe(300_000);
  });

  it('lets one tap take the lock twenty times at most', () => {
    expect(KEEP_AWAKE_MAX_HOLD_MS / KEEP_AWAKE_MIN_HOLD_CHARGE_MS).toBe(20);
  });
});

describe('suspendedMsForHeartbeatGap', () => {
  it('ignores a heartbeat that was merely late', () => {
    expect(suspendedMsForHeartbeatGap(1_000)).toBe(0);
    expect(suspendedMsForHeartbeatGap(SUSPENSION_GAP_MS)).toBe(0);
  });

  it('counts the whole gap once it passes three seconds', () => {
    expect(suspendedMsForHeartbeatGap(SUSPENSION_GAP_MS + 1)).toBe(SUSPENSION_GAP_MS + 1);
    expect(suspendedMsForHeartbeatGap(480_000)).toBe(480_000);
  });

  it('ignores a clock that moved backwards', () => {
    expect(suspendedMsForHeartbeatGap(-60_000)).toBe(0);
  });
});

describe('isUserStartedTrigger', () => {
  it('counts every tap', () => {
    for (const trigger of [
      'toggle',
      'download-all',
      'adopt-confirmed',
      'retry',
      'onboarding',
      'similar_climbs',
      'hold_heatmap',
      'unknown',
    ] as const) {
      expect(isUserStartedTrigger(trigger)).toBe(true);
    }
  });

  it('does not count a download the app started by itself', () => {
    for (const trigger of ['auto-download-all', 'adopt-auto', 'owned-wall'] as const) {
      expect(isUserStartedTrigger(trigger)).toBe(false);
    }
  });
});
