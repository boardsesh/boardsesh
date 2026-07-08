// Structural validation of the board-snapshot manifest (the Phase 2 export ↔
// Phase 3 bootstrap contract). Focuses on the corruption modes a client must
// reject: wrong format version, fractional values where integers are required,
// numeric sync seqs (the protocol carries them as decimal strings), and
// missing per-table stats.

import { describe, it, expect } from 'vitest';
import { parseSnapshotManifest, type SnapshotManifest, type SnapshotManifestEntry } from '../snapshot-manifest';

function validEntry(): SnapshotManifestEntry {
  return {
    boardType: 'kilter',
    layoutId: 8,
    key: 'board-snapshots/v1/kilter/8/2026-06-01T00-00-00-000Z.db',
    url: 'https://cdn.example/board-snapshots/v1/kilter/8/2026-06-01T00-00-00-000Z.db',
    bytes: 123456,
    contentEncoding: 'gzip',
    builtAt: '2026-06-01T00:00:00.000Z',
    schemaVersion: 3,
    tables: {
      board_climbs: {
        watermarkUpdatedAt: '2026-05-30T10:00:00Z',
        watermarkSyncSeq: '9007199254740993',
        rowCount: 40000,
      },
      board_climb_stats: { watermarkUpdatedAt: '2026-05-30T09:00:00Z', watermarkSyncSeq: '12345', rowCount: 90000 },
    },
  };
}

function validManifest(): SnapshotManifest {
  return { formatVersion: 1, generatedAt: '2026-06-01T00:05:00.000Z', entries: [validEntry()] };
}

function withEntry(patch: Partial<SnapshotManifestEntry>): unknown {
  return { ...validManifest(), entries: [{ ...validEntry(), ...patch }] };
}

describe('parseSnapshotManifest', () => {
  it('accepts a valid manifest (round-trips through JSON)', () => {
    const manifest = JSON.parse(JSON.stringify(validManifest())) as unknown;
    expect(parseSnapshotManifest(manifest)).toEqual(validManifest());
  });

  it('accepts an empty entries array', () => {
    expect(parseSnapshotManifest({ formatVersion: 1, generatedAt: 'now-ish', entries: [] })).not.toBeNull();
  });

  it('rejects non-objects and wrong format versions', () => {
    expect(parseSnapshotManifest(null)).toBeNull();
    expect(parseSnapshotManifest('manifest')).toBeNull();
    expect(parseSnapshotManifest([])).toBeNull();
    expect(parseSnapshotManifest({ ...validManifest(), formatVersion: 2 })).toBeNull();
  });

  it('rejects fractional layoutId / bytes / schemaVersion / rowCount (integer-strict)', () => {
    expect(parseSnapshotManifest(withEntry({ layoutId: 1.5 }))).toBeNull();
    expect(parseSnapshotManifest(withEntry({ bytes: 1.5 }))).toBeNull();
    expect(parseSnapshotManifest(withEntry({ schemaVersion: 1.5 }))).toBeNull();
    const fractionalRowCount = withEntry({
      tables: {
        board_climbs: { watermarkUpdatedAt: 't', watermarkSyncSeq: '1', rowCount: 1.5 },
        board_climb_stats: { watermarkUpdatedAt: 't', watermarkSyncSeq: '1', rowCount: 1 },
      },
    });
    expect(parseSnapshotManifest(fractionalRowCount)).toBeNull();
  });

  it('rejects a numeric watermarkSyncSeq — the protocol carries seqs as decimal strings', () => {
    const numericSeq = withEntry({
      tables: {
        board_climbs: {
          watermarkUpdatedAt: 't',
          watermarkSyncSeq: 12 as unknown as string,
          rowCount: 1,
        },
        board_climb_stats: { watermarkUpdatedAt: 't', watermarkSyncSeq: '1', rowCount: 1 },
      },
    });
    expect(parseSnapshotManifest(numericSeq)).toBeNull();
    const nonDecimalSeq = withEntry({
      tables: {
        board_climbs: { watermarkUpdatedAt: 't', watermarkSyncSeq: '12abc', rowCount: 1 },
        board_climb_stats: { watermarkUpdatedAt: 't', watermarkSyncSeq: '1', rowCount: 1 },
      },
    });
    expect(parseSnapshotManifest(nonDecimalSeq)).toBeNull();
  });

  it('rejects an entry missing one of the two per-table stats', () => {
    const missingStats = {
      ...validManifest(),
      entries: [{ ...validEntry(), tables: { board_climbs: validEntry().tables.board_climbs } }],
    };
    expect(parseSnapshotManifest(missingStats)).toBeNull();
  });

  it('rejects an unknown contentEncoding', () => {
    expect(parseSnapshotManifest(withEntry({ contentEncoding: 'br' as unknown as 'gzip' }))).toBeNull();
  });
});
