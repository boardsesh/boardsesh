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
  it('ignores a gzip entry’s Content-Length total and divides by the decoded size (iOS)', () => {
    // URLSession pairs a DECODED counter with a Content-Length (compressed)
    // expected total. Dividing by that total is what raced the bar to 100% at
    // ~38% of the transfer, so the decoded size wins.
    const { fraction, anchor } = step(gzipEntry(), createDownloadFractionAnchor(), DECODED_BYTES / 2, WIRE_BYTES);
    expect(anchor.denominator).toBe(DECODED_BYTES);
    expect(fraction).toBeCloseTo(0.5, 5);
  });

  it('uses the platform-reported total when it is already on the on-disk scale', () => {
    // A total bigger than the stored object size is the file being written, not
    // the Content-Length — take it, so a stale uncompressedBytes cannot shrink
    // the denominator below what the platform says it will write.
    const { fraction, anchor } = step(
      gzipEntry(),
      createDownloadFractionAnchor(),
      DECODED_BYTES / 2,
      DECODED_BYTES + 4_000_000,
    );
    expect(anchor.denominator).toBe(DECODED_BYTES + 4_000_000);
    expect(fraction!).toBeLessThan(0.5);
  });

  it('uses the platform-reported total for an identity entry (wire == decoded)', () => {
    const { fraction } = step(identityEntry(), createDownloadFractionAnchor(), WIRE_BYTES / 2, WIRE_BYTES);
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

  it('is indeterminate for a pre-field gzip entry even when the platform reports its wire size', () => {
    // The decoded size is genuinely unknown here, and the only total on offer is
    // ~2.6× too small. A byte counter with no bar beats a bar that reaches 100%
    // before a third of the artifact has landed. Closed by re-exporting the
    // manifest with uncompressedBytes (#4335), not by guessing a ratio.
    const legacy = gzipEntry({ uncompressedBytes: undefined });
    let anchor = createDownloadFractionAnchor();
    for (const written of [WIRE_BYTES / 4, WIRE_BYTES / 2, WIRE_BYTES]) {
      const resolved = step(legacy, anchor, written, WIRE_BYTES);
      anchor = resolved.anchor;
      expect(resolved.fraction).toBeNull();
    }
  });

  it('treats a non-positive reported total as no total at all', () => {
    for (const reported of [0, -1]) {
      const { fraction } = step(gzipEntry(), createDownloadFractionAnchor(), DECODED_BYTES / 2, reported);
      expect(fraction).toBeCloseTo(0.5, 5);
    }
  });

  it('latches the denominator so the bar cannot change scale mid-download', () => {
    const entry = identityEntry();
    const first = step(entry, createDownloadFractionAnchor(), 1_000_000, WIRE_BYTES);
    expect(first.anchor.denominator).toBe(WIRE_BYTES);
    // A later frame that reports a different total does not re-pick.
    const second = step(entry, first.anchor, 2_000_000, DECODED_BYTES);
    expect(second.anchor.denominator).toBe(WIRE_BYTES);
    expect(second.fraction).toBeCloseTo(2_000_000 / WIRE_BYTES, 5);
  });
});

