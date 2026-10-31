import type { WallControlModel } from './wall-control';

/** Frost marks confirmed physical driving; actions, labels and bulbs keep their model. */
export function wallControlUsesFrost(
  model: Pick<WallControlModel, 'state' | 'labelKey' | 'tapAction' | 'driving' | 'pending' | 'writing'>,
): boolean {
  if (
    model.state === null ||
    model.state === 'take_wall' ||
    model.state === 'release_wall' ||
    model.labelKey === 'setActive'
  )
    return false;
  return model.driving;
}

/** Undefined LED metadata stays LED-capable, as it does throughout board control. */
export function wallControlFrostHasLeds(
  active: { boardType: string | undefined; hasLeds?: boolean },
  target?: { boardType: string; hasLeds?: boolean } | null,
): boolean {
  const board = target ?? active;
  return board.boardType !== 'spray' && board.hasLeds !== false;
}
