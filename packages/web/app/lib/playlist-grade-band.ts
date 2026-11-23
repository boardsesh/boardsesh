import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';

/** The two percentiles of `playlist_grade_summaries` a band is drawn from. */
export type PlaylistGradeBandSummary = { p10Difficulty: number; p90Difficulty: number };

/**
 * A playlist's V-grade band: its 10th to 90th percentile graded climb, on the
 * playlist board's scale (docs/data/playlist-grade-summaries.md). The share
 * card, the page's metadata and the page's subline all print this band.
 *
 * Null when the playlist has no summary (no graded climb yet), or when either
 * percentile is off the board's grade table.
 */
export function resolvePlaylistGradeBand(
  boardType: string,
  gradeSummary: PlaylistGradeBandSummary | null | undefined,
): { low: string; high: string } | null {
  if (!gradeSummary) return null;
  const grades = getBoulderGradesForBoard(boardType);
  const low = grades.find((grade) => grade.difficulty_id === gradeSummary.p10Difficulty);
  const high = grades.find((grade) => grade.difficulty_id === gradeSummary.p90Difficulty);
  return low && high ? { low: low.v_grade, high: high.v_grade } : null;
}
