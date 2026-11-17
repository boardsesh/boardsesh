'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { presentAuroraClimb } from '@boardsesh/board-presence';
import { BOARD_PRESENCE_CLIMB_GRADES } from '@boardsesh/graphql/operations';
import type { BoardPresenceClimb, BoardPresenceClimbGrade } from '@boardsesh/shared-schema';
import { executeGraphQL } from '@/app/lib/graphql/client';

type GradeResponse = { boardPresenceClimbGrades: BoardPresenceClimbGrade[] };

/** One anonymous, set-based grade read for the two rows a kiosk slot displays. */
export function useAuroraClimbGrades({
  boardId,
  boardUuid,
  angle,
  climb,
  lastLitClimb,
}: {
  boardId: number;
  boardUuid?: string | null;
  angle: number;
  climb: BoardPresenceClimb | null;
  lastLitClimb: BoardPresenceClimb | null;
}): { climb: BoardPresenceClimb | null; lastLitClimb: BoardPresenceClimb | null } {
  const climbUuids = useMemo(
    () =>
      [
        ...new Set([climb, lastLitClimb].flatMap((entry) => (entry?.source === 'aurora' ? [entry.climbUuid] : []))),
      ].sort(),
    [climb, lastLitClimb],
  );
  const { data: gradeResponse } = useQuery({
    queryKey: ['kioskAuroraClimbGrades', boardId, boardUuid ?? null, angle, climbUuids],
    enabled: climbUuids.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: () =>
      executeGraphQL<GradeResponse>(BOARD_PRESENCE_CLIMB_GRADES, { boardId, boardUuid, angle, climbUuids }),
  });
  const gradesByUuid = useMemo(
    () => new Map((gradeResponse?.boardPresenceClimbGrades ?? []).map((grade) => [grade.uuid, grade.difficulty])),
    [gradeResponse],
  );
  return useMemo(
    () => ({
      climb: climb ? presentAuroraClimb(climb, angle, gradesByUuid.get(climb.climbUuid) ?? null) : null,
      lastLitClimb: lastLitClimb
        ? presentAuroraClimb(lastLitClimb, angle, gradesByUuid.get(lastLitClimb.climbUuid) ?? null)
        : null,
    }),
    [climb, lastLitClimb, angle, gradesByUuid],
  );
}
