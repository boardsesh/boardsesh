// The pure rules behind the snapshot download progress row (issue #4311):
// which denominator a platform byte counter is divided by, what happens when
// the two turn out to be on different scales, and how many frames a human
// actually needs to see.
//
// The invariant every case here defends: the number the row renders is WIRE
// scale (`entry.bytes`, ~103 MB for kilter:1), the same figure the enable-confirm
// dialog quoted — never the decoded ~271 MB.

import { describe, it, expect } from 'vitest';
import {
  createDownloadFractionAnchor,
  createSnapshotProgressThrottle,
  resolveDownloadFraction,
  toWireProgress,
  DOWNLOAD_PROGRESS_THROTTLE_MS,
  type DownloadFractionAnchor,
  type SnapshotBootstrapProgress,
} from '../snapshot-progress';
import type { SnapshotManifestEntry } from '../snapshot-manifest';

const WIRE_BYTES = 103_000_000;
const DECODED_BYTES = 271_000_000;

function gzipEntry(overrides: Partial<SnapshotManifestEntry> = {}): SnapshotManifestEntry {
  return {
    boardType: 'kilter',
    layoutId: 1,
    key: 'board-snapshots/v1-gzip/kilter/1/2026-08-01T00-00-00-000Z.db',
    url: 'https://cdn.example/kilter-1.db',
    bytes: WIRE_BYTES,
    uncompressedBytes: DECODED_BYTES,
    contentEncoding: 'gzip',
    builtAt: '2026-08-01T00:00:00.000Z',
    schemaVersion: 3,
    tables: {
      board_climbs: { watermarkUpdatedAt: '2026-08-01T00:00:00Z', watermarkSyncSeq: '1', rowCount: 1 },
      board_climb_stats: { watermarkUpdatedAt: '2026-08-01T00:00:00Z', watermarkSyncSeq: '1', rowCount: 1 },
    },
    ...overrides,
  };
}

function identityEntry(): SnapshotManifestEntry {
  return gzipEntry({ contentEncoding: 'identity', bytes: WIRE_BYTES, uncompressedBytes: WIRE_BYTES });
}

/** One frame's worth of resolution, threading the anchor the way the engine does. */
function step(
  entry: SnapshotManifestEntry,
  anchor: DownloadFractionAnchor,
  bytesWritten: number,
  reportedTotalBytes: number | null,
): { fraction: number | null; anchor: DownloadFractionAnchor } {
  return resolveDownloadFraction({ entry, bytesWritten, reportedTotalBytes, anchor });
}

describe('resolveDownloadFraction — denominator precedence', () => {
  it('prefers the platform-reported total (iOS: total and counter arrive self-paired)', () => {
    // Reported total is the compressed scale here; uncompressedBytes is bigger.
    // Taking the reported one keeps the ratio internally consistent.
    const { fraction } = step(gzipEntry(), createDownloadFractionAnchor(), WIRE_BYTES / 2, WIRE_BYTES);
    expect(fraction).toBeCloseTo(0.5, 5);
  });

  it('falls back to uncompressedBytes for a gzip entry when the platform reports no total (Android)', () => {
    // OkHttp gunzips transparently, so contentLength() is -1 and the write loop
    // counts DECODED bytes — uncompressedBytes is the proven matching scale.
    const { fraction } = step(gzipEntry(), createDownloadFractionAnchor(), DECODED_BYTES / 4, null);
    expect(fraction).toBeCloseTo(0.25, 5);
  });

  it('falls back to entry.bytes for an identity entry with no reported total', () => {
    const { fraction } = step(identityEntry(), createDownloadFractionAnchor(), WIRE_BYTES / 10, null);
    expect(fraction).toBeCloseTo(0.1, 5);
  });

  it('is indeterminate for a gzip entry with no reported total and no uncompressedBytes (pre-field artifact)', () => {
    const legacy = gzipEntry({ uncompressedBytes: undefined });
    const { fraction } = step(legacy, createDownloadFractionAnchor(), 5_000_000, null);
    expect(fraction).toBeNull();
  });

  it('treats a non-positive reported total as no total at all', () => {
    for (const reported of [0, -1]) {
      const { fraction } = step(gzipEntry(), createDownloadFractionAnchor(), DECODED_BYTES / 2, reported);
      expect(fraction).toBeCloseTo(0.5, 5);
    }
  });

  it('latches the denominator so the bar cannot change scale mid-download', () => {
    const entry = gzipEntry();
    const first = step(entry, createDownloadFractionAnchor(), 1_000_000, WIRE_BYTES);
    expect(first.anchor.denominator).toBe(WIRE_BYTES);
    // A later frame that reports a different total does not re-pick.
    const second = step(entry, first.anchor, 2_000_000, DECODED_BYTES);
    expect(second.anchor.denominator).toBe(WIRE_BYTES);
    expect(second.fraction).toBeCloseTo(2_000_000 / WIRE_BYTES, 5);
  });
});

