import { LedControllerError, type LedPixel } from './types';

/** Validate before ownership or network changes, then detach caller-owned RGB tuples. */
export function snapshotLedPixels(indices: readonly number[], pixels?: readonly LedPixel[]): LedPixel[] | undefined {
  if (indices.some((index) => !Number.isSafeInteger(index) || index < 0)) {
    throw new LedControllerError('invalid-indices');
  }
  if (!pixels) return undefined;
  const selected = new Set(indices);
  const seen = new Set<number>();
  return pixels.map((pixel) => {
    if (
      !pixel ||
      !selected.has(pixel.index) ||
      seen.has(pixel.index) ||
      !Array.isArray(pixel.color) ||
      pixel.color.length !== 3 ||
      pixel.color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
    ) {
      throw new LedControllerError('invalid-indices');
    }
    seen.add(pixel.index);
    return { index: pixel.index, color: [...pixel.color] as [number, number, number] };
  });
}
