import { projectAuroraFramesToStoredRows } from '@boardsesh/board-constants/hold-states';

import { type HoldTuple } from './fingerprint';

const KILTER_BOARD = 'kilter' as const;

/**
 * One hold in a Kilter Grips `climb_concat`:
 *
 *   h{holeId} p{roleCode} [s{startFrame}] [e{endFrame}]
 *
 * `s`/`e` are 1-based and inclusive, and are omitted when they equal their
 * default (`s` → frame 1, `e` → the climb's last frame).
 */
const HOLD_TOKEN = /h(\d+)p(\d+)(?:s(\d+))?(?:e(\d+))?/g;

/**
 * Why a `climb_concat` could not be turned into a board_climbs row. Kept as a
 * runtime list too, so callers that take a reason from outside the process (the
 * CLI's --reason filter) can reject a typo instead of quietly matching nothing.
 */
export const KILTER_SKIP_REASONS = ['unplaceable_hole', 'unparsable_concat', 'frame_out_of_range'] as const;

export type KilterSkipReason = (typeof KILTER_SKIP_REASONS)[number];

export function isKilterSkipReason(value: string): value is KilterSkipReason {
  return (KILTER_SKIP_REASONS as readonly string[]).includes(value);
}

export type GripsDecodeResult =
  | { ok: true; frames: string; holds: HoldTuple[] }
  /** A hole in the concat has no placement on the resolved layout. */
  | { ok: false; reason: 'unplaceable_hole'; holeId: number }
  /** The token scan didn't consume the whole string — an encoding we don't know. */
  | { ok: false; reason: 'unparsable_concat'; offset: number }
  /** An s/e frame index falls outside 1..frameCount, or the range is inverted. */
  | { ok: false; reason: 'frame_out_of_range'; frame: number };

/**
 * Decode a Kilter Grips `climb_concat` into the canonical Aurora frames
 * string plus the per-frame hold tuples that back `board_climb_holds` and the
 * dedup fingerprint.
 *
 * ## The two encodings
 *
 * Grips encodes every hold as `h{holeId}p{roleCode}[s{start}][e{end}]`, where
 * the integer after `h` is the **hole id**. The Boardsesh catalog — synced
 * from the pre-split Aurora backend — stores the same climb in
 * `board_climbs.frames` as comma-separated per-frame deltas, where the
 * integer is the **placement id**: `p{placementId}r{roleCode}` lights a hold,
 * `x{placementId}` clears one, and a frame carrying a literal `"` prefix is a
 * delta on the previous frame.
 *
 * We emit `,"` on every frame after the first, so everything this decoder
 * produces is pure delta. That is a property of *our* encoder, not of the
 * format. The legacy Aurora catalog also contains unquoted later frames,
 * which are absolute snapshots that restate the whole lit set from scratch —
 * reading those as deltas was issue #3947. See `parseFramesSegments` in
 * `@boardsesh/board-constants/hold-states`.
 *
 * `board_placements(layout_id, hole_id)` maps each Grips hole id onto exactly
 * one Aurora placement id per layout, and the role codes are shared
 * (12=start, 13=middle, 14=finish, 15=foot). Translating into the Aurora
 * format rather than inventing a third one keeps `board_climbs.frames` in the
 * single format the LED protocol and the renderer already understand.
 *
 * ## The animated (multi-frame) form
 *
 * `s{start}`/`e{end}` are 1-based, inclusive, and omitted when they equal
 * their default — so a bare `h1180p12` on a 15-frame climb is lit for all 15
 * frames. A hold lit over frames `s..e` becomes a `p` token on frame `s` and,
 * when `e` is not the final frame, an `x` token on frame `e + 1`. The same
 * hole may appear twice with disjoint ranges (a hold that goes out and comes
 * back in a different role); when a placement is cleared and re-lit on the
 * same frame the `p` token wins and the redundant `x` is dropped, matching
 * what the Aurora catalog emits.
 *
 * Verified against 100,513 live catalog rows across two product layouts
 * (2026-07-25): every concat matches this grammar with no gaps, commas never
 * appear, `s`/`e` never appear on a single-frame climb, and no s/e index ever
 * falls outside 1..frameCount. Cross-checking the decode against the legacy
 * Aurora catalog's own `frames` strings for the climbs present in both gives
 * 141/141 semantic parity on multi-frame climbs (78 of them byte-identical;
 * the rest differ only where Aurora re-states a frame as an absolute snapshot
 * instead of a delta). See docs/kilter-sync.md.
 *
 * Multi-frame output sorts each frame's tokens by placement id, which is the
 * Aurora catalog's own convention and what makes those 78 byte-identical.
 * Single-frame output keeps the incoming order untouched, so the ~99% of
 * climbs that take that path decode exactly as they did before.
 */
