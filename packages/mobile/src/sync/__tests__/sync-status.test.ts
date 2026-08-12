import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setSyncProgress,
  notifyBootstrapMetadataChanged,
  notifyScopeDownloadComplete,
  getSyncStatusSnapshot,
  __resetSyncStatusForTests,
} from '../sync-status';
import { emptyScopeDownloadPhases, type SyncProgress } from '@boardsesh/offline-sync';

// Store is React-free apart from the hook, so it's exercised through
// setSyncProgress + getSyncStatusSnapshot directly. useSyncStatus is a thin
// useSyncExternalStore wrapper over the same snapshot.

describe('sync-status store', () => {
  beforeEach(() => {
    __resetSyncStatusForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in the never-synced idle state', () => {
    const status = getSyncStatusSnapshot();
    expect(status).toEqual({
      progress: null,
      isSyncing: false,
      lastSyncedAt: null,
      bootstrapMetadataRevision: 0,
      scopeCompletionRevision: 0,
    });
  });

  it('marks isSyncing true and records the frame for a non-idle progress update', () => {
    const frame: SyncProgress = { phase: 'board_data', currentTable: 'board_climbs:kilter', documentsProcessed: 500 };
    setSyncProgress(frame);

    const status = getSyncStatusSnapshot();
    expect(status.isSyncing).toBe(true);
    expect(status.progress).toEqual(frame);
    expect(status.lastSyncedAt).toBeNull();
  });

  it('idle frame stamps lastSyncedAt and clears isSyncing', () => {
    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    setSyncProgress({ phase: 'board_data', currentTable: 'board_climbs:kilter', documentsProcessed: 10 });
    expect(getSyncStatusSnapshot().lastSyncedAt).toBeNull();

    setSyncProgress({ phase: 'idle', currentTable: null, documentsProcessed: 10 });
    const status = getSyncStatusSnapshot();
    expect(status.isSyncing).toBe(false);
    expect(status.lastSyncedAt).toBe(fixedNow);
  });

  it('keeps the prior lastSyncedAt across a subsequent non-idle frame', () => {
    const firstSync = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(firstSync);
    setSyncProgress({ phase: 'idle', currentTable: null, documentsProcessed: 1 });

    // A new cycle starts: non-idle frames must not reset the last successful time.
    setSyncProgress({ phase: 'user_data', currentTable: 'boardsesh_ticks', documentsProcessed: 2 });
    const status = getSyncStatusSnapshot();
    expect(status.isSyncing).toBe(true);
    expect(status.lastSyncedAt).toBe(firstSync);
  });

  it('reset clears progress back to null', () => {
    setSyncProgress({ phase: 'deletions', currentTable: null, documentsProcessed: 7 });
    expect(getSyncStatusSnapshot().progress).not.toBeNull();

    __resetSyncStatusForTests();
    expect(getSyncStatusSnapshot()).toEqual({
      progress: null,
      isSyncing: false,
      lastSyncedAt: null,
      bootstrapMetadataRevision: 0,
      scopeCompletionRevision: 0,
    });
  });

  it('advances bootstrap metadata per scope while preserving the active multi-scope progress', () => {
    setSyncProgress({ phase: 'bootstrap', currentTable: 'kilter:1:5', documentsProcessed: 0 });
    notifyBootstrapMetadataChanged({ scopeKey: 'kilter:1:5' });
    expect(getSyncStatusSnapshot()).toEqual(
      expect.objectContaining({
        bootstrapMetadataRevision: 1,
        isSyncing: true,
        progress: { phase: 'bootstrap', currentTable: 'kilter:1:5', documentsProcessed: 0 },
      }),
    );

    setSyncProgress({ phase: 'bootstrap', currentTable: 'tension:1:10', documentsProcessed: 0 });
    notifyBootstrapMetadataChanged({ scopeKey: 'tension:1:10' });
    expect(getSyncStatusSnapshot().bootstrapMetadataRevision).toBe(2);
    expect(getSyncStatusSnapshot().progress?.currentTable).toBe('tension:1:10');

    setSyncProgress({ phase: 'deletions', currentTable: null, documentsProcessed: 0 });
    expect(getSyncStatusSnapshot().bootstrapMetadataRevision).toBe(2);

    setSyncProgress({ phase: 'board_data', currentTable: 'board_climbs:kilter:1:5', documentsProcessed: 1 });
    expect(getSyncStatusSnapshot().bootstrapMetadataRevision).toBe(2);
  });

  it('advances per-scope completion without ending progress for a later scope', () => {
    setSyncProgress({
      phase: 'board_data',
      currentTable: 'board_climbs:kilter:1:5',
      documentsProcessed: 100,
    });
    notifyScopeDownloadComplete({
      scopeKey: 'kilter:1:5',
      method: 'paged',
      durationMs: 100,
      phases: emptyScopeDownloadPhases(),
    });

    const afterFirstScope = getSyncStatusSnapshot();
    expect(afterFirstScope.scopeCompletionRevision).toBe(1);
    expect(afterFirstScope.isSyncing).toBe(true);
    expect(afterFirstScope.progress?.currentTable).toBe('board_climbs:kilter:1:5');

    setSyncProgress({
      phase: 'board_data',
      currentTable: 'board_climbs:tension:2:10',
      documentsProcessed: 200,
    });
    notifyScopeDownloadComplete({
      scopeKey: 'tension:2:10',
      method: 'paged',
      durationMs: 200,
      phases: emptyScopeDownloadPhases(),
    });
    expect(getSyncStatusSnapshot().scopeCompletionRevision).toBe(2);
  });
});
