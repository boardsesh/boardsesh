/**
 * The angle the player's angle pill shows, or `null` where it shows none: a
 * fixed-angle board, or no angle yet. The player's small row and the MiniPlayer
 * (#6940) both draw the pill on exactly this.
 */
export function resolvePlayerAngle({
  isAngleAdjustable,
  angle,
}: {
  isAngleAdjustable: boolean;
  angle: number | null | undefined;
}): number | null {
  return isAngleAdjustable && angle != null ? angle : null;
}
