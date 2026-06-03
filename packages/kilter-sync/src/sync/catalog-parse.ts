import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';

import { fingerprintFromHolds, type HoldTuple } from './fingerprint';

const KILTER_BOARD = 'kilter' as const;

/**
 * Kilter Grips encodes a climb's holds in `climb_concat` as
 * `h{holeId}p{placementCode}` (comma-separated per frame). The legacy
 * Boardsesh catalog — synced from the pre-split Aurora backend — encodes the
 * same climb in `board_climbs.frames` as `p{placementId}r{roleCode}`, where
 * the integer is the **placement id**, not the hole id. Verified live
 * (2026-06-02): for a given layout, `board_placements(layout_id, hole_id)`
 * maps each Grips hole id onto exactly one Aurora placement id, and the role
 * codes are identical (12=start, 13=middle, 14=finish, 15=foot, 36–41 colour).
 *
 * Rather than re-implement the hold-state decode, we translate `climb_concat`
 * into the canonical Aurora frames string and route everything through the
 * existing `convertLitUpHoldsStringToMap`. That guarantees byte-identical
 * `board_climb_holds` and `hold_fingerprint` values to what the legacy
 * catalog already produced — so a Grips climb dedupes against its Aurora twin,
 * and `board_climbs.frames` stays in the one format the LED protocol and the
 * renderer understand. Proven 366/366 fingerprint parity in Phase 0.
 *
 * Returns `null` if any hole has no placement on this layout (a hold we can't
 * place) — the caller skips the climb and counts it as unmapped.
 */
export function gripsClimbConcatToFrames(climbConcat: string, holeToPlacement: Map<number, number>): string | null {
  const frames = climbConcat.split(',');
  const out: string[] = [];
  for (const frame of frames) {
    if (frame === '') {
      out.push('');
      continue;
    }
    const holdRe = /h(\d+)p(\d+)/g;
    let frameStr = '';
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = holdRe.exec(frame)) !== null) {
      consumed += match[0].length;
      const holeId = Number(match[1]);
      const placementId = holeToPlacement.get(holeId);
      if (placementId === undefined) return null;
      frameStr += `p${placementId}r${match[2]}`;
    }
    // Defend against an encoding we don't understand: if the regex didn't
    // consume the whole non-empty frame, bail rather than silently dropping
    // holds (which would corrupt the fingerprint).
    if (consumed !== frame.length) return null;
    out.push(frameStr);
  }
  return out.join(',');
}

/**
 * Flatten an Aurora-format frames string into fingerprint tuples — identical
 * to aurora-sync `shared-sync.ts` so board_climb_holds rows match exactly.
 */
export function framesToHolds(frames: string): HoldTuple[] {
  const byFrame = convertLitUpHoldsStringToMap(frames, KILTER_BOARD);
  return Object.entries(byFrame).flatMap(([frameNumber, holds]) =>
    Object.entries(holds).map(([holdId, { state }]) => ({
      holdId: Number(holdId),
      holdState: state,
      frameNumber: Number(frameNumber),
    })),
  );
}

/** Convenience: frames string → hold fingerprint. */
export function fingerprintFrames(frames: string): string {
  return fingerprintFromHolds(framesToHolds(frames));
}
