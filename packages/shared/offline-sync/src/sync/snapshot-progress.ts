// Download/import progress for the snapshot bootstrap phase (issue #4311).
//
// The bootstrap phase used to emit one frame per scope and then go silent for
// the whole download + import — p50 2m55s on Kilter (8m52s on Android) behind a
// static "Downloading board…" spinner that looks exactly like a hang. This
// module is the contract that fills that gap: pure functions the engine feeds
// from the platform downloader, and a shape the UI renders without deriving
// anything itself.
//
// ONE BYTE SCALE, AND IT IS THE WIRE SCALE. The enable-confirm dialog quotes
// `entry.bytes` — the stored/compressed object size, ~103 MB for kilter:1 — so
// that is the only number the progress row may show. The decoded artifact
// (~271 MB under --gzip) never reaches the UI: quoting it would contradict the
// number the climber just accepted. `uncompressedBytes` is used here strictly as
// a DENOMINATOR for a platform byte counter that happens to count decoded bytes.
//
// Pure: no I/O, no clock of its own (the throttle takes an injected `now`), so
// every rule below is directly testable.
//
// Designed to survive #4310 restructuring the pipeline: `unitsDone`/`unitsTotal`
// is the pre-cut slot for a chunked import, and the frame shape does not assume
// the download is a single whole-artifact GET.

import type { SnapshotManifestEntry } from './snapshot-manifest';

/** Which part of the bootstrap a frame describes. */
export type SnapshotBootstrapStage = 'manifest' | 'download' | 'import';

/**
 * One progress frame for a board scope's snapshot bootstrap, carried on
 * `SyncProgress.snapshot`.
 *
 * Every byte number here is WIRE scale (`entry.bytes`), so a UI physically
 * cannot render the decoded size. `fraction` is derived once, in the engine, so
 * no renderer re-derives it and gets a different answer.
 */
export type SnapshotBootstrapProgress = {
  scopeKey: string;
  stage: SnapshotBootstrapStage;
  /**
   * 0..1, or null for "indeterminate" — no trustworthy denominator, so the UI
   * shows a byte counter and no bar rather than a made-up percentage.
   */
  fraction: number | null;
  /** The artifact's wire size, i.e. what the confirm dialog quoted. Null when unknown. */
  wireBytes: number | null;
  /** `fraction × wireBytes`, rounded. Null when either input is unknown. */
  wireBytesDone: number | null;
  /**
   * Optional discrete-unit progress (chunks, tables, batches). Unused by the
   * whole-artifact path today; #4310's chunked import feeds it without changing
   * this shape or any consumer that ignores it.
   */
  unitsDone?: number;
  unitsTotal?: number;
};

/**
 * The denominator choice, latched for the life of one download so the bar can't
 * flip scales frame to frame. `resolveDownloadFraction` returns the anchor it
 * used; the caller threads it back in on the next frame.
 */
export type DownloadFractionAnchor = {
  /** The byte total the platform counter is being divided by, or null = indeterminate. */
  denominator: number | null;
  /**
   * True once we have given up on a denominator entirely for this download —
   * the counter overshot every candidate we have, so no honest percentage
   * exists and the row must stay a byte counter until it finishes.
   */
  latchedIndeterminate: boolean;
};

/** A fresh anchor for the start of a download. */
export function createDownloadFractionAnchor(): DownloadFractionAnchor {
  return { denominator: null, latchedIndeterminate: false };
}

/**
 * How far past the denominator we tolerate before deciding the byte counter is
 * on a different scale than the total we chose. Small enough to catch a
 * compressed-total/decoded-counter mismatch within the first few percent of a
 * gzip artifact, large enough to absorb a downloader that writes a little past
 * a rounded Content-Length.
 */
const OVERSHOOT_TOLERANCE = 1.02;

/**
 * A reported total for a gzip entry this close to (or below) the stored object
 * size is the Content-Length, not the size of the file being written. Same slack
 * as the overshoot tolerance, for the same reason: absorb rounding, catch a
 * whole-scale mismatch.
 */
const WIRE_TOTAL_TOLERANCE = 1.02;

/**
 * A pre-terminal frame is capped here so the row never claims to be finished
 * while bytes are still arriving. The terminal frame is recognised separately
 * (see `resolveDownloadFraction`) and gets a true 1.
 */
const PRE_TERMINAL_FRACTION_CAP = 0.99;

export type DownloadFractionInput = {
  entry: Pick<SnapshotManifestEntry, 'bytes' | 'uncompressedBytes' | 'contentEncoding'>;
  /** Bytes the platform downloader says it has written so far. */
  bytesWritten: number;
  /** The platform's own total, or null when it doesn't have one (Android gzip reports -1). */
  reportedTotalBytes: number | null;
  anchor: DownloadFractionAnchor;
};

export type DownloadFractionResult = {
  fraction: number | null;
  anchor: DownloadFractionAnchor;
};

/**
 * The size the artifact will occupy on disk, when the manifest knows it, for a
 * body the platform gunzips on the way in. Null when the entry is identity
 * (`entry.bytes` already is the on-disk size) or predates `uncompressedBytes`.
 */
