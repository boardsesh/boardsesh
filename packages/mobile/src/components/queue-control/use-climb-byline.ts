import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/queue';
import type { BoardName } from '@boardsesh/shared-schema';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { formatQuality, formatSends } from '../../lib/format-climb-stats';

/**
 * The fact after a climb's grade: its sends, or its rating when nobody has sent
 * it; null otherwise, and while `statsEnabled` is off (an unknown angle, or a
 * surface that hides it), which also skips the stats read. The same live counts
 * the list rows read, keyed on the climb's own board.
 */
export function useClimbStatsDetail(
  climb: Climb,
  boardConfig: BoardConfig | null,
  { statsEnabled = true }: { statsEnabled?: boolean } = {},
): string | null {
  const { t } = useTranslation('climbs');
  const stats = useEffectiveClimbStats(
    (climb.boardType ?? boardConfig?.boardName ?? '') as BoardName,
    climb.layoutId ?? boardConfig?.layoutId ?? 0,
    climb.uuid,
    climb.angle,
    { ascensionistCount: climb.ascensionist_count, qualityAverage: climb.quality_average },
    { enabled: statsEnabled && boardConfig !== null },
  );
  if (!statsEnabled) return null;
  const isDraft = climb.is_draft === true;
  const sends = !isDraft && stats.ascensionistCount > 0 ? formatSends(stats.ascensionistCount, t) : null;
  const rating =
    stats.qualityAverage != null && parseFloat(stats.qualityAverage) > 0
      ? `${formatQuality(stats.qualityAverage)}★`
      : null;
  return sends ?? rating;
}

/**
 * The line under a climb's name on the accessory platter: grade · sends, or
 * grade · rating when nobody has sent it; the grade alone otherwise.
 * `statsEnabled: false` skips the stats read and shows the grade alone.
 */
export function useClimbByline(
  climb: Climb,
  boardConfig: BoardConfig | null,
  grade: string | null,
  { statsEnabled = true }: { statsEnabled?: boolean } = {},
): string | null {
  const detail = useClimbStatsDetail(climb, boardConfig, { statsEnabled });
  const parts = [grade, detail].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' · ') : null;
}