describe('resolveDownloadFraction — overshoot', () => {
  it('re-anchors to the decoded size when the counter runs past a compressed total', () => {
    // The iOS hazard: totalBytesWritten counting decoded bytes against a
    // Content-Length-derived (compressed) expected total.
    const entry = gzipEntry();
    let anchor = createDownloadFractionAnchor();

    const early = step(entry, anchor, WIRE_BYTES / 2, WIRE_BYTES);
    anchor = early.anchor;
    expect(early.fraction).toBeCloseTo(0.5, 5);

    // Past 102% of the compressed total: the scales disagree.
    const overshot = step(entry, anchor, Math.round(WIRE_BYTES * 1.5), WIRE_BYTES);
    anchor = overshot.anchor;
    expect(anchor.denominator).toBe(DECODED_BYTES);
    expect(anchor.latchedIndeterminate).toBe(false);
    expect(overshot.fraction).toBeCloseTo((WIRE_BYTES * 1.5) / DECODED_BYTES, 4);

    // And it keeps rising from there rather than freezing at 100%.
    const later = step(entry, anchor, Math.round(DECODED_BYTES * 0.8), WIRE_BYTES);
    expect(later.fraction!).toBeGreaterThan(overshot.fraction!);
    expect(later.fraction).toBeCloseTo(0.8, 4);
  });

  it('does not re-anchor inside the 2% tolerance', () => {
    const entry = gzipEntry();
    const result = step(entry, createDownloadFractionAnchor(), Math.round(WIRE_BYTES * 1.01), WIRE_BYTES);
    expect(result.anchor.denominator).toBe(WIRE_BYTES);
    expect(result.fraction).toBe(0.99); // pre-terminal cap
  });

  it('latches indeterminate for the rest of the download when no larger candidate exists', () => {
    // Identity entry: wire == decoded, so there is nothing bigger to re-anchor to.
    const entry = identityEntry();
    let anchor = createDownloadFractionAnchor();
    const overshot = step(entry, anchor, Math.round(WIRE_BYTES * 1.5), null);
    anchor = overshot.anchor;
    expect(overshot.fraction).toBeNull();
    expect(anchor.latchedIndeterminate).toBe(true);

    // Even a later, plausible frame stays indeterminate rather than flickering back.
    const later = step(entry, anchor, WIRE_BYTES / 2, null);
    expect(later.fraction).toBeNull();
    expect(later.anchor.latchedIndeterminate).toBe(true);
  });
});

describe('resolveDownloadFraction — terminal frame and clamping', () => {
  it('reads bytesWritten === totalBytes as "complete", not as a data point', () => {
    // expo-file-system's JS wrapper fires a synthetic final frame carrying the
    // DECODED on-disk size in BOTH fields, so the last frame changes scale.
    const entry = gzipEntry();
    const anchor: DownloadFractionAnchor = { denominator: WIRE_BYTES, latchedIndeterminate: false };
    const terminal = step(entry, anchor, DECODED_BYTES, DECODED_BYTES);
    expect(terminal.fraction).toBe(1);
    // It must not have tripped the overshoot detector or moved the anchor.
    expect(terminal.anchor.denominator).toBe(WIRE_BYTES);
    expect(terminal.anchor.latchedIndeterminate).toBe(false);
  });

  it('caps a pre-terminal fraction at 0.99 so the row never claims to be done early', () => {
    const entry = identityEntry();
    const { fraction } = step(entry, createDownloadFractionAnchor(), WIRE_BYTES - 1, null);
    expect(fraction).toBe(0.99);
  });

  it('clamps a negative byte count to 0', () => {
    const { fraction } = step(identityEntry(), createDownloadFractionAnchor(), -50, null);
    expect(fraction).toBe(0);
  });
});

describe('toWireProgress — the row only ever sees wire-scale bytes', () => {
  it('reports done/total against entry.bytes even when the counter was decoded', () => {
    const entry = gzipEntry();
    // Android: half the DECODED stream has landed.
    const { fraction } = step(entry, createDownloadFractionAnchor(), DECODED_BYTES / 2, null);
    const wire = toWireProgress(fraction, entry.bytes);
    expect(wire.wireBytes).toBe(WIRE_BYTES);
    expect(wire.wireBytesDone).toBe(Math.round(0.5 * WIRE_BYTES));
    // The 271 MB figure can never reach a caption.
    expect(wire.wireBytesDone!).toBeLessThan(WIRE_BYTES);
  });

  it('reports the full wire size on the terminal frame, not the decoded one', () => {
    const entry = gzipEntry();
    const terminal = step(
      entry,
      { denominator: WIRE_BYTES, latchedIndeterminate: false },
      DECODED_BYTES,
      DECODED_BYTES,
    );
    expect(toWireProgress(terminal.fraction, entry.bytes)).toEqual({
      wireBytes: WIRE_BYTES,
      wireBytesDone: WIRE_BYTES,
    });
  });

  it('leaves wireBytesDone null when the fraction is indeterminate', () => {
    expect(toWireProgress(null, WIRE_BYTES)).toEqual({ wireBytes: WIRE_BYTES, wireBytesDone: null });
  });
});

