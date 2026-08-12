// The pre-download size estimate (issue #3616). Its whole value is that it never
// quotes a number the download won't match, so most of this file is the `unknown`
// branches: every case where the paged crawl runs instead of a snapshot import.
//
// Eligibility is not restated here: `estimateScopeDownload` CALLS the engine's
// own `evaluateBootstrapEligibility`, and the parity table at the bottom pins
// that the two verdicts agree row for row — that drift is the only way this
// feature starts lying to users.

import { describe, it, expect } from 'vitest';
import {
  estimateScopeDownload,
  findSnapshotEntry,
  isSnapshotEntryUsable,
  type SnapshotDownloadEstimate,
} from '../snapshot-estimate';
import {
  evaluateBootstrapEligibility,
  EMPTY_BOOTSTRAP_RETRY_STATE,
  MAX_BOOTSTRAP_ATTEMPTS,
  MAX_TRANSPORT_DOWNLOAD_FAILURES,
  type BootstrapRetryState,
} from '../bootstrap-retry';
import { LATEST_SCHEMA_VERSION } from '../../db/migrations';
import type { SnapshotManifest, SnapshotManifestEntry } from '../snapshot-manifest';

function entry(patch: Partial<SnapshotManifestEntry> = {}): SnapshotManifestEntry {
  return {
    boardType: 'kilter',
    layoutId: 1,
    key: 'board-snapshots/v1/kilter/1/2026-07-15T02-31-02-103Z.db',
    url: 'https://cdn.example/board-snapshots/v1/kilter/1/2026-07-15T02-31-02-103Z.db',
    // The real kilter:1 artifact size — the 270 MB case this feature exists for.
    bytes: 269873152,
    contentEncoding: 'identity',
    builtAt: '2026-07-15T02:31:02.103Z',
    schemaVersion: LATEST_SCHEMA_VERSION,
    tables: {
      board_climbs: { watermarkUpdatedAt: '2026-07-15T02:27:19.720744Z', watermarkSyncSeq: '910564', rowCount: 370497 },
      board_climb_stats: {
        watermarkUpdatedAt: '2026-07-15T02:30:41.159455Z',
        watermarkSyncSeq: '44505481',
        rowCount: 351980,
      },
    },
    ...patch,
  };
}

function manifest(entries: SnapshotManifestEntry[] = [entry()]): SnapshotManifest {
  return { formatVersion: 1, generatedAt: '2026-07-15T02:33:29.916Z', entries };
}

const NOW = 1_800_000_000_000;

function retryState(patch: Partial<BootstrapRetryState> = {}): BootstrapRetryState {
  return { ...EMPTY_BOOTSTRAP_RETRY_STATE, ...patch };
}

/** A scope that would bootstrap: fresh on both board tables, nothing burned. */
function eligible(patch: Partial<Parameters<typeof estimateScopeDownload>[0]> = {}) {
  return estimateScopeDownload({
    manifest: manifest(),
    boardType: 'kilter',
    layoutId: 1,
    retryState: retryState(),
    hasBoardCheckpoint: false,
    isScopeComplete: false,
    isBootstrapDone: false,
    now: NOW,
    ...patch,
  });
}

describe('findSnapshotEntry', () => {
  it('matches on boardType AND layoutId together', () => {
    const entries = [entry({ boardType: 'kilter', layoutId: 1 }), entry({ boardType: 'tension', layoutId: 1 })];
    expect(findSnapshotEntry(manifest(entries), 'tension', 1)?.boardType).toBe('tension');
  });

  it('returns null when the layout has not been exported', () => {
    expect(findSnapshotEntry(manifest(), 'kilter', 99)).toBeNull();
  });

  it('does not match a different board that shares the layout id', () => {
    expect(findSnapshotEntry(manifest([entry({ boardType: 'kilter', layoutId: 1 })]), 'moonboard', 1)).toBeNull();
  });
});

describe('isSnapshotEntryUsable', () => {
  it('accepts an artifact built at the client schema', () => {
    expect(isSnapshotEntryUsable(entry({ schemaVersion: LATEST_SCHEMA_VERSION }))).toBe(true);
  });

  it('accepts a NEWER artifact (bootstrap intersects columns)', () => {
    expect(isSnapshotEntryUsable(entry({ schemaVersion: LATEST_SCHEMA_VERSION + 1 }))).toBe(true);
  });

  it('rejects a STALER artifact (import would NULL-fill the client’s newer columns)', () => {
    expect(isSnapshotEntryUsable(entry({ schemaVersion: LATEST_SCHEMA_VERSION - 1 }))).toBe(false);
  });
});

