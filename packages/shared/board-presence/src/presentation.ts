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

/** Resolve the viewer's orientation at an explicit action, without changing cached catalog data. */
export function withAuroraActionOrientation<Climb extends { mirrored?: boolean | null }>(
  climb: Climb,
  source: BoardPresenceClimb['source'],
  currentMirrored: boolean,
): Climb {
  return source === 'aurora' ? { ...climb, mirrored: currentMirrored } : climb;
}
