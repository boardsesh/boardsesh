import { useCallback } from 'react';
import { formatGradeBand } from '@boardsesh/play-view';
import type { PlaylistGradeSummary } from '@boardsesh/graphql/operations/playlists';
import { useGradeFormat } from './use-grade-format';

/**
 * A stable formatter for a playlist card's grade band ("V3–V5"): the 10th to
 * 90th percentile of the playlist's graded climbs, in the climber's grade
 * format, on the playlist board's scale. Null when the playlist has no graded
 * climb. Call once per list and run the callback per row.
 */
export function usePlaylistGradeBand(): (
  gradeSummary: PlaylistGradeSummary | null | undefined,
  boardType: string,
) => string | null {
  const { gradeFormat } = useGradeFormat();
  return useCallback(
    (gradeSummary, boardType) =>
      gradeSummary
        ? formatGradeBand(gradeSummary.p10Difficulty, gradeSummary.p90Difficulty, gradeFormat, boardType)
        : null,
    [gradeFormat],
  );
}
