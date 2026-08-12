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
    uncompressedBytes: 456789,
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
    expect(
      parseSnapshotManifest({ formatVersion: 1, generatedAt: '2026-06-01T00:05:00.000Z', entries: [] }),
    ).not.toBeNull();
  });

  it('rejects non-ISO timestamps in generatedAt, builtAt, and watermarkUpdatedAt', () => {
    // A corrupted timestamp would otherwise be stored as the resume watermark
    // and pulled from later — reject the whole manifest instead.
    expect(parseSnapshotManifest({ formatVersion: 1, generatedAt: 'now-ish', entries: [] })).toBeNull();
    expect(parseSnapshotManifest(withEntry({ builtAt: 'yesterday' }))).toBeNull();
    expect(parseSnapshotManifest(withEntry({ builtAt: '2026-06-01T00:00:00' }))).toBeNull(); // no Z
    const validTables = validEntry().tables;
    expect(
      parseSnapshotManifest(
        withEntry({
          tables: {
            ...validTables,
            board_climbs: { ...validTables.board_climbs, watermarkUpdatedAt: '01/06/2026' },
          },
        }),
      ),
    ).toBeNull();
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

  it('accepts an entry with no uncompressedBytes (every entry built before the field existed)', () => {
    const entry = validEntry();
    delete entry.uncompressedBytes;
    const parsed = parseSnapshotManifest({
      formatVersion: 1,
      generatedAt: '2026-06-01T00:05:00.000Z',
      entries: [entry],
    });
    expect(parsed?.entries[0].uncompressedBytes).toBeUndefined();
  });

  it('accepts a non-negative integer uncompressedBytes and rejects fractional / negative ones', () => {
    expect(parseSnapshotManifest(withEntry({ uncompressedBytes: 271_000_000 }))).not.toBeNull();
    expect(parseSnapshotManifest(withEntry({ uncompressedBytes: 0 }))).not.toBeNull();
    expect(parseSnapshotManifest(withEntry({ uncompressedBytes: 1.5 }))).toBeNull();
    expect(parseSnapshotManifest(withEntry({ uncompressedBytes: -1 }))).toBeNull();
    expect(parseSnapshotManifest(withEntry({ uncompressedBytes: '271000000' as unknown as number }))).toBeNull();
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

// Backward-compat gate for the additive `grades` block (issue #4310). The
// validator below is a FROZEN COPY of the predicate that shipped before grades
// existed, checked in rather than imported, so it keeps testing the old
// behaviour even as the real one evolves. If a manifest carrying grades ever
// stops parsing under it, every already-installed binary loses the snapshot
// fast path the moment the export publishes.
function parseWithShippedV1Validator(value: unknown): unknown | null {
  const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
  const isInteger = (candidate: unknown): boolean => typeof candidate === 'number' && Number.isInteger(candidate);
  const isDecimalString = (candidate: unknown): boolean => typeof candidate === 'string' && /^\d+$/.test(candidate);
  const isIso = (candidate: unknown): boolean =>
    typeof candidate === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(candidate) &&
    Number.isFinite(Date.parse(candidate));
  const isTableStats = (candidate: unknown): boolean =>
    isRecord(candidate) &&
    isIso(candidate.watermarkUpdatedAt) &&
    isDecimalString(candidate.watermarkSyncSeq) &&
    isInteger(candidate.rowCount);
  const isEntry = (candidate: unknown): boolean => {
    if (!isRecord(candidate)) return false;
    if (
      typeof candidate.boardType !== 'string' ||
      !isInteger(candidate.layoutId) ||
      typeof candidate.key !== 'string' ||
      typeof candidate.url !== 'string' ||
      !isInteger(candidate.bytes) ||
      (candidate.contentEncoding !== 'gzip' && candidate.contentEncoding !== 'identity') ||
      !isIso(candidate.builtAt) ||
      !isInteger(candidate.schemaVersion)
    ) {
      return false;
    }
    const tables = candidate.tables;
    if (!isRecord(tables)) return false;
    return ['board_climbs', 'board_climb_stats'].every((tableName) => isTableStats(tables[tableName]));
  };

  if (!isRecord(value)) return null;
  if (value.formatVersion !== 1) return null;
  if (!isIso(value.generatedAt)) return null;
  if (!Array.isArray(value.entries)) return null;
  if (!value.entries.every(isEntry)) return null;
  return value;
}

function validGradesArtifact() {
  return {
    key: 'board-snapshots/v1-gzip/kilter/8/2026-06-01T00-00-00-000Z-grades.db',
    url: 'https://cdn.example/board-snapshots/v1-gzip/kilter/8/2026-06-01T00-00-00-000Z-grades.db',
    bytes: 2048,
    contentEncoding: 'gzip' as const,
    builtAt: '2026-06-01T00:00:00.000Z',
    schemaVersion: 3,
    tables: {
      board_climb_grades: { watermarkUpdatedAt: '2026-05-30T08:00:00Z', watermarkSyncSeq: '777', rowCount: 5000 },
    },
  };
}

describe('parseSnapshotManifest — the optional grades artifact', () => {
  it('accepts an entry with no grades block at all (MoonBoard, or the export rolled back)', () => {
    expect(parseSnapshotManifest(validManifest())).not.toBeNull();
  });

  it('accepts and preserves a well-formed grades block', () => {
    const manifest = withEntry({ grades: validGradesArtifact() });

    const parsed = parseSnapshotManifest(JSON.parse(JSON.stringify(manifest)) as unknown);

    expect(parsed?.entries[0].grades?.tables.board_climb_grades.rowCount).toBe(5000);
  });

  it('REJECTS a malformed grades block rather than trusting half of it', () => {
    // A truncated grades block that still parsed would be trusted far enough to
    // stamp a grades checkpoint over rows that never arrived.
    for (const broken of [
      { ...validGradesArtifact(), bytes: 1.5 },
      { ...validGradesArtifact(), key: 42 },
      { ...validGradesArtifact(), contentEncoding: 'br' },
      { ...validGradesArtifact(), builtAt: 'not-a-timestamp' },
      { ...validGradesArtifact(), tables: {} },
      { ...validGradesArtifact(), tables: { board_climb_grades: { rowCount: 1 } } },
      'not an object',
    ]) {
      expect(parseSnapshotManifest(withEntry({ grades: broken as never })), JSON.stringify(broken)).toBeNull();
    }
  });

  it('parses under the FROZEN shipped v1 validator — no installed binary can choke on it', () => {
    const manifest = JSON.parse(JSON.stringify(withEntry({ grades: validGradesArtifact() }))) as unknown;

    expect(parseWithShippedV1Validator(manifest)).not.toBeNull();
  });

  it('keeps the grades artifact OUT of `entries` — a sibling entry would be picked as the whole layout', () => {
    // findSnapshotEntry first-matches on (boardType, layoutId), so a grades
    // artifact promoted to its own entry could be imported by an older client
    // as if it carried the layout's climbs, stamping checkpoints past rows it
    // never imported. Permanent loss, so pin the shape.
    const manifest = parseSnapshotManifest(
      JSON.parse(JSON.stringify(withEntry({ grades: validGradesArtifact() }))) as unknown,
    );

    expect(manifest?.entries).toHaveLength(1);
    expect(manifest?.entries[0].tables).not.toHaveProperty('board_climb_grades');
  });
});