export function decodeGripsClimbConcat(
  climbConcat: string,
  holeToPlacement: Map<number, number>,
  frameCount: number,
): GripsDecodeResult {
  // The wire always sends frameCount >= 1; clamp so a bad value can't produce
  // a zero-frame climb (which would silently drop every hold).
  const totalFrames = Number.isFinite(frameCount) && frameCount > 1 ? Math.floor(frameCount) : 1;

  // 0-based frame index → placement id → role code, for holds lit on that frame.
  const setsByFrame = new Map<number, Map<number, number>>();
  // 0-based frame index → placement ids cleared as that frame begins.
  const clearsByFrame = new Map<number, Set<number>>();

  const tokens = new RegExp(HOLD_TOKEN.source, 'g');
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(climbConcat)) !== null) {
    // A gap between tokens means an encoding we don't understand. Stop and let
    // the full-consumption check below reject it rather than dropping holds.
    if (match.index !== consumed) break;
    consumed = tokens.lastIndex;

    const holeId = Number(match[1]);
    const placementId = holeToPlacement.get(holeId);
    if (placementId === undefined) return { ok: false, reason: 'unplaceable_hole', holeId };

    // s/e are 1-based on the wire; frames are 0-based everywhere below.
    const startFrame = match[3] === undefined ? 1 : Number(match[3]);
    const endFrame = match[4] === undefined ? totalFrames : Number(match[4]);
    if (startFrame < 1 || startFrame > totalFrames) {
      return { ok: false, reason: 'frame_out_of_range', frame: startFrame };
    }
    if (endFrame < startFrame || endFrame > totalFrames) {
      return { ok: false, reason: 'frame_out_of_range', frame: endFrame };
    }

    const startIndex = startFrame - 1;
    let sets = setsByFrame.get(startIndex);
    if (!sets) {
      sets = new Map<number, number>();
      setsByFrame.set(startIndex, sets);
    }
    sets.set(placementId, Number(match[2]));

    if (endFrame < totalFrames) {
      // (endFrame - 1) + 1 — the frame after the last one this hold is lit on.
      const clearIndex = endFrame;
      let clears = clearsByFrame.get(clearIndex);
      if (!clears) {
        clears = new Set<number>();
        clearsByFrame.set(clearIndex, clears);
      }
      clears.add(placementId);
    }
  }

  // If the scan didn't consume the whole string, bail rather than silently
  // dropping holds — that would corrupt the fingerprint and light the wrong
  // holds on the wall.
  if (consumed !== climbConcat.length) return { ok: false, reason: 'unparsable_concat', offset: consumed };

  const frameStrings: string[] = [];
  for (let frameNumber = 0; frameNumber < totalFrames; frameNumber += 1) {
    const sets = setsByFrame.get(frameNumber);
    const clears = clearsByFrame.get(frameNumber);
    const entries: Array<{ placementId: number; roleCode: number | null }> = [];
    if (clears) {
      for (const placementId of clears) {
        // A placement re-lit on the same frame it would go out stays lit —
        // emitting the `x` too would be noise the Aurora catalog omits.
        if (!sets?.has(placementId)) entries.push({ placementId, roleCode: null });
      }
    }
    if (sets) {
      for (const [placementId, roleCode] of sets) entries.push({ placementId, roleCode });
    }
    if (totalFrames > 1) entries.sort((left, right) => left.placementId - right.placementId);

    let frameString = '';
    for (const entry of entries) {
      if (entry.roleCode === null) {
        frameString += `x${entry.placementId}`;
        continue;
      }
      frameString += `p${entry.placementId}r${entry.roleCode}`;
    }
    frameStrings.push(frameString);
  }

  // Aurora prefixes every frame after the first with a literal `"`.
  const frames = frameStrings.map((frameString, index) => (index === 0 ? frameString : `,"${frameString}`)).join('');
  // Use the same first-valid projection as every other active Aurora writer.
  // This matches the table's one-row-per-hold primary key, skips unknown-role
  // sentinels/nonpositive IDs, and keeps the dedup fingerprint identical to
  // the rows that are actually inserted.
  const holds: HoldTuple[] = projectAuroraFramesToStoredRows(frames, KILTER_BOARD).rows;
  return { ok: true, frames, holds };
}
