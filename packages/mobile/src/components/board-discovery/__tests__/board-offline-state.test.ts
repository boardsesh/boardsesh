import { describe, it, expect } from 'vitest';
import {
  boardDownloadNotice,
  boardDownloadProgress,
  boardDownloadState,
  boardIsBootstrapping,
  offlineCatalogState,
} from '../board-offline-state';
import type { SnapshotBootstrapProgress } from '@boardsesh/offline-sync';

const base = {
  scopeKey: 'kilter:1:5',
  enabled: true,
  isBootstrapDone: false,
  isSyncing: false,
  downloaded: false,
  currentTable: null as string | null,
};

describe('boardDownloadState', () => {
  it('is off when the board is not enabled', () => {
    expect(boardDownloadState({ ...base, enabled: false })).toBe('off');
  });

  it('is pending when enabled but its own data has not landed', () => {
    expect(boardDownloadState({ ...base, enabled: true, downloaded: false })).toBe('pending');
  });

  it('is downloaded once its own checkpoint exists', () => {
    expect(boardDownloadState({ ...base, downloaded: true })).toBe('downloaded');
  });

  it('is downloading while its own board_climbs table is being pulled', () => {
    expect(boardDownloadState({ ...base, isSyncing: true, currentTable: 'board_climbs:kilter:1:5' })).toBe(
      'downloading',
    );
  });

  it('is downloading while its own board_climb_stats table is being pulled', () => {
    expect(boardDownloadState({ ...base, isSyncing: true, currentTable: 'board_climb_stats:kilter:1:5' })).toBe(
      'downloading',
    );
  });

  it('is downloading while its own board_climb_grades table is being pulled', () => {
    expect(boardDownloadState({ ...base, isSyncing: true, currentTable: 'board_climb_grades:kilter:1:5' })).toBe(
      'downloading',
    );
  });

  it('does not cross-trigger on a sibling scope with a shared prefix', () => {
    // kilter:1:50 must not read as downloading when kilter:1:5 is the one syncing.
    expect(
      boardDownloadState({
        scopeKey: 'kilter:1:50',
        enabled: true,
        isBootstrapDone: false,
        isSyncing: true,
        downloaded: false,
        currentTable: 'board_climbs:kilter:1:5',
      }),
    ).toBe('pending');
  });

  it('matches board_climb_grades by exact scope instead of a sibling prefix', () => {
    expect(
      boardDownloadState({
        scopeKey: 'kilter:1:50',
        enabled: true,
        isBootstrapDone: false,
        isSyncing: true,
        downloaded: false,
        currentTable: 'board_climb_grades:kilter:1:5',
      }),
    ).toBe('pending');
  });

  it('a freshly-enabled board stays pending while another board is mid-cycle', () => {
    // Its own data hasn't landed yet even though a cycle is running for a sibling.
    expect(
      boardDownloadState({
        ...base,
        isSyncing: true,
        downloaded: false,
        currentTable: 'board_climbs:tension:8:10',
      }),
    ).toBe('pending');
  });

  it.each([
    ['bootstrap', 'tension:8:10'],
    ['deletions', null],
    ['user_data', 'boardsesh_ticks'],
    ['board_data', 'board_climbs:tension:8:10'],
  ] as const)(
    'is finalizing during the active %s phase once its snapshot imported but the scope is incomplete',
    (phase, currentTable) => {
      expect(
        boardDownloadState({
          ...base,
          isBootstrapDone: true,
          isSyncing: true,
          downloaded: false,
          currentTable,
          phase,
        }),
      ).toBe('finalizing');
    },
  );

  it.each([
    ['bootstrap', 'tension:8:10'],
    ['deletions', null],
    ['user_data', 'boardsesh_ticks'],
    ['board_data', 'board_climbs:tension:8:10'],
  ] as const)('stays pending during active %s work when snapshot bootstrap did not land', (phase, currentTable) => {
    expect(
      boardDownloadState({
        ...base,
        isBootstrapDone: false,
        isSyncing: true,
        currentTable,
        phase,
      }),
    ).toBe('pending');
  });

  it('does not call an incomplete board finalizing when no sync cycle is active', () => {
    expect(boardDownloadState({ ...base, isBootstrapDone: true, isSyncing: false, phase: 'deletions' })).toBe(
      'pending',
    );
  });

  it.each([null, 'idle'] as const)('does not call an imported board finalizing for a %s progress phase', (phase) => {
    expect(boardDownloadState({ ...base, isBootstrapDone: true, isSyncing: true, phase })).toBe('pending');
  });

  it('keeps a completed board downloaded during shared finalizing work', () => {
    expect(boardDownloadState({ ...base, isSyncing: true, downloaded: true, phase: 'deletions' })).toBe('downloaded');
  });

  it('stays downloaded when a later cycle is syncing a different board', () => {
    expect(
      boardDownloadState({
        ...base,
        isSyncing: true,
        downloaded: true,
        currentTable: 'board_climbs:tension:8:10',
      }),
    ).toBe('downloaded');
  });

  it('is downloading while the snapshot-bootstrap phase is warming this exact scope', () => {
    expect(boardDownloadState({ ...base, isSyncing: true, currentTable: 'kilter:1:5', phase: 'bootstrap' })).toBe(
      'downloading',
    );
  });

  it('does not cross-trigger bootstrap on a sibling scope with a shared prefix', () => {
    expect(
      boardDownloadState({
        scopeKey: 'kilter:1:50',
        enabled: true,
        isBootstrapDone: false,
        isSyncing: true,
        downloaded: false,
        currentTable: 'kilter:1:5',
        phase: 'bootstrap',
      }),
    ).toBe('pending');
  });

  it('does not read as downloading when currentTable matches but the phase is not bootstrap', () => {
    // A bare scope key matching currentTable only means "bootstrapping" when
    // phase is actually 'bootstrap' — this guards against a stale/undefined
    // phase accidentally matching.
    expect(boardDownloadState({ ...base, isSyncing: true, currentTable: 'kilter:1:5', phase: null })).toBe('pending');
  });
});