describe('estimateScopeDownload', () => {
  it('quotes the artifact bytes + climb count for a fresh, exported scope', () => {
    expect(eligible()).toEqual<SnapshotDownloadEstimate>({
      kind: 'snapshot',
      bytes: 269873152,
      climbCount: 370497,
      builtAt: '2026-07-15T02:31:02.103Z',
    });
  });

  it('quotes the whole-layout artifact regardless of which size is enabled', () => {
    // The artifact is per-(boardType, layoutId) and downloaded whole; the import
    // then keeps only the enabled size's rows. So the download really is this big.
    expect(eligible()).toMatchObject({ kind: 'snapshot', bytes: 269873152 });
  });

  it('is unknown when the manifest is unavailable (not fetched / unreachable / snapshots off)', () => {
    expect(eligible({ manifest: null })).toEqual({ kind: 'unknown' });
  });

  it('is unknown when the scope has a checkpoint and no snapshot failures — a re-enable pulls a delta, not 270 MB', () => {
    expect(eligible({ hasBoardCheckpoint: true })).toEqual({ kind: 'unknown' });
  });

  it('quotes the artifact for a mid-crawl scope the engine would heal', () => {
    // The heal-over-partial path (issue #4313): the scope holds a fraction of the
    // catalog, never finished the crawl, and has snapshot failures behind it.
    expect(
      eligible({
        hasBoardCheckpoint: true,
        retryState: retryState({ structuralFailures: 1, hasPriorSnapshotFailure: true }),
      }),
    ).toMatchObject({ kind: 'snapshot' });
  });

  it('is unknown for a scope that already serves the whole catalog offline', () => {
    expect(eligible({ isScopeComplete: true })).toEqual({ kind: 'unknown' });
  });

  it('is unknown once the engine has given up on the snapshot for this scope', () => {
    expect(eligible({ retryState: retryState({ structuralFailures: MAX_BOOTSTRAP_ATTEMPTS }) })).toEqual({
      kind: 'unknown',
    });
    expect(eligible({ retryState: retryState({ transportFailures: MAX_TRANSPORT_DOWNLOAD_FAILURES }) })).toEqual({
      kind: 'unknown',
    });
  });

  it('is unknown while the scope is waiting out a scheduled retry', () => {
    expect(eligible({ retryState: retryState({ retryAfter: NOW + 60_000 }) })).toEqual({ kind: 'unknown' });
  });

  it('still quotes a size on the last remaining structural attempt', () => {
    expect(eligible({ retryState: retryState({ structuralFailures: MAX_BOOTSTRAP_ATTEMPTS - 1 }) })).toMatchObject({
      kind: 'snapshot',
    });
  });

  it('quotes a size for a user-requested retry even though the scope is terminal', () => {
    // The confirm dialog behind "Try the fast download again" restores the budget
    // as its action, so the size it discloses must be the artifact's.
    expect(
      eligible({
        retryState: retryState({ structuralFailures: MAX_BOOTSTRAP_ATTEMPTS }),
        userRequested: true,
      }),
    ).toMatchObject({ kind: 'snapshot' });
  });

  it('refuses even a user-requested quote for a complete or already-warmed scope', () => {
    expect(eligible({ isScopeComplete: true, userRequested: true })).toEqual({ kind: 'unknown' });
    expect(eligible({ isBootstrapDone: true, userRequested: true })).toEqual({ kind: 'unknown' });
  });

  it('is unknown when the layout has not been exported yet', () => {
    expect(eligible({ layoutId: 99 })).toEqual({ kind: 'unknown' });
  });

  it('is unknown for a schema-stale artifact (skipped before the download)', () => {
    expect(eligible({ manifest: manifest([entry({ schemaVersion: LATEST_SCHEMA_VERSION - 1 })]) })).toEqual({
      kind: 'unknown',
    });
  });

  it('is unknown for an empty manifest', () => {
    expect(eligible({ manifest: manifest([]) })).toEqual({ kind: 'unknown' });
  });

  it('reports a zero-byte artifact as a real estimate, not a falsy miss', () => {
    // Guards against a truthiness check creeping in: `bytes: 0` must stay a
    // 'snapshot' answer (the dialog renders it as "0 B") rather than collapsing
    // into 'unknown' and silently dropping the size line.
    expect(eligible({ manifest: manifest([entry({ bytes: 0 })]) })).toMatchObject({ kind: 'snapshot', bytes: 0 });
  });
});

