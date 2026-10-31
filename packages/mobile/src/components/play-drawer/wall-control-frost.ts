import type { WallControlModel } from './wall-control';

/** The full wall button's surface only; actions, labels and bulbs keep their model. */
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
  if (model.driving) return true;
  switch (model.tapAction) {
    case 'connect':
    case 'relight':
    case 'put_on_wall':
    case 'relay':
    case 'move_to_board':
    case 'disconnect':
    case 'stop_driving':
      return true;
    default:
      // Keep an accepted connection/write's surface while its controls are busy.
      return model.state !== 'crew' && (model.pending || model.writing);
  }
}

/** Undefined LED metadata stays LED-capable, as it does throughout board control. */
export function wallControlFrostHasLeds(
  active: { boardType: string | undefined; hasLeds?: boolean },
  target?: { boardType: string; hasLeds?: boolean } | null,
): boolean {
  const board = target ?? active;
  return board.boardType !== 'spray' && board.hasLeds !== false;
}