function decodedSizeBytes(entry: DownloadFractionInput['entry']): number | null {
  if (entry.contentEncoding !== 'gzip') return null;
  const decoded = entry.uncompressedBytes;
  return typeof decoded === 'number' && decoded > 0 ? decoded : null;
}

/**
 * True when a platform-reported total for a gzip entry is the COMPRESSED size —
 * i.e. it came from Content-Length rather than from the file being written.
 *
 * The counter it is paired with always counts bytes written to disk, and for a
 * gzip artifact those are decoded bytes: both platforms gunzip in the HTTP stack
 * (an artifact that arrives still compressed is rejected outright by the mobile
 * snapshot source), so a total on the wire scale is a scale mismatch, not a
 * denominator.
 */
function isWireScaleTotal(entry: DownloadFractionInput['entry'], reportedTotalBytes: number): boolean {
  if (entry.contentEncoding !== 'gzip') return false;
  return reportedTotalBytes <= entry.bytes * WIRE_TOTAL_TOLERANCE;
}

/**
 * Pick the denominator for a download's byte counter and turn it into a
 * fraction.
 *
 * ONE RULE UNDERNEATH ALL OF THIS: the platform counter counts bytes written to
 * disk. So the denominator has to be the size of the file that will be on disk —
 * decoded for a gzip entry, `entry.bytes` for an identity one — and never the
 * compressed transfer size, whoever reports it.
 *
 * PRECEDENCE:
 *
 * 1. `entry.uncompressedBytes` for a gzip entry, floored against the platform's
 *    own total: `max(uncompressedBytes, reportedTotalBytes)`. Android has no
 *    total at all (OkHttp gunzips transparently, so `body.contentLength()` is
 *    -1) and iOS reports `totalBytesExpectedToWrite` straight off Content-Length
 *    — the compressed size — while `totalBytesWritten` counts the decoded stream.
 *    Dividing by that total is what raced the bar to 100% at ~38% of a Kilter
 *    download. Taking the larger of the two keeps rule 2 whenever the platform
 *    total IS on the decoded scale, and ignores it when it is the Content-Length.
 * 2. The platform's own `reportedTotalBytes`, when > 0 and not a gzip entry's
 *    wire size. For an identity artifact every candidate agrees anyway.
 * 3. `entry.bytes` for an identity entry — wire == decoded, so it is exact.
 * 4. Null: indeterminate. Show the byte counter, no bar. This is a gzip artifact
 *    exported before `uncompressedBytes` shipped: the decoded size is genuinely
 *    unknown, and a bar built on the compressed one would be off by ~2.6×.
 *
 * TERMINAL FRAME. expo-file-system's JS wrapper fires a synthetic final frame
 * `{ bytesWritten: fileSize, totalBytes: fileSize }` carrying the DECODED
 * on-disk size. Equal values mean "complete", never "here is a data point" —
 * treat it as fraction 1. A gzip entry's wire-scale total is excluded from the
 * check first: on iOS the decoded counter passes the compressed total mid-flight,
 * and one unlucky exact hit would otherwise read as "done" at ~38%.
 *
 * OVERSHOOT. If the counter still runs more than 2% past the denominator, some
 * scale we cannot name is in play. Latch indeterminate for the rest of the
 * download — pinning the bar at 100% while bytes keep arriving is the frozen look
 * this module exists to remove, and there is no honest number left to show.
 *
 * MONOTONIC BY CONSTRUCTION: the denominator is chosen once, on the first frame
 * that has a candidate, and latched in the anchor. Because the platform counter
 * only rises, so does the fraction — nothing downstream has to repair a
 * regression, which matters because the throttle drops backwards frames.
 */
export function resolveDownloadFraction(input: DownloadFractionInput): DownloadFractionResult {
  const { entry, bytesWritten, reportedTotalBytes, anchor } = input;

  const reportedTotal = reportedTotalBytes !== null && reportedTotalBytes > 0 ? reportedTotalBytes : null;
  // A gzip entry's Content-Length is on the wrong scale for a decoded counter,
  // so it is not a total as far as everything below is concerned.
  const onDiskTotal = reportedTotal !== null && !isWireScaleTotal(entry, reportedTotal) ? reportedTotal : null;

  // The synthetic terminal frame. Recognised before anything else so it can
  // neither move the anchor nor trip the overshoot detector.
  if (onDiskTotal !== null && bytesWritten === onDiskTotal) {
    return { fraction: 1, anchor };
  }

  if (anchor.latchedIndeterminate) {
    return { fraction: null, anchor };
  }

  let denominator = anchor.denominator;
  if (denominator === null) {
    const decodedSize = decodedSizeBytes(entry);
    if (decodedSize !== null) {
      denominator = Math.max(decodedSize, onDiskTotal ?? 0);
    } else if (onDiskTotal !== null) {
      denominator = onDiskTotal;
    } else if (entry.contentEncoding === 'identity') {
      denominator = entry.bytes;
    }
  }

  if (denominator === null || denominator <= 0) {
    return { fraction: null, anchor: { denominator: null, latchedIndeterminate: false } };
  }

  if (bytesWritten > denominator * OVERSHOOT_TOLERANCE) {
    return { fraction: null, anchor: { denominator: null, latchedIndeterminate: true } };
  }

  const rawFraction = bytesWritten / denominator;
  const clamped = Math.min(Math.max(rawFraction, 0), PRE_TERMINAL_FRACTION_CAP);
  return { fraction: clamped, anchor: { denominator, latchedIndeterminate: false } };
}

