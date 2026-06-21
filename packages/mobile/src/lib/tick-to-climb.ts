import type { Climb } from '@boardsesh/shared-schema';

/**
 * The subset of fields shared by `SessionDetailTick` and
 * `SessionFeedTickHighlight` that `tickToClimb` needs. Both schema types satisfy
 * this structurally, so the one mapper serves the session-detail list, the home
 * feed's hardest-send hero, and the in-session history.
 */
export type TickLike = {
  climbUuid: string;
  climbName?: string | null;
  frames?: string | null;
  angle: number;
  difficultyName?: string | null;
  quality?: number | null;
  setterUsername?: string | null;
  isBenchmark: boolean;
  isMirror: boolean;
  isNoMatch: boolean;
  boardType: string;
  layoutId?: number | null;
};

/**
 * Build a play-drawer-ready `Climb` from a session tick highlight. Returns
 * `null` when the tick has no `frames` (nothing to render on the board) — the
 * caller then falls back to the climb route, which loads the full climb by uuid.
 * Extracted verbatim from InSessionView so the home feed and session screens
 * share one mapping instead of three drifting copies.
 */
export function tickToClimb(tick: TickLike): Climb | null {
  if (!tick.frames) return null;
  return {
    uuid: tick.climbUuid,
    name: tick.climbName ?? tick.climbUuid,
    frames: tick.frames,
    angle: tick.angle,
    ascensionist_count: 0,
    difficulty: tick.difficultyName ?? '',
    difficulty_error: '',
    quality_average: tick.quality != null ? String(tick.quality) : '0',
    setter_username: tick.setterUsername ?? '',
    stars: tick.quality ?? 0,
    benchmark_difficulty: tick.isBenchmark ? (tick.difficultyName ?? null) : null,
    mirrored: tick.isMirror,
    is_no_match: tick.isNoMatch,
    boardType: tick.boardType,
    layoutId: tick.layoutId,
  };
}
