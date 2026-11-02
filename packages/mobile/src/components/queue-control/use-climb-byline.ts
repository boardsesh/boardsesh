import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/queue';
import type { BoardName } from '@boardsesh/shared-schema';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { formatQuality, formatSends } from '../../lib/format-climb-stats';

/**
 * The line under a climb's name on the accessory platter and the Climbs header
 * capsules: grade · sends, or grade · rating when nobody has sent it; the grade
 * alone otherwise. `statsEnabled: false` skips the stats read and shows the
 * grade alone, for a climb whose angle is unknown or a surface that hides it.
 */
export function useClimbByline(
  climb: Climb,
  boardConfig: BoardConfig | null,
  grade: string | null,
  { statsEnabled = true }: { statsEnabled?: boolean } = {},
): string | null {
  const { t } = useTranslation('climbs');
  // The same live counts the list rows read, keyed on the climb's own board.
  const stats = useEffectiveClimbStats(
    (climb.boardType ?? boardConfig?.boardName ?? '') as BoardName,
    climb.layoutId ?? boardConfig?.layoutId ?? 0,
    climb.uuid,
    climb.angle,
    { ascensionistCount: climb.ascensionist_count, qualityAverage: climb.quality_average },
    { enabled: statsEnabled && boardConfig !== null },
  );
  if (!statsEnabled) return grade;
  const isDraft = climb.is_draft === true;
  const sends = !isDraft && stats.ascensionistCount > 0 ? formatSends(stats.ascensionistCount, t) : null;
  const rating =
    stats.qualityAverage != null && parseFloat(stats.qualityAverage) > 0
      ? `${formatQuality(stats.qualityAverage)}★`
      : null;
  const parts = [grade, sends ?? rating].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' · ') : null;
}