describe('boardIsBootstrapping', () => {
  it('is true only during the bootstrap phase for this exact scope while syncing', () => {
    expect(boardIsBootstrapping({ ...base, isSyncing: true, currentTable: 'kilter:1:5', phase: 'bootstrap' })).toBe(
      true,
    );
  });

  it('is false during the paged board_data phase, even for this scope', () => {
    expect(
      boardIsBootstrapping({
        ...base,
        isSyncing: true,
        currentTable: 'board_climbs:kilter:1:5',
        phase: 'board_data',
      }),
    ).toBe(false);
  });

  it('is false when not syncing at all', () => {
    expect(boardIsBootstrapping({ ...base, isSyncing: false, currentTable: 'kilter:1:5', phase: 'bootstrap' })).toBe(
      false,
    );
  });

  it('is false for a sibling scope sharing the bootstrap phase', () => {
    expect(
      boardIsBootstrapping({
        scopeKey: 'kilter:1:50',
        enabled: true,
        isBootstrapDone: false,
        isSyncing: true,
        downloaded: false,
        currentTable: 'kilter:1:5',
        phase: 'bootstrap',
      }),
    ).toBe(false);
  });
});

describe('boardDownloadNotice', () => {
  const noticeBase = {
    enabled: true,
    downloaded: false,
    snapshotSourceAvailable: true,
    bootstrapAttempts: 0,
    isTerminal: false,
    retryAfter: null,
    isBootstrapDone: false,
    isPagedFallback: false,
    hasBoardCheckpoint: false,
    isScopeComplete: false,
    isBootstrapping: false,
    isPagedDownloadActive: false,
  };

  it('shows a retrying notice after a transient snapshot failure', () => {
    expect(boardDownloadNotice({ ...noticeBase, bootstrapAttempts: 1 })).toBe('snapshot-retrying');
  });

  it('keeps the retrying notice while a snapshot attempt is scheduled', () => {
    // The crawl may be running underneath it, but the fast download WILL be
    // tried again — the caption promises what actually happens (issue #4313).
    expect(boardDownloadNotice({ ...noticeBase, bootstrapAttempts: 1, retryAfter: 1_800_000_000_000 })).toBe(
      'snapshot-retrying',
    );
  });

  it('shows a paged-fallback notice once both snapshot budgets are spent', () => {
    expect(boardDownloadNotice({ ...noticeBase, bootstrapAttempts: 2, isTerminal: true })).toBe('paged-fallback');
  });

  it('does not condemn a board to the slow path just because it failed twice', () => {
    // Pre-#4313 this was the cliff: two transport failures and the caption said
    // "slower download" for the life of the install.
    expect(boardDownloadNotice({ ...noticeBase, bootstrapAttempts: 2 })).toBe('snapshot-retrying');
  });

  it('uses the explicit paged outcome after a transient failure followed by a permanent miss', () => {
    expect(boardDownloadNotice({ ...noticeBase, bootstrapAttempts: 1, isPagedFallback: true })).toBe('paged-fallback');
  });

  it('keeps a mid-crawl scope on the retrying caption — it can still be healed', () => {
    expect(boardDownloadNotice({ ...noticeBase, bootstrapAttempts: 1, hasBoardCheckpoint: true })).toBe(
      'snapshot-retrying',
    );
  });

  it('does not turn a normal paged download into a failure notice', () => {
    expect(boardDownloadNotice(noticeBase)).toBeNull();
  });

  it('clears an earlier retry marker after a snapshot import succeeds', () => {
    expect(boardDownloadNotice({ ...noticeBase, bootstrapAttempts: 1, isBootstrapDone: true })).toBeNull();
  });

  it('clears the notice once the scope has completed its download', () => {
    expect(boardDownloadNotice({ ...noticeBase, isTerminal: true, downloaded: true })).toBeNull();
  });

  it('clears from the metadata batch as soon as the per-scope completion marker lands', () => {
    expect(boardDownloadNotice({ ...noticeBase, isTerminal: true, isScopeComplete: true })).toBeNull();
  });

  it('ignores stale bootstrap markers when snapshot I/O is unavailable', () => {
    expect(boardDownloadNotice({ ...noticeBase, isTerminal: true, snapshotSourceAvailable: false })).toBeNull();
  });

  it('restores the correct retry outcome when snapshot I/O is toggled back on before paging starts', () => {
    const persistedRetry = { ...noticeBase, bootstrapAttempts: 1 };
    expect(boardDownloadNotice({ ...persistedRetry, snapshotSourceAvailable: false })).toBeNull();
    expect(boardDownloadNotice({ ...persistedRetry, snapshotSourceAvailable: true })).toBe('snapshot-retrying');
  });

  it('reports the settled verdict while the crawl it fell back to is running', () => {
    expect(
      boardDownloadNotice({
        ...noticeBase,
        bootstrapAttempts: 2,
        isTerminal: true,
        isPagedDownloadActive: true,
      }),
    ).toBe('paged-fallback');
  });

  it('lets an active bootstrap attempt outrank stale fallback history', () => {
    expect(
      boardDownloadNotice({
        ...noticeBase,
        bootstrapAttempts: 1,
        isPagedFallback: true,
        isTerminal: true,
        isBootstrapping: true,
      }),
    ).toBeNull();
  });
});

