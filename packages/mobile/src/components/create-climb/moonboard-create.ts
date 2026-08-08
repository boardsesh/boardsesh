import { CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';
import { MOONBOARD_ANGLES, MOONBOARD_GRADES } from '@boardsesh/board-config';

export type MoonBoardAngle = (typeof MOONBOARD_ANGLES)[number];
export type MoonBoardMethodToken =
  | typeof CLIMB_CHARACTERISTICS.METHOD_FOOTLESS
  | typeof CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD
  | typeof CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD;

export function toMoonBoardAngle(angle: number): MoonBoardAngle {
  if (MOONBOARD_ANGLES.includes(angle as MoonBoardAngle)) return angle as MoonBoardAngle;
  return MOONBOARD_ANGLES[0];
}

/** Convert the public display label back to the MoonBoard create API grade token. */
export function moonBoardGradeValue(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const normalized = grade.trim().toLowerCase();
  return (
    MOONBOARD_GRADES.find(
      (candidate) => candidate.value.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized,
    )?.value ?? null
  );
}
