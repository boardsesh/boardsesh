import { useMemo } from 'react';
import { useIsFocused } from 'expo-router';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { getLayoutDisplayName } from '@boardsesh/profile-stats';
import type { LayoutStats } from '@boardsesh/graphql/operations';
import { useUserProfileStats, useUserTickCountsByBoard } from '../../lib/graphql/hooks/use-you-data';
import { SPRAY_BOARD_NAME } from '../../lib/spray/spray-wall-registry';

/** One layout a climber has logged on, for the Logbook's Layout chips. */
export type LogbookLayoutOption = { layoutId: number; label: string };

/** One board a climber has logged on, with the layouts they used on it. */
export type LogbookBoardOption = {
  boardType: string;
  label: string;
  /** Most-climbed first. Empty for a spray wall, whose layouts are walls with no static name. */
  layouts: LogbookLayoutOption[];
};

type LayoutStatsRow = Pick<LayoutStats, 'boardType' | 'layoutId' | 'distinctClimbCount'>;

/**
 * The boards (and their layouts) a logbook can be scoped to: every board with
 * at least one tick, most-ticked first, then any board only the layout stats
 * know about. Pure, so the ordering is unit-tested without a query.
 */
export function buildLogbookBoardOptions(
  tickCountsByBoard: Readonly<Record<string, number>> | undefined,
  layoutStats: readonly LayoutStatsRow[] | undefined,
): LogbookBoardOption[] {
  const tickCountFor = (boardType: string) => tickCountsByBoard?.[boardType] ?? 0;
  const boardTypes = new Set<string>();
  for (const [boardType, count] of Object.entries(tickCountsByBoard ?? {})) {
    if (count > 0) boardTypes.add(boardType);
  }
  for (const row of layoutStats ?? []) {
    if (row.distinctClimbCount > 0) boardTypes.add(row.boardType);
  }

  return [...boardTypes]
    .map((boardType): LogbookBoardOption => {
      const layouts =
        boardType === SPRAY_BOARD_NAME
          ? []
          : (layoutStats ?? [])
              .filter(
                (row): row is LayoutStatsRow & { layoutId: number } =>
                  row.boardType === boardType && row.layoutId != null && row.distinctClimbCount > 0,
              )
              .sort((first, second) => second.distinctClimbCount - first.distinctClimbCount)
              .map((row) => ({ layoutId: row.layoutId, label: getLayoutDisplayName(boardType, row.layoutId) }));
      return { boardType, label: formatBoardDisplayName(boardType), layouts };
    })
    .sort(
      (first, second) =>
        tickCountFor(second.boardType) - tickCountFor(first.boardType) || first.label.localeCompare(second.label),
    );
}

/**
 * Board options for a climber's logbook. Both reads are already on the profile
 * screen (the board overview and the Progress tab), so this shares their cache
 * entries; the profile stats read pauses off screen like the rest of the You page.
 */
export function useLogbookBoardOptions(userId: string | undefined): LogbookBoardOption[] {
  const onScreen = useIsFocused();
  const { data: tickCountsByBoard } = useUserTickCountsByBoard(userId);
  const { data: profileStats } = useUserProfileStats(userId, { onScreen });
  const layoutStats = profileStats?.layoutStats;
  return useMemo(() => buildLogbookBoardOptions(tickCountsByBoard, layoutStats), [tickCountsByBoard, layoutStats]);
}
