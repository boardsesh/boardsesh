/**
 * Whether a board supports mirroring climbs.
 * Tension boards support mirroring (except layout 11), Decoy boards support it,
 * and Woods supports it via its own row-reflection geometry
 * (`getWoodsMirroredHoldLocation`/`mirroredHoldId`). MoonBoard does not.
 */
export function boardSupportsMirroring(boardName: string, layoutId: number): boolean {
  return (boardName === 'tension' && layoutId !== 11) || boardName === 'decoy' || boardName === 'woods';
}