describe('boardDownloadProgress', () => {
  const downloadingFrame: SnapshotBootstrapProgress = {
    scopeKey: 'kilter:1:5',
    stage: 'download',
    fraction: 0.4,
    wireBytes: 103_000_000,
    wireBytesDone: 41_200_000,
  };
  const downloadingRow = {
    scopeKey: 'kilter:1:5',
    isSyncing: true,
    currentTable: 'kilter:1:5' as string | null,
    phase: 'bootstrap' as const,
    snapshot: downloadingFrame,
    progressEnabled: true,
  };

  it('returns the wire-scale numbers for the scope that is actually downloading', () => {
    expect(boardDownloadProgress(downloadingRow)).toEqual({
      stage: 'download',
      fraction: 0.4,
      bytesDone: 41_200_000,
      bytesTotal: 103_000_000,
    });
  });

  it('returns null for a SIBLING SIZE of the same layout, which shares the frame stream', () => {
    // kilter:1:50 must not pick up kilter:1:5's bytes — the two rows sit next to
    // each other in My Boards and only the scope key tells them apart.
    expect(
      boardDownloadProgress({ ...downloadingRow, scopeKey: 'kilter:1:50', currentTable: 'kilter:1:50' }),
    ).toBeNull();
  });

  it('returns null when the frame belongs to another scope entirely', () => {
    expect(
      boardDownloadProgress({
        ...downloadingRow,
        snapshot: { ...downloadingFrame, scopeKey: 'tension:2:10' },
      }),
    ).toBeNull();
  });

  it('returns null when no cycle is running, when the phase is not bootstrap, and when there is no frame', () => {
    expect(boardDownloadProgress({ ...downloadingRow, isSyncing: false })).toBeNull();
    expect(boardDownloadProgress({ ...downloadingRow, phase: 'board_data' })).toBeNull();
    expect(boardDownloadProgress({ ...downloadingRow, snapshot: undefined })).toBeNull();
  });

  it('returns null with the kill switch off, so the row keeps the static caption', () => {
    // The engine still flushes its stage frames when `offline-download-progress`
    // is off — dropping the native callback only stops the byte frames. Without
    // this gate the row would show "Downloading 0 MB of 103 MB" for the whole
    // download instead of the plain "Downloading board…" the switch restores.
    expect(boardDownloadProgress({ ...downloadingRow, progressEnabled: false })).toBeNull();
    expect(
      boardDownloadProgress({
        ...downloadingRow,
        progressEnabled: false,
        snapshot: { ...downloadingFrame, stage: 'download', fraction: 0, wireBytesDone: 0 },
      }),
    ).toBeNull();
  });

  it('passes an indeterminate fraction straight through rather than inventing one', () => {
    expect(
      boardDownloadProgress({
        ...downloadingRow,
        snapshot: { ...downloadingFrame, fraction: null, wireBytesDone: null },
      }),
    ).toEqual({ stage: 'download', fraction: null, bytesDone: null, bytesTotal: 103_000_000 });
  });
});

