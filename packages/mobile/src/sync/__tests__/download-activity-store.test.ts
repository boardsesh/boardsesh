import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopeDownloadProgress, SyncProgress } from '@boardsesh/offline-sync';
import {
  completeDownloadActivity,
  forgetDownloadActivity,
  getDownloadActivity,
  noteDownloadActivity,
  queueDownloadActivity,
  resetDownloadActivity,
  setDownloadActivityEnabledScopes,
  subscribeDownloadActivity,
} from '../download-activity-store';

const scopeKey = 'kilter:1:5';
function frame(overrides: Partial<ScopeDownloadProgress> = {}): SyncProgress {
  return {
    phase: 'bootstrap',
    currentTable: scopeKey,
    documentsProcessed: 0,
    download: {
      scopeKey,
      phase: 'downloading',
      fraction: 0.4,
      wireBytes: 1000,
      wireBytesDone: 400,
      queuedScopes: 0,
      ...overrides,
    },
  };
}

describe('download activity store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDownloadActivity();
  });
  afterEach(() => {
    resetDownloadActivity();
    vi.useRealTimers();
  });

  it('keeps percentages moving forward across interrupted cycle retries', () => {
    noteDownloadActivity(frame({ fraction: 0.8 }));
    noteDownloadActivity({ phase: 'idle', currentTable: null, documentsProcessed: 0, interrupted: true });
    expect(getDownloadActivity()?.status).toBe('waiting');
    noteDownloadActivity(frame({ phase: 'preparing', fraction: 0.01 }));
    expect(getDownloadActivity()?.progress.fraction).toBe(0.8);
  });

  it('renders only visible changes, including queue changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDownloadActivity(listener);
    noteDownloadActivity(frame());
    const first = getDownloadActivity();
    noteDownloadActivity(frame({ fraction: 0.401, wireBytesDone: 401 }));
    expect(getDownloadActivity()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
    noteDownloadActivity(frame({ queuedScopes: 2 }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('shows completion for three seconds and resumes for another queued board', () => {
    noteDownloadActivity(frame());
    completeDownloadActivity(scopeKey);
    expect(getDownloadActivity()?.status).toBe('done');
    vi.advanceTimersByTime(2999);
    expect(getDownloadActivity()?.status).toBe('done');
    noteDownloadActivity(frame({ scopeKey: 'tension:2:3', fraction: 0.01 }));
    vi.advanceTimersByTime(1);
    expect(getDownloadActivity()?.progress.scopeKey).toBe('tension:2:3');
    completeDownloadActivity('tension:2:3');
    vi.advanceTimersByTime(3000);
    expect(getDownloadActivity()).toBeNull();
  });

  it('renews matching bootstrap heartbeats without reviving failures', () => {
    noteDownloadActivity(frame());
    vi.advanceTimersByTime(59_000);
    noteDownloadActivity({ phase: 'bootstrap', currentTable: scopeKey, documentsProcessed: 0 });
    vi.advanceTimersByTime(59_000);
    expect(getDownloadActivity()?.status).toBe('active');
    noteDownloadActivity({ phase: 'idle', currentTable: null, documentsProcessed: 0, failed: true });
    noteDownloadActivity({ phase: 'bootstrap', currentTable: scopeKey, documentsProcessed: 0 });
    expect(getDownloadActivity()?.status).toBe('failed');
  });

  it('shows a manual scope queued after the engine captured its cycle', () => {
    noteDownloadActivity(frame());
    queueDownloadActivity('tension:2:3');
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(1);
    noteDownloadActivity(frame({ fraction: 0.5, queuedScopes: 0 }));
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(1);
    completeDownloadActivity(scopeKey);
    noteDownloadActivity(frame({ scopeKey: 'tension:2:3', fraction: 0.01, queuedScopes: 0 }));
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(0);
  });

  it('reports stalled and failed downloads without clearing their progress', () => {
    noteDownloadActivity(frame());
    vi.advanceTimersByTime(60_000);
    expect(getDownloadActivity()?.status).toBe('waiting');
    noteDownloadActivity({ phase: 'idle', currentTable: null, documentsProcessed: 0, failed: true });
    expect(getDownloadActivity()?.status).toBe('failed');
    expect(getDownloadActivity()?.progress.fraction).toBe(0.4);
  });

  it('starts queued taps, removes disabled boards, and resets the account', () => {
    queueDownloadActivity(scopeKey);
    expect(getDownloadActivity()?.status).toBe('waiting');
    forgetDownloadActivity(scopeKey);
    expect(getDownloadActivity()).toBeNull();
    noteDownloadActivity(frame());
    resetDownloadActivity();
    vi.advanceTimersByTime(60_000);
    expect(getDownloadActivity()).toBeNull();
  });

  it('preserves the first waiting board and counts distinct queued requests', () => {
    queueDownloadActivity(scopeKey);
    queueDownloadActivity('tension:2:3');
    queueDownloadActivity('tension:2:3');
    expect(getDownloadActivity()?.progress.scopeKey).toBe(scopeKey);
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(1);
    forgetDownloadActivity('tension:2:3');
    expect(getDownloadActivity()?.progress.scopeKey).toBe(scopeKey);
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(0);
  });

  it('promotes the earliest remaining request when the displayed board is removed', () => {
    queueDownloadActivity(scopeKey);
    queueDownloadActivity('tension:2:3');
    queueDownloadActivity('moonboard:1:1');
    forgetDownloadActivity(scopeKey);
    expect(getDownloadActivity()?.progress.scopeKey).toBe('tension:2:3');
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(1);
  });

  it('keeps a remaining request visible after the newest waiting board is removed', () => {
    queueDownloadActivity(scopeKey);
    queueDownloadActivity('tension:2:3');
    forgetDownloadActivity('tension:2:3');
    expect(getDownloadActivity()?.progress.scopeKey).toBe(scopeKey);
  });

  it('promotes queued work immediately after completion and ignores late completed frames', () => {
    noteDownloadActivity(frame());
    queueDownloadActivity('tension:2:3');
    completeDownloadActivity(scopeKey);
    expect(getDownloadActivity()?.progress.scopeKey).toBe('tension:2:3');
    expect(getDownloadActivity()?.status).toBe('waiting');
    noteDownloadActivity(frame({ fraction: 0.99 }));
    expect(getDownloadActivity()?.progress.scopeKey).toBe('tension:2:3');
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(0);
  });

  it('reconciles automatic pending boards without double-counting local taps', () => {
    queueDownloadActivity('tension:2:3');
    noteDownloadActivity(frame({ pendingScopeKeys: [scopeKey, 'tension:2:3'], queuedScopes: 1 }));
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(1);
    queueDownloadActivity('moonboard:1:1');
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(2);
    forgetDownloadActivity('tension:2:3');
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(1);
    noteDownloadActivity(frame({ pendingScopeKeys: [scopeKey, 'tension:2:3'], queuedScopes: 1, fraction: 0.5 }));
    expect(getDownloadActivity()?.progress.queuedScopes).toBe(1);
  });

  it('drops disabled scopes and refuses their late frames', () => {
    setDownloadActivityEnabledScopes([scopeKey, 'tension:2:3']);
    noteDownloadActivity(frame({ pendingScopeKeys: [scopeKey, 'tension:2:3'], queuedScopes: 1 }));
    setDownloadActivityEnabledScopes(['tension:2:3']);
    expect(getDownloadActivity()?.progress.scopeKey).toBe('tension:2:3');
    noteDownloadActivity(frame({ fraction: 0.8 }));
    expect(getDownloadActivity()?.progress.scopeKey).toBe('tension:2:3');
    setDownloadActivityEnabledScopes([]);
    expect(getDownloadActivity()).toBeNull();
    noteDownloadActivity(frame());
    expect(getDownloadActivity()).toBeNull();
  });

  it('starts a fresh attempt when a cancelled board is requested again', () => {
    noteDownloadActivity(frame({ fraction: 0.8 }));
    forgetDownloadActivity(scopeKey);
    queueDownloadActivity(scopeKey);
    noteDownloadActivity(frame({ phase: 'preparing', fraction: 0.01 }));
    expect(getDownloadActivity()?.progress.fraction).toBe(0.01);
  });

  it('does not open an indicator for routine sync frames', () => {
    noteDownloadActivity({ phase: 'board_data', currentTable: `board_climbs:${scopeKey}`, documentsProcessed: 500 });
    noteDownloadActivity({ phase: 'idle', currentTable: null, documentsProcessed: 500 });
    expect(getDownloadActivity()).toBeNull();
  });
});
