import type { BoardBleCapabilities, BoardLight, Rgb, RolePalette } from './types';
import { BleError } from './session';

function snapshotRgb(color: Rgb): Rgb {
  if (
    !Array.isArray(color) ||
    color.length !== 3 ||
    [0, 1, 2].some((index) => !Number.isInteger(color[index]) || color[index] < 0 || color[index] > 255)
  ) {
    throw new BleError('invalid-input', 'RGB channels must be integers from 0 to 255');
  }
  return [color[0], color[1], color[2]];
}

export function resolveRgb(light: BoardLight, palette?: RolePalette): Rgb {
  const color = light.color ?? (light.role ? palette?.[light.role] : undefined);
  if (!color) throw new BleError('unsupported', 'Supply a palette for this role');
  return snapshotRgb(color);
}

/** Snapshot at submission, before queueing. Empty show is never an implicit clear. */
export function snapshotLights(
  lights: readonly BoardLight[],
  capabilities: BoardBleCapabilities,
  maxIndex = 65535,
  palette?: RolePalette,
): BoardLight[] {
  if (!Array.isArray(lights) || lights.length === 0)
    throw new BleError('invalid-input', 'Use clear() for an empty board');
  return Array.from(lights, (light) => {
    if (!light || !Number.isSafeInteger(light.index) || light.index < 0 || light.index > maxIndex) {
      throw new BleError('invalid-input', 'LED index is outside this controller range');
    }
    if (light.color !== undefined) {
      if (light.role !== undefined) throw new BleError('invalid-input', 'Specify a color or a role, not both');
      if (!capabilities.rgb) throw new BleError('unsupported', 'This controller accepts roles, not RGB');
      return { index: light.index, color: snapshotRgb(light.color) };
    }
    if (!capabilities.roles.includes(light.role)) throw new BleError('unsupported', 'Unsupported hold role');
    return capabilities.rgb && palette
      ? { index: light.index, color: resolveRgb(light, palette) }
      : { index: light.index, role: light.role };
  });
}
