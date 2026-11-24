import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { BoardseshGradeFields } from '../boardsesh-grade-display';

export const AURORA_PRESENCE_GRADE_BATCH_LIMIT = 50;
export type AuroraPresenceGrade = BoardseshGradeFields & { uuid: string; difficulty: string | null };

/** Bound public climb reads to the visible wall rows; UUIDs remain variables, never query text. */
export function auroraPresenceGradeUuids(climbs: readonly BoardPresenceClimb[]): string[] {
  return [...new Set(climbs.filter((climb) => climb.source === 'aurora').map((climb) => climb.climbUuid))]
    .sort()
    .slice(0, AURORA_PRESENCE_GRADE_BATCH_LIMIT);
}
