import { useMemo } from 'react';
import { accumulateFramesToMaps, accumulatedMapsToFrameStrings } from '@boardsesh/board-constants/hold-states';
import type { BoardName, Climb, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { DEFAULT_PACE_MS, MIN_PACE_MS } from './pace';

export type ClimbFrames = {
  /** One decoded `LitUpHoldsMap` per snapshot, in display order. */
  frames: LitUpHoldsMap[];
  /** One BLE-ready single-frame string per snapshot, in display order. */
  frameStrings: string[];
  /** Effective per-frame pace in milliseconds, clamped to `MIN_PACE_MS`. */
  paceMs: number;
  /**
   * Reported frame count (>=1). Since #3947 this agrees with `frames.length`
   * for every climb in the catalog — the reader no longer drops the
   * `"`-only hold frames it used to. The DB column stays the source of
   * truth in case a future climb disagrees.
   */
  count: number;
};

/**
 * Decode a climb's `frames` string into per-snapshot maps + BLE strings,
 * memoised by the underlying frames text so the playback engine doesn't
 * rebuild on every render.
 *
 * The Aurora frames string mixes two kinds of frame: a `"`-prefixed *delta*
 * (holds stay lit unless an `x<holdId>` token turns them off) and an
 * unquoted *absolute snapshot* that restates the whole lit set from
 * scratch. `accumulateFramesToMaps` folds both into one snapshot per frame,
 * then we re-emit each snapshot as a flat BLE-friendly string for the LED
 * driver. Single-frame climbs round-trip identically.
 */
export function useClimbFrames(
  climb: Pick<Climb, 'frames' | 'framesCount' | 'framesPace'> | null | undefined,
  boardName: BoardName,
): ClimbFrames {
  return useMemo(() => {
    const framesText = climb?.frames ?? '';
    const frames = accumulateFramesToMaps(framesText, boardName);
    const frameStrings = accumulatedMapsToFrameStrings(frames, boardName);
    const reportedPace = climb?.framesPace ?? 0;
    const paceMs = reportedPace > 0 ? Math.max(MIN_PACE_MS, reportedPace) : DEFAULT_PACE_MS;
    const count = Math.max(climb?.framesCount ?? frames.length, frames.length, 1);
    return { frames, frameStrings, paceMs, count };
  }, [climb?.frames, climb?.framesCount, climb?.framesPace, boardName]);
}