describe('resolveDownloadFraction — overshoot', () => {
  it('never anchors to a compressed total, so the decoded counter cannot overshoot it', () => {
    // The iOS hazard, end to end: totalBytesWritten counting decoded bytes
    // against a Content-Length-derived (compressed) expected total. Every frame
    // divides by the decoded size, so the fraction tracks the real transfer and
    // the bar is still moving well past the point the compressed total would
    // have pinned it at 100%.
    const entry = gzipEntry();
    let anchor = createDownloadFractionAnchor();

    const early = step(entry, anchor, WIRE_BYTES / 2, WIRE_BYTES);
    anchor = early.anchor;
    expect(early.fraction).toBeCloseTo(WIRE_BYTES / 2 / DECODED_BYTES, 5);

    // Past the compressed total: no overshoot, no re-anchor, no latch.
    const pastWire = step(entry, anchor, Math.round(WIRE_BYTES * 1.5), WIRE_BYTES);
    anchor = pastWire.anchor;
    expect(anchor.denominator).toBe(DECODED_BYTES);
    expect(anchor.latchedIndeterminate).toBe(false);
    expect(pastWire.fraction!).toBeGreaterThan(early.fraction!);
    expect(pastWire.fraction).toBeCloseTo((WIRE_BYTES * 1.5) / DECODED_BYTES, 4);

    const later = step(entry, anchor, Math.round(DECODED_BYTES * 0.8), WIRE_BYTES);
    expect(later.fraction!).toBeGreaterThan(pastWire.fraction!);
    expect(later.fraction).toBeCloseTo(0.8, 4);
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

  it('does not read a decoded counter passing the compressed total as "complete"', () => {
    // On iOS the decoded counter crosses the Content-Length total around 38% of
    // a Kilter download; an exact hit must not be mistaken for the synthetic
    // final frame, or the row reports 100% with 168 MB still to come.
    const entry = gzipEntry();
    const { fraction } = step(entry, createDownloadFractionAnchor(), WIRE_BYTES, WIRE_BYTES);
    expect(fraction).toBeCloseTo(WIRE_BYTES / DECODED_BYTES, 5);
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

  it('swallows everything after a fraction that steps back — why the resolver must not re-scale', () => {
    // The composition hazard this file exists to pin: hand the throttle 0.99 and
    // then a re-scaled 0.39 (what re-anchoring a compressed total to the decoded
    // size used to produce) and the monotonic gate drops every frame until the
    // raw fraction climbs back past 0.99 — i.e. the row freezes for the last
    // ~60% of a 3–9 minute download. `resolveDownloadFraction` therefore latches
    // one denominator instead of re-anchoring; see the composed run below.
    const time = clock();
    const throttle = createSnapshotProgressThrottle({ now: time.now });
    expect(throttle.offer(frame({ fraction: 0.99, wireBytesDone: 101_970_000 }))).not.toBeNull();
    for (const fraction of [0.39, 0.5, 0.7, 0.9, 0.98]) {
      time.advance(1_000);
      expect(throttle.offer(frame({ fraction, wireBytesDone: Math.round(fraction * WIRE_BYTES) }))).toBeNull();
    }
  });
});

describe('resolveDownloadFraction ∘ throttle — a whole iOS gzip download', () => {
  const NATIVE_PROGRESS_INTERVAL_MS = 100;

  /**
   * Replay a download the way the engine does: resolve a fraction per native
   * progress event, thread the anchor, render wire-scale bytes, throttle. What
   * comes back is exactly the sequence of rows a climber would have watched.
   */
  function replay(
    entry: SnapshotManifestEntry,
    events: { bytesWritten: number; reportedTotalBytes: number | null }[],
  ): { bytesWritten: number; fraction: number | null; wireBytesDone: number | null }[] {
    let millis = 0;
    const throttle = createSnapshotProgressThrottle({ now: () => millis });
    let anchor = createDownloadFractionAnchor();
    const shown: { bytesWritten: number; fraction: number | null; wireBytesDone: number | null }[] = [];

    for (const event of events) {
      const resolved = resolveDownloadFraction({
        entry,
        bytesWritten: event.bytesWritten,
        reportedTotalBytes: event.reportedTotalBytes,
        anchor,
      });
      anchor = resolved.anchor;
      const emitted = throttle.offer({
        scopeKey: 'kilter:1:5',
        stage: 'download',
        fraction: resolved.fraction,
        ...toWireProgress(resolved.fraction, entry.bytes),
      });
      if (emitted) {
        shown.push({
          bytesWritten: event.bytesWritten,
          fraction: emitted.fraction,
          wireBytesDone: emitted.wireBytesDone,
        });
      }
      millis += NATIVE_PROGRESS_INTERVAL_MS;
    }
    return shown;
  }

  /** Decoded bytes arriving at a steady rate, paired with a Content-Length total. */
  function iosEvents(): { bytesWritten: number; reportedTotalBytes: number | null }[] {
    const events: { bytesWritten: number; reportedTotalBytes: number | null }[] = [];
    // ~1,800 events at 100 ms apart: a three-minute Kilter download, the p50.
    const chunk = Math.round(DECODED_BYTES / 1_800);
    for (let written = chunk; written < DECODED_BYTES; written += chunk) {
      events.push({ bytesWritten: written, reportedTotalBytes: WIRE_BYTES });
    }
    // expo's JS wrapper closes with a synthetic frame carrying the on-disk size.
    events.push({ bytesWritten: DECODED_BYTES, reportedTotalBytes: DECODED_BYTES });
    return events;
  }

  it('keeps the row moving for the whole transfer instead of freezing at 99%', () => {
    const shown = replay(gzipEntry(), iosEvents());

    // Monotonic, and it finishes on a true 100% at the full wire size.
    const fractions = shown.map((row) => row.fraction!);
    expect(fractions.every((value) => value !== null)).toBe(true);
    for (let index = 1; index < fractions.length; index += 1) {
      expect(fractions[index]).toBeGreaterThanOrEqual(fractions[index - 1]);
    }
    expect(shown.at(-1)).toEqual({ bytesWritten: DECODED_BYTES, fraction: 1, wireBytesDone: WIRE_BYTES });

    // The regression: the compressed total put the row at 99% / "102 MB of
    // 103 MB" once 103 MB of the 271 MB stream had landed (~38%), and the
    // monotonic gate then dropped every later frame. Nothing may claim ≥ 99%
    // before the bytes are actually there.
    const early = shown.filter((row) => row.bytesWritten < DECODED_BYTES * 0.9);
    expect(early.every((row) => row.fraction! < 0.9)).toBe(true);
    expect(early.some((row) => row.wireBytesDone! > WIRE_BYTES - 5_000_000)).toBe(false);

    // And frames keep landing across the back half, not just before 38%.
    const lateFrames = shown.filter((row) => row.bytesWritten > DECODED_BYTES * 0.4);
    expect(lateFrames.length).toBeGreaterThan(20);
    const distinctLatePercents = new Set(lateFrames.map((row) => Math.round(row.fraction! * 100)));
    expect(distinctLatePercents.size).toBeGreaterThan(20);
  });

  it('shows a moving bar on Android too, where there is no reported total at all', () => {
    const events = iosEvents().map((event, index, all) =>
      index === all.length - 1 ? event : { ...event, reportedTotalBytes: null },
    );
    const shown = replay(gzipEntry(), events);
    expect(shown.length).toBeGreaterThan(30);
    expect(shown.at(-1)!.fraction).toBe(1);
    expect(shown.map((row) => row.fraction!)).toEqual(shown.map((row) => row.fraction!).sort((a, b) => a - b));
  });
});