describe('createSnapshotProgressThrottle', () => {
  function frame(overrides: Partial<SnapshotBootstrapProgress> = {}): SnapshotBootstrapProgress {
    return {
      scopeKey: 'kilter:1:5',
      stage: 'download',
      fraction: 0.1,
      wireBytes: WIRE_BYTES,
      wireBytesDone: 10_300_000,
      ...overrides,
    };
  }

  function clock(): { now: () => number; advance: (ms: number) => void } {
    let millis = 1_000;
    return { now: () => millis, advance: (ms) => void (millis += ms) };
  }

  it('emits the first frame, suppresses one 100 ms later, emits again at 400 ms', () => {
    const time = clock();
    const throttle = createSnapshotProgressThrottle({ now: time.now });

    expect(throttle.offer(frame({ fraction: 0.1, wireBytesDone: 10_300_000 }))).not.toBeNull();
    time.advance(100);
    expect(throttle.offer(frame({ fraction: 0.2, wireBytesDone: 20_600_000 }))).toBeNull();
    time.advance(DOWNLOAD_PROGRESS_THROTTLE_MS - 100);
    expect(throttle.offer(frame({ fraction: 0.3, wireBytesDone: 30_900_000 }))).not.toBeNull();
  });

  it('drops a frame where neither the rounded percent nor the rounded megabytes moved', () => {
    const time = clock();
    const throttle = createSnapshotProgressThrottle({ now: time.now });
    expect(throttle.offer(frame({ fraction: 0.5, wireBytesDone: 51_500_000 }))).not.toBeNull();
    time.advance(1_000);
    // 0.5004 still rounds to 50%, and the byte figure still rounds to 52 MB.
    expect(throttle.offer(frame({ fraction: 0.5004, wireBytesDone: 51_500_400 }))).toBeNull();
  });

  it('never walks the bar backwards', () => {
    const time = clock();
    const throttle = createSnapshotProgressThrottle({ now: time.now });
    expect(throttle.offer(frame({ fraction: 0.6, wireBytesDone: 61_800_000 }))).not.toBeNull();
    time.advance(1_000);
    // A downloader that restarted its counter (retry) must not regress the row.
    expect(throttle.offer(frame({ fraction: 0.2, wireBytesDone: 20_600_000 }))).toBeNull();
  });

  it('lets a stage change and the terminal frame through immediately', () => {
    const time = clock();
    const throttle = createSnapshotProgressThrottle({ now: time.now });
    expect(throttle.offer(frame({ fraction: 0.9, wireBytesDone: 92_700_000 }))).not.toBeNull();
    // Same millisecond: the throttle window would normally suppress both.
    expect(throttle.offer(frame({ fraction: 1, wireBytesDone: WIRE_BYTES }))).not.toBeNull();
    expect(throttle.offer(frame({ stage: 'import', fraction: null, wireBytesDone: null }))).not.toBeNull();
  });

  it('flush ignores the throttle window entirely', () => {
    const time = clock();
    const throttle = createSnapshotProgressThrottle({ now: time.now });
    throttle.flush(frame({ stage: 'manifest', fraction: null, wireBytes: null, wireBytesDone: null }));
    const downloadStart = throttle.flush(frame({ fraction: 0, wireBytesDone: 0 }));
    expect(downloadStart.stage).toBe('download');
  });

  it('a flushed stage frame does not stall the first real byte frame behind the window', () => {
    // The engine flushes "download, 0 bytes" the instant the download starts;
    // a native downloader's first byte event can land in the same millisecond.
    // Charging the flush against the window would leave the row on 0% for
    // 400 ms — exactly the frozen look #4311 is about.
    const time = clock();
    const throttle = createSnapshotProgressThrottle({ now: time.now });
    throttle.flush(frame({ fraction: 0, wireBytesDone: 0 }));
    expect(throttle.offer(frame({ fraction: 0.05, wireBytesDone: 5_150_000 }))).not.toBeNull();
  });

  it('cancel() suppresses every later frame, so a late callback cannot re-light a finished row', () => {
    const time = clock();
    const throttle = createSnapshotProgressThrottle({ now: time.now });
    expect(throttle.offer(frame())).not.toBeNull();
    throttle.cancel();
    time.advance(10_000);
    expect(throttle.offer(frame({ fraction: 0.99, wireBytesDone: 101_970_000 }))).toBeNull();
  });
});
