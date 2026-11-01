import type { BoardHold } from '../board-renderer/types';
import type { WallGlowInput } from './use-wall-glow';
import type { GlowHold } from './wall-glow';

type WallGlowSource = {
  parsedHolds: readonly Pick<BoardHold, 'id' | 'cx' | 'cy' | 'color' | 'role'>[];
  roleColors: ReadonlyMap<string, string>;
  boardWidth: number;
  boardHeight: number;
  climbUuid: string | null;
  frames: string;
  mirrored: boolean;
};

/** The same lit-hold positions and role palette for the wall button and header. */
export function buildWallGlowInput({
  parsedHolds,
  roleColors,
  boardWidth,
  boardHeight,
  climbUuid,
  frames,
  mirrored,
}: WallGlowSource): WallGlowInput | null {
  if (parsedHolds.length === 0 || !frames || !(boardWidth > 0) || !(boardHeight > 0)) return null;
  const seen = new Set<number>();
  const holds: GlowHold[] = [];
  for (const hold of parsedHolds) {
    if (seen.has(hold.id)) continue;
    seen.add(hold.id);
    holds.push({ x: hold.cx, y: hold.cy, color: roleColors.get(hold.role) ?? hold.color });
  }
  return {
    key: `${climbUuid ?? ''}|${frames}|${mirrored ? 'm' : ''}|${[...roleColors.values()].join()}`,
    holds,
    boardWidth,
    boardHeight,
  };
}
