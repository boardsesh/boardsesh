import { buildWhiteKeyMask, type WhiteKeyMask } from './white-key';

/** Quantum's corner ground measures 33/255; 60 clears its antialiased dark rim. */
export const GROUND_CEILING = 60;

/** Recover light holds on dark ground, preserving enclosed dark LED apertures.
 * Inverting RGB lets both keys share the corner-connected flood and edge erode.
 * Only corner-connected dark pixels disappear; interior dots remain substance.
 */
export function buildDarkKeyMask(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  { groundCeiling = GROUND_CEILING, erodePx = 1 }: { groundCeiling?: number; erodePx?: number } = {},
): WhiteKeyMask {
  if (channels !== 3 && channels !== 4) throw new Error(`buildDarkKeyMask expects 3 or 4 channels, got ${channels}`);
  const inverted = Uint8Array.from(pixels, (channel, index) => (index % channels === 3 ? channel : 255 - channel));
  return buildWhiteKeyMask(inverted, width, height, channels, { groundFloor: 255 - groundCeiling, erodePx });
}
