import type { WallControlModel } from './wall-control';

/**
 * Frost marks confirmed physical driving; actions, labels and bulbs keep their
 * model. Never Put on board's keep-lighting window (2.7): it has its own bar
 * and clock, so the frost keeps meaning an open-ended drive only.
 */
export function wallControlUsesFrost(
  model: Pick<WallControlModel, 'state' | 'labelKey' | 'driving'> & Partial<Pick<WallControlModel, 'lightWindow'>>,
): boolean {
  if (
    model.lightWindow === true ||
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