describe('estimateScopeDownload parity with the engine gate', () => {
  // The mirror that used to be a promise in a comment. Every row asserts the
  // estimate's snapshot/unknown verdict equals evaluateBootstrapEligibility's,
  // so the UI can never quote a number for a download the engine would skip.
  const rows: Array<{
    name: string;
    scopeState: Omit<Parameters<typeof evaluateBootstrapEligibility>[0], 'now'>;
  }> = [
    {
      name: 'fresh',
      scopeState: {
        retryState: retryState(),
        hasBoardCheckpoint: false,
        isScopeComplete: false,
        isBootstrapDone: false,
      },
    },
    {
      name: 'heal-over-partial',
      scopeState: {
        retryState: retryState({ transportFailures: 1, hasPriorSnapshotFailure: true }),
        hasBoardCheckpoint: true,
        isScopeComplete: false,
        isBootstrapDone: false,
      },
    },
    {
      name: 'mid-crawl with no failure history',
      scopeState: {
        retryState: retryState(),
        hasBoardCheckpoint: true,
        isScopeComplete: false,
        isBootstrapDone: false,
      },
    },
    {
      name: 'scope complete',
      scopeState: { retryState: retryState(), hasBoardCheckpoint: true, isScopeComplete: true, isBootstrapDone: false },
    },
    {
      name: 'already bootstrapped',
      scopeState: { retryState: retryState(), hasBoardCheckpoint: true, isScopeComplete: false, isBootstrapDone: true },
    },
    {
      name: 'terminal on transport',
      scopeState: {
        retryState: retryState({ transportFailures: MAX_TRANSPORT_DOWNLOAD_FAILURES, hasPriorSnapshotFailure: true }),
        hasBoardCheckpoint: false,
        isScopeComplete: false,
        isBootstrapDone: false,
      },
    },
    {
      name: 'cooling down',
      scopeState: {
        retryState: retryState({ transportFailures: 1, hasPriorSnapshotFailure: true, retryAfter: NOW + 1 }),
        hasBoardCheckpoint: false,
        isScopeComplete: false,
        isBootstrapDone: false,
      },
    },
    {
      name: 'cooldown just elapsed',
      scopeState: {
        retryState: retryState({ transportFailures: 1, hasPriorSnapshotFailure: true, retryAfter: NOW }),
        hasBoardCheckpoint: false,
        isScopeComplete: false,
        isBootstrapDone: false,
      },
    },
  ];

  for (const row of rows) {
    it(`agrees with the engine for: ${row.name}`, () => {
      const verdict = evaluateBootstrapEligibility({ ...row.scopeState, now: NOW });
      const estimate = eligible({ ...row.scopeState, now: NOW });
      expect(estimate.kind === 'snapshot').toBe(verdict.eligible);
    });
  }
});

describe('estimateScopeDownload — the separate grades artifact (issue #4310)', () => {
  it('adds the grades artifact’s bytes to the quoted figure', () => {
    const withGrades = manifest([
      entry({
        bytes: 100_000_000,
        grades: {
          key: 'board-snapshots/v1-gzip/kilter/1/2026-06-01-grades.db',
          url: 'https://cdn.example/grades.db',
          bytes: 3_000_000,
          contentEncoding: 'gzip',
          builtAt: '2026-06-01T00:00:00.000Z',
          schemaVersion: LATEST_SCHEMA_VERSION,
          tables: {
            board_climb_grades: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '1', rowCount: 900 },
          },
        },
      }),
    ]);

    const estimate = eligible({ manifest: withGrades });

    // The scope downloads BOTH files, so quoting only the climbs one would
    // under-promise what the user is about to spend.
    expect(estimate).toEqual({
      kind: 'snapshot',
      bytes: 103_000_000,
      climbCount: 370497,
      builtAt: '2026-07-15T02:31:02.103Z',
    });
  });

  it('is unchanged when the entry has no grades block', () => {
    const estimate = eligible({ manifest: manifest([entry({ bytes: 100_000_000 })]) });

    expect(estimate).toEqual({
      kind: 'snapshot',
      bytes: 100_000_000,
      climbCount: 370497,
      builtAt: '2026-07-15T02:31:02.103Z',
    });
  });
});
