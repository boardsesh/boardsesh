import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

/** Aurora display records omit angle; each viewer supplies their own selected angle. */
export function resolveBoardPresenceAngle(climb: BoardPresenceClimb, selectedAngle: number): number {
  return climb.source === 'aurora' ? selectedAngle : (climb.angle ?? selectedAngle);
}

/** Presentation only: never persist the viewer's settings into the shared occurrence. */
export function presentAuroraClimb(
  climb: BoardPresenceClimb,
  selectedAngle: number,
  selectedGrade: string | null,
): BoardPresenceClimb {
  return climb.source === 'aurora' ? { ...climb, angle: selectedAngle, grade: selectedGrade } : climb;
}

/** Use only the displayed climb's own orientation when creating an action from its catalog entry. */
export function withAuroraActionOrientation<Climb extends { mirrored?: boolean | null }>(
  climb: Climb,
  occurrence: Pick<BoardPresenceClimb, 'source' | 'climbUuid' | 'mirrored'>,
  getClimbMirror?: (climbUuid: string) => boolean | undefined,
): Climb {
  return occurrence.source === 'aurora'
    ? { ...climb, mirrored: occurrence.mirrored ?? getClimbMirror?.(occurrence.climbUuid) ?? false }
    : climb;
}
