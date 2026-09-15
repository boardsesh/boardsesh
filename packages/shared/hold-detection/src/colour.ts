import type { Box, RgbaImage } from './types';

/**
 * How many hue bins the descriptor carries. Eight is coarse on purpose: the same
 * hold photographed under a garage bulb and under daylight has to land in the
 * same bin, and a reset comparison that splits hairs on hue would call every
 * hold on the wall a different hold.
 */
export const HUE_BINS = 8;

/**
 * A hold's colour, as the flat vector `@boardsesh/spray-wall-geometry`'s matcher
 * compares: `[L, a, b, ...eight hue weights]`.
 *
 * Lab because it is the space where "how different do these two look" is roughly
 * a distance, and a hue histogram alongside it because a two-tone hold (a black
 * jug with a yellow stripe) has a mean colour nobody would recognise.
 */
export type ColourDescriptor = number[];

/** The descriptor's length, so a caller can validate one it read back from a row. */
export const COLOUR_DESCRIPTOR_LENGTH = 3 + HUE_BINS;

function toLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** sRGB to CIE Lab, D65. */
export function rgbToLab(red: number, green: number, blue: number): [number, number, number] {
  const linearRed = toLinear(red);
  const linearGreen = toLinear(green);
  const linearBlue = toLinear(blue);

  const x = (0.4124 * linearRed + 0.3576 * linearGreen + 0.1805 * linearBlue) / 0.95047;
  const y = 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue;
  const z = (0.0193 * linearRed + 0.1192 * linearGreen + 0.9505 * linearBlue) / 1.08883;

  const f = (value: number) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Hue in `[0, 1)` and saturation in `[0, 1]`, the two the histogram needs. */
function hueAndSaturation(red: number, green: number, blue: number): [number, number] {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const span = max - min;
  if (span === 0 || max === 0) return [0, 0];
  let hue: number;
  if (max === red) hue = ((green - blue) / span + 6) % 6;
  else if (max === green) hue = (blue - red) / span + 2;
  else hue = (red - green) / span + 4;
  return [hue / 6, span / max];
}

/**
 * Describe the colour inside a detection box.
 *
 * The box, not a mask, because the detector does not produce one (see
 * `toHoldCandidates`). A box around a hold is mostly hold, and the histogram is
 * weighted by saturation, so the grey wall showing at the corners contributes
 * almost nothing to the hue half and only dilutes the Lab mean.
 *
 * Returns `undefined` for a box with no pixels in the photo, so a caller can tell
 * "no colour" from "grey" and the matcher can drop the colour term for that pair
 * rather than compare against a fabricated zero.
 */
export function describeColour(image: RgbaImage, box: Box): ColourDescriptor | undefined {
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(image.width, Math.ceil(box[2]));
  const y1 = Math.min(image.height, Math.ceil(box[3]));
  if (x1 <= x0 || y1 <= y0) return undefined;

  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  let pixels = 0;
  const hues = Array.from({ length: HUE_BINS }, () => 0);
  let hueWeight = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * image.width + x) * 4;
      const red = image.rgba[offset];
      const green = image.rgba[offset + 1];
      const blue = image.rgba[offset + 2];
      const [lightness, greenRed, blueYellow] = rgbToLab(red, green, blue);
      sumL += lightness;
      sumA += greenRed;
      sumB += blueYellow;
      pixels += 1;

      const [hue, saturation] = hueAndSaturation(red, green, blue);
      const bin = Math.min(HUE_BINS - 1, Math.floor(hue * HUE_BINS));
      hues[bin] += saturation;
      hueWeight += saturation;
    }
  }

  if (pixels === 0) return undefined;
  // An entirely grey hold has no hue to report; leaving the bins at zero says
  // that honestly, where normalising by zero would not.
  const normaliser = hueWeight > 0 ? hueWeight : 1;
  return [sumL / pixels, sumA / pixels, sumB / pixels, ...hues.map((weight) => weight / normaliser)];
}
