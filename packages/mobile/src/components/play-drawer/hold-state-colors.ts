import {
  HOLD_STATE_MAP,
  STATE_TO_PRIMARY_CODE,
  type BoardRenderMode,
  type HoldStateInfo,
} from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
import { resolveHoldStateMarker, type HoldColorOverrides } from '../../lib/hold-color-overrides';

/**
 * A role's state on this board: its canonical code's, or the first code with
 * that name (MoonBoard's live-preview foot has no canonical code). Shared by
 * Active holds' markers and the wall button's glow, so both take one colour.
 */
export function roleStateInfo(boardName: BoardName, stateName: string): HoldStateInfo | undefined {
  const stateMap = HOLD_STATE_MAP[boardName];
  const primaryCode = (STATE_TO_PRIMARY_CODE[boardName] as Partial<Record<string, number>> | undefined)?.[stateName];
  return (
    (primaryCode === undefined ? undefined : stateMap?.[primaryCode]) ??
    Object.values(stateMap ?? {}).find((candidate) => candidate.name === stateName)
  );
}

/**
 * The colour the player draws each hold role in on this board: the board's
 * render mode (Aura or classic) and the climber's colour overrides, as Active
 * holds draws them. Keyed by state name (`STARTING`, `HAND`, ...).
 */
export function holdStateColors(
  boardName: BoardName,
  mode: BoardRenderMode,
  colorOverrides: HoldColorOverrides,
): ReadonlyMap<string, string> {
  const colours = new Map<string, string>();
  for (const stateInfo of Object.values(HOLD_STATE_MAP[boardName] ?? {})) {
    if (colours.has(stateInfo.name)) continue;
    const canonical = roleStateInfo(boardName, stateInfo.name) ?? stateInfo;
    colours.set(stateInfo.name, resolveHoldStateMarker(canonical, mode, colorOverrides, {}).color);
  }
  return colours;
}
