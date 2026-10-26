import type { RgbaImage } from './png-codec';

/**
 * Cuts the largest centred circle out of an image: pixels outside it turn
 * transparent, and the one-pixel rim is blended by how much of each pixel the
 * circle covers, so the edge stays smooth at 3x. Returns a new image.
 */
export function maskToCircle({ width, height, pixels }: RgbaImage): RgbaImage {
  const masked = new Uint8Array(pixels);
  const centreX = width / 2;
  const centreY = height / 2;
  const radius = Math.min(width, height) / 2;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const distance = Math.hypot(column + 0.5 - centreX, row + 0.5 - centreY);
      const coverage = Math.min(1, Math.max(0, radius - distance + 0.5));
      const alphaIndex = (row * width + column) * 4 + 3;
      masked[alphaIndex] = Math.round(masked[alphaIndex] * coverage);
    }
  }
  return { width, height, pixels: masked };
}
