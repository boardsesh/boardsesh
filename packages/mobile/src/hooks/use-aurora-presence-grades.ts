import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { presentAuroraClimb } from '@boardsesh/board-presence-react/presentation';
import { BOARD_PRESENCE_CLIMB_GRADES } from '@boardsesh/graphql/operations/board-presence';
import type { BoardConfig } from '../providers/drawer-host-provider';
import { useBoardPresenceControls } from '../providers/board-presence-provider';
import { getHttpClient } from '../lib/graphql/client';
import { auroraPresenceGradeUuids, type AuroraPresenceGrade } from '../lib/board-presence/aurora-presence-grades';

const EMPTY_GRADES: ReadonlyMap<string, AuroraPresenceGrade> = new Map();
export type AuroraPresenceReadScope = { boardId: number | null; boardUuid?: string | null };

/** One set-based public read for visible Aurora rows at this viewer's selected angle. */
export function useAuroraPresenceGrades(
  climbs: readonly BoardPresenceClimb[],
  boardConfig: BoardConfig | null,
  scope: AuroraPresenceReadScope,
): ReadonlyMap<string, AuroraPresenceGrade> {
  const climbUuids = useMemo(() => auroraPresenceGradeUuids(climbs), [climbs]);
  const { data: grades } = useQuery({
    queryKey: [
      'auroraPresenceGrades',
      scope.boardId,
      scope.boardUuid ?? null,
      boardConfig?.boardName,
      boardConfig?.layoutId,
      boardConfig?.sizeId,
      boardConfig?.setIds,
      boardConfig?.angle,
      climbUuids,
    ],
    enabled: scope.boardId !== null && boardConfig !== null && climbUuids.length > 0,
    queryFn: async () => {
      if (scope.boardId === null || !boardConfig || !climbUuids.length) return [];
      const response = await getHttpClient().request<{ boardPresenceClimbGrades: AuroraPresenceGrade[] }>(
        BOARD_PRESENCE_CLIMB_GRADES,
        { boardId: scope.boardId, boardUuid: scope.boardUuid ?? null, angle: boardConfig.angle, climbUuids },
      );
      return response.boardPresenceClimbGrades;
    },
    staleTime: 60_000,
    retry: false,
  });
  // The server retains the requested UUID, including catalog aliases.
  return useMemo(() => (grades ? new Map(grades.map((climb) => [climb.uuid, climb])) : EMPTY_GRADES), [grades]);
}

/** The same current-angle projection on compact, kiosk and tablet wall surfaces. */
export function useAuroraPresenceClimb(climb: BoardPresenceClimb | null, boardConfig: BoardConfig | null) {
  const { boardId, boardUuid } = useBoardPresenceControls();
  const climbs = useMemo(() => (climb ? [climb] : []), [climb]);
  const grades = useAuroraPresenceGrades(climbs, boardConfig, { boardId, boardUuid });
  const grade = climb?.source === 'aurora' ? grades.get(climb.climbUuid) : undefined;
  const projected = useMemo(
    () => (climb && boardConfig ? presentAuroraClimb(climb, boardConfig.angle, grade?.difficulty ?? null) : climb),
    [climb, boardConfig, grade],
  );
  return { climb: projected, grade };
}