// The catalog screens' half of the same derivation. It has to agree with the
// download CTA's gate, which hides the moment the scope leaves 'off': a screen
// asking "is it downloaded?" instead would keep the offer-the-download copy
// with the offer already gone.
describe('offlineCatalogState', () => {
  const catalogBase = {
    scopeKey: 'kilter:1:5',
    enabledScopeKeys: [] as string[],
    downloadedScopeKeys: [] as string[],
  };

  it('offers the download when the scope was never asked for', () => {
    expect(offlineCatalogState(catalogBase)).toBe('missing');
  });

  it('reports queued once the scope is armed but has not landed', () => {
    expect(offlineCatalogState({ ...catalogBase, enabledScopeKeys: ['kilter:1:5'] })).toBe('queued');
  });

  it('says nothing once this scope has actually downloaded', () => {
    expect(
      offlineCatalogState({
        ...catalogBase,
        enabledScopeKeys: ['kilter:1:5'],
        downloadedScopeKeys: ['kilter:1:5'],
      }),
    ).toBeNull();
  });

  it('ignores a sibling scope', () => {
    expect(offlineCatalogState({ ...catalogBase, enabledScopeKeys: ['kilter:1:50'] })).toBe('missing');
  });

  it('says nothing when there is no active board', () => {
    expect(offlineCatalogState({ ...catalogBase, scopeKey: null })).toBeNull();
  });

  it('treats a still-loading downloaded-scope query as not downloaded', () => {
    expect(offlineCatalogState({ ...catalogBase, downloadedScopeKeys: undefined })).toBe('missing');
  });
});
