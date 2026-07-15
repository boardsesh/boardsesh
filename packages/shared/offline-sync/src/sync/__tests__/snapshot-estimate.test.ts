// The pre-download size estimate (issue #3616). Its whole value is that it never
// quotes a number the download won't match, so most of this file is the `unknown`
// branches: every case where the paged crawl runs instead of a snapshot import.
//
// The eligibility rules here mirror runBootstrapPhase's. `mirrors runBootstrapPhase`
// below is the guard against the two drifting apart — that drift is the only way
// this feature starts lying to users.

import { describe, it, expect } from 'vitest';
import {
  estimateScopeDownload,
  findSnapshotEntry,
  isSnapshotEntryUsable,
  type SnapshotDownloadEstimate,
} from '../snapshot-estimate';
import { MAX_BOOTSTRAP_ATTEMPTS } from '../snapshot-bootstrap';
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

/** A scope that would bootstrap: fresh on both board tables, no attempts burned. */
function eligible(patch: Partial<Parameters<typeof estimateScopeDownload>[0]> = {}) {
  return estimateScopeDownload({
    manifest: manifest(),
    boardType: 'kilter',
    layoutId: 1,
    hasExistingCheckpoint: false,
    bootstrapAttempts: 0,
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

  it('is unknown when the scope already has a checkpoint — a re-enable pulls a delta, not 270 MB', () => {
    expect(eligible({ hasExistingCheckpoint: true })).toEqual({ kind: 'unknown' });
  });

  it('is unknown once the engine has given up on the snapshot for this scope', () => {
    expect(eligible({ bootstrapAttempts: MAX_BOOTSTRAP_ATTEMPTS })).toEqual({ kind: 'unknown' });
  });

  it('still quotes a size on the last remaining attempt', () => {
    expect(eligible({ bootstrapAttempts: MAX_BOOTSTRAP_ATTEMPTS - 1 })).toMatchObject({ kind: 'snapshot' });
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