/**
 * Turn a wire-scale fraction into the two numbers the row renders. Rounding
 * happens here, once, so "42 MB" and the bar width can never disagree.
 */
export function toWireProgress(
  fraction: number | null,
  wireBytes: number | null,
): { wireBytes: number | null; wireBytesDone: number | null } {
  if (wireBytes === null || fraction === null) return { wireBytes, wireBytesDone: null };
  return { wireBytes, wireBytesDone: Math.round(fraction * wireBytes) };
}

/**
 * Minimum wall-clock gap between emitted download frames. Android's native
 * downloader emits every 100 ms, which over an 8m52s Kilter download is ~5,300
 * events; at 400 ms plus the rounded-value gate below, the My Boards list
 * re-renders roughly a quarter as often.
 */
export const DOWNLOAD_PROGRESS_THROTTLE_MS = 400;

export type SnapshotProgressThrottle = {
  /**
   * Offer a frame. Returns the frame to emit, or null when this one is
   * suppressed (too soon, or nothing a human could see has changed).
   */
  offer(frame: SnapshotBootstrapProgress): SnapshotBootstrapProgress | null;
  /**
   * Emit `frame` regardless of timing — for a stage boundary, where the caller
   * needs the UI to reflect the transition immediately. A flushed frame does
   * NOT open a rate-limit window: there are only three of them per scope, and
   * charging one against the window would stall the first real byte frame for
   * 400 ms right after the download starts, which is the moment the row most
   * needs to stop looking frozen.
   */
  flush(frame: SnapshotBootstrapProgress): SnapshotBootstrapProgress;
  /**
   * Stop emitting entirely. Called when a download finishes or the phase ends,
   * so a late in-flight frame can never re-light a row that already completed.
   */
  cancel(): void;
};

/** Rounded to whole megabytes — the granularity the caption actually shows. */
function toDisplayMegabytes(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / 1_000_000);
}

/** Rounded to whole percent — the granularity the bar actually shows. */
function toDisplayPercent(fraction: number | null): number | null {
  return fraction === null ? null : Math.round(fraction * 100);
}

/**
 * Rate-limit progress frames to what a person can actually perceive.
 *
 * Three gates, in order:
 * - MONOTONIC: a frame whose fraction is lower than the last emitted one is
 *   dropped. A retrying downloader that restarts its counter must not walk the
 *   bar backwards. This gate SUPPRESSES rather than clamps, so it is only safe
 *   because `resolveDownloadFraction` latches its denominator and can therefore
 *   never hand back a smaller fraction for a larger byte count. Anything that
 *   re-scaled a download mid-flight would freeze the row here until the raw
 *   fraction climbed back past the old high-water mark.
 * - THROTTLE: at most one frame per 400 ms, except a stage change or a
 *   fraction of 1, both of which pass immediately.
 * - VISIBLE CHANGE: a frame where neither the rounded percent nor the rounded
 *   megabyte figure moved renders identically to the last one, so it is dropped.
 *
 * `now` is injected so the whole thing is a pure state machine in tests.
 */
export function createSnapshotProgressThrottle(options: { now: () => number }): SnapshotProgressThrottle {
  const { now } = options;
  let cancelled = false;
  let lastEmittedAt: number | null = null;
  let lastFraction: number | null = null;
  let lastStage: SnapshotBootstrapStage | null = null;
  let lastPercent: number | null = null;
  let lastMegabytes: number | null = null;

  function record(frame: SnapshotBootstrapProgress, at: number | null): SnapshotBootstrapProgress {
    if (at !== null) lastEmittedAt = at;
    lastFraction = frame.fraction;
    lastStage = frame.stage;
    lastPercent = toDisplayPercent(frame.fraction);
    lastMegabytes = toDisplayMegabytes(frame.wireBytesDone);
    return frame;
  }

  return {
    offer(frame) {
      if (cancelled) return null;
      const at = now();
      const isStageChange = frame.stage !== lastStage;
      const isTerminal = frame.fraction === 1;

      if (!isStageChange && lastFraction !== null && frame.fraction !== null && frame.fraction < lastFraction) {
        return null;
      }
      if (
        !isStageChange &&
        !isTerminal &&
        lastEmittedAt !== null &&
        at - lastEmittedAt < DOWNLOAD_PROGRESS_THROTTLE_MS
      ) {
        return null;
      }
      if (
        !isStageChange &&
        !isTerminal &&
        toDisplayPercent(frame.fraction) === lastPercent &&
        toDisplayMegabytes(frame.wireBytesDone) === lastMegabytes
      ) {
        return null;
      }
      return record(frame, at);
    },
    flush(frame) {
      // `null` = do not open a rate-limit window; see the interface comment.
      return record(frame, null);
    },
    cancel() {
      cancelled = true;
    },
  };
}
