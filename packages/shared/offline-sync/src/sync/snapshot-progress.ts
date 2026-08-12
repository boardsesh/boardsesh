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
 * Pick the denominator for a download's byte counter and turn it into a
 * fraction.
 *
 * PRECEDENCE, and why it is this way round:
 *
 * 1. The platform's own `reportedTotalBytes`, when > 0. On iOS the total and the
 *    counter arrive in the SAME delegate callback (`totalBytesWritten` /
 *    `totalBytesExpectedToWrite`), so their ratio is self-consistent whatever
 *    scale Foundation picked. Substituting our own denominator there would
 *    manufacture a mismatch. For identity artifacts every candidate agrees
 *    anyway.
 * 2. `entry.uncompressedBytes` for a gzip entry. This is Android: OkHttp gunzips
 *    transparently, so the write loop counts DECODED bytes while
 *    `body.contentLength()` is -1. The decoded size is the proven matching scale
 *    there. Absent on artifacts exported before the field shipped, which is why
 *    it is a fallback and not a requirement.
 * 3. `entry.bytes` for an identity entry — wire == decoded, so it is exact.
 * 4. Null: indeterminate. Show the byte counter, no bar.
 *
 * TERMINAL FRAME. expo-file-system's JS wrapper fires a synthetic final frame
 * `{ bytesWritten: fileSize, totalBytes: fileSize }` carrying the DECODED
 * on-disk size, so the last frame legitimately changes scale. Equal values mean
 * "complete", never "here is a data point" — treat it as fraction 1 and do not
 * let it re-anchor anything.
 *
 * OVERSHOOT. If the counter runs more than 2% past the denominator, our scales
 * disagree: re-anchor to `uncompressedBytes` when that is larger (exactly the
 * iOS decoded-counter/compressed-total case), so the bar keeps moving forward
 * instead of freezing at 100%. With no larger candidate, latch indeterminate for
 * the rest of the download rather than lie.
 *
 * UNDERSHOOT is not a hazard by construction: the only way to park a bar at ~38%
 * is to divide platform bytes by a denominator on a LARGER scale, and rule 1
 * removes that case (a self-paired total can never exceed its own counter's
 * scale) while rule 2's fallback is the scale Android provably writes.
 */
export function resolveDownloadFraction(input: DownloadFractionInput): DownloadFractionResult {
  const { entry, bytesWritten, reportedTotalBytes, anchor } = input;

  // The synthetic terminal frame. Recognised before anything else so it can
  // neither re-anchor nor trip the overshoot detector.
  if (reportedTotalBytes !== null && reportedTotalBytes > 0 && bytesWritten === reportedTotalBytes) {
    return { fraction: 1, anchor };
  }

  if (anchor.latchedIndeterminate) {
    return { fraction: null, anchor };
  }

  let denominator = anchor.denominator;
  if (denominator === null) {
    if (reportedTotalBytes !== null && reportedTotalBytes > 0) {
      denominator = reportedTotalBytes;
    } else if (entry.contentEncoding === 'gzip' && typeof entry.uncompressedBytes === 'number') {
      denominator = entry.uncompressedBytes;
    } else if (entry.contentEncoding === 'identity') {
      denominator = entry.bytes;
    }
  }

  if (denominator === null || denominator <= 0) {
    return { fraction: null, anchor: { denominator: null, latchedIndeterminate: false } };
  }

  if (bytesWritten > denominator * OVERSHOOT_TOLERANCE) {
    const decodedSize = entry.uncompressedBytes;
    if (typeof decodedSize === 'number' && decodedSize > denominator) {
      // The counter is on the decoded scale and our total was compressed.
      // Re-anchor rather than pin the bar at 100% for the rest of the download.
      const reanchored: DownloadFractionAnchor = { denominator: decodedSize, latchedIndeterminate: false };
      return {
        fraction: Math.min(bytesWritten / decodedSize, PRE_TERMINAL_FRACTION_CAP),
        anchor: reanchored,
      };
    }
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
 *   bar backwards.
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
