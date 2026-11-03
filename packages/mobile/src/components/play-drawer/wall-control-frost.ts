import type { WallControlModel } from './wall-control';
import { boardHasLights, type BoardLightingSource } from '../../lib/boards/board-lighting';

/**
 * Frost marks confirmed physical driving; actions, labels and bulbs keep their
 * model. Put on board's timed drive (2.7) is driving too: the same frost, which
 * shrinks as its time runs out (`WallWindowFrost`).
 */
export function wallControlUsesFrost(model: Pick<WallControlModel, 'state' | 'labelKey' | 'driving'>): boolean {
  if (
    model.state === null ||
    model.state === 'take_wall' ||
    model.state === 'release_wall' ||
    model.labelKey === 'setActive'
  )
    return false;
  return model.driving;
}

/**
 * Undefined LED metadata stays LED-capable, as it does throughout board control.
 * A wall device lights the wall too (`boardHasLights`).
 */
export function wallControlFrostHasLeds(active: BoardLightingSource, target?: BoardLightingSource | null): boolean {
  return boardHasLights(target ?? active);
}
