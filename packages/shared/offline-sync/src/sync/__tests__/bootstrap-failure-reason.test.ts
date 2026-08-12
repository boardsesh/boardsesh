// The download funnel's "why", pinned bucket by bucket.
//
// Every case here is a shape the bootstrap phase really produces, so a rename of an
// error class or a reworded message shows up as a failing test rather than as a
// silent slide of live traffic into `unknown`.

import { describe, it, expect } from 'vitest';
import { classifySnapshotBootstrapFailure } from '../bootstrap-failure-reason';
import {
  SnapshotWipedError,
  SnapshotSchemaStaleError,
  SnapshotPermanentMissError,
  SnapshotWatermarkRegressionError,
} from '../snapshot-bootstrap';

describe('classifySnapshotBootstrapFailure', () => {
  it('names the engine error classes', () => {
    expect(classifySnapshotBootstrapFailure(new SnapshotWipedError())).toBe('aborted-wipe');
    expect(classifySnapshotBootstrapFailure(new SnapshotSchemaStaleError(3))).toBe('schema-stale');
    expect(classifySnapshotBootstrapFailure(new SnapshotPermanentMissError('still gzipped'))).toBe('permanent-miss');
    expect(
      classifySnapshotBootstrapFailure(
        new SnapshotWatermarkRegressionError(
          'board_climbs',
          { updatedAt: '2026-01-01T00:00:00.000Z', syncSeq: '1' },
          { updatedAt: '2026-06-01T00:00:00.000Z', syncSeq: '9' },
        ),
      ),
    ).toBe('watermark-regression');
  });

  // The bucket this issue exists to make visible. Both codes count: 5 is another
  // connection, 6 is this one, and a climber cannot tell them apart.
  it('buckets SQLite lock contention, including the code-6 shape from BOARDSESH-D7', () => {
    expect(
      classifySnapshotBootstrapFailure(
        new Error(
          "Calling the 'finalizeAsync' function has failed → Caused by: SQLiteErrorException: Error code 6: database table is locked",
        ),
      ),
    ).toBe('database-locked');
    expect(classifySnapshotBootstrapFailure(new Error('Error code 5: database is locked'))).toBe('database-locked');
  });

  // Walks the cause chain, because expo-sqlite wraps the driver error.
  it('finds a lock through a wrapped cause', () => {
    const wrapped = new Error("Calling the 'runAsync' function has failed", {
      cause: new Error('Error code 6: database table is locked'),
    });

    expect(classifySnapshotBootstrapFailure(wrapped)).toBe('database-locked');
  });

  it('buckets the artifact-verification failures', () => {
    const cases = [
      'snapshot bootstrap: quick_check failed: page 3 is never used',
      'snapshot bootstrap: snapshot_meta missing row for board_climb_stats',
      'snapshot bootstrap: format_version 2 != 3 for board_climbs',
      'snapshot bootstrap: board_climbs row_count 900 != actual 12 (truncated artifact?)',
      'snapshot bootstrap: no shared board_climbs columns',
    ];

    for (const message of cases) {
      expect(classifySnapshotBootstrapFailure(new Error(message)), message).toBe('artifact-invalid');
    }
  });

  it('buckets a dropped connection as network', () => {
    expect(classifySnapshotBootstrapFailure(new TypeError('Network request failed'))).toBe('network');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(classifySnapshotBootstrapFailure(new Error('something else entirely'))).toBe('unknown');
    expect(classifySnapshotBootstrapFailure(null)).toBe('unknown');
    expect(classifySnapshotBootstrapFailure(undefined)).toBe('unknown');
  });
});
