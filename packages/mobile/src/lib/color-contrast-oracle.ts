/**
 * Colour-contrast and colour-vision-deficiency (CVD) math for hold-role palette
 * work (issue #2202) — pure TS, no React Native imports, so it can run in a
 * plain Vitest environment or a throwaway Node script.
 *
 * This is a typed port of the pure math from the #2202 spike's oracle
 * (`packages/mobile/scripts/spike/role-contrast.mjs` on `spike/board-rendering-dark-2202`),
 * which itself copies its sRGB curve and Viénot CVD matrices verbatim from
 * `build-figures.mjs`. Only the colour-space math is ported here — the spike's
 * board-palette lookups and CLI are tooling for that investigation, not something
 * a settings screen needs.
 *
 * Pipeline, in order:
 *   hex -> sRGB 8-bit -> linear (IEC 61966-2-1 curve)
 *   CVD: 3x3 matrix in LINEAR RGB (Viénot 1999; Machado, Oliveira & Fernandes 2009
 *        severity 1.0), clamped to [0, 1].
 *   WCAG 2.x relative luminance (0.2126 / 0.7152 / 0.0722) and (L1+0.05)/(L2+0.05).
 *   OkLab / OkLCh (Ottosson 2020) straight from linear RGB.
 *   CIE XYZ (sRGB D65 matrix) -> CIE Lab with the D65 white -> CIEDE2000
 *   (Sharma, Wu & Dalal 2005, kL = kC = kH = 1).
 *
 * Viénot 1999 defines protan and deutan only; there is no Viénot tritan. Machado
 * 2009 is peer-reviewed for all three and is what `cvd-palette-presets.ts` uses
 * for its tritan check (see that file's header for why "simple" tritan matrices
 * are not trustworthy).
 *
 * This is now the ONLY CVD maths in the app, and it applies the matrices in
 * LINEAR light because it exists to decide whether two colours are far enough
 * apart.
 *
 * A second, gamma-domain simulator used to live in `cvd-simulation.ts`, applying
 * the same Machado matrices for visual preview the way common web simulators do.
 * That preview is gone — a climber with a colour-vision deficiency does not need
 * to be shown what they already see — and two simulators that disagreed were a
 * standing trap for whoever reached for the wrong one.
 *
 * Calibrated against the spike oracle's own `selftest` numbers — see
 * `__tests__/color-contrast-oracle.test.ts`, which pins every WCAG, OkLab-L and
 * Viénot/Machado-protan/deutan ΔE00 figure the spike published, using the same
 * literal hexes (so this file needs no board-catalogue dependency to be tested).
 */

export type RgbTuple = readonly [number, number, number];
export type LabTuple = readonly [number, number, number];

/** The four CVD transforms this module can simulate. `null` = no simulation. */
/**
 * The kinds of colour vision the app reasons about. Lives here because this is
 * the module that still measures against them.
 */
export type CvdType = 'deuteranopia' | 'protanopia' | 'tritanopia';

export type CvdTransformKey =
  | 'vienot.protan'
  | 'vienot.deutan'
  | 'tritan.simple'
  | 'machado.protan'
  | 'machado.deutan'
  | 'machado.tritan';

type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

/** Viénot, Brettel & Mollon (1999), linear RGB. Verbatim from build-figures.mjs. */
const VIENOT_PROTAN: Matrix3 = [0.11238, 0.88762, 0, 0.11238, 0.88762, 0, 0.004, -0.004, 1];
const VIENOT_DEUTAN: Matrix3 = [0.29275, 0.70725, 0, 0.29275, 0.70725, 0, -0.02234, 0.02234, 1];

/**
 * NOT Viénot. The linear-RGB tritanopia matrix from the "simple" simulator sets
 * (Fidaner, Lin & Ozgüven 2005) that is usually shipped beside Viénot's two.
 * Carried for completeness; it is the least trustworthy of the three tritan
 * matrices here — prefer `machado.tritan` for a tritan decision (see the spike
 * oracle's header for the full story of why).
 */
const SIMPLE_TRITAN: Matrix3 = [0.95, 0.05, 0, 0, 0.43333, 0.56667, 0, 0.475, 0.525];

/**
 * Machado, Oliveira & Fernandes (2009), severity 1.0, linear RGB. Row-major, the
 * published table transposed into "output = M * input" form.
 */
const MACHADO_PROTAN: Matrix3 = [
  0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
];
const MACHADO_DEUTAN: Matrix3 = [
  0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
];
const MACHADO_TRITAN: Matrix3 = [
  1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
];

const CVD_MATRICES: Record<CvdTransformKey, Matrix3> = {
  'vienot.protan': VIENOT_PROTAN,
  'vienot.deutan': VIENOT_DEUTAN,
  'tritan.simple': SIMPLE_TRITAN,
  'machado.protan': MACHADO_PROTAN,
  'machado.deutan': MACHADO_DEUTAN,
  'machado.tritan': MACHADO_TRITAN,
};

const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;

export function parseHex(hex: string): RgbTuple {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function toHex([red, green, blue]: RgbTuple): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** sRGB 8-bit channel -> linear (IEC 61966-2-1). */
function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** Linear channel -> sRGB 8-bit, clamped + rounded. */
function channelToSrgb(value: number): number {
  const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

export function rgbToLinear([red, green, blue]: RgbTuple): RgbTuple {
  return [channelToLinear(red), channelToLinear(green), channelToLinear(blue)];
}

export function linearToRgb([red, green, blue]: RgbTuple): RgbTuple {
  return [channelToSrgb(red), channelToSrgb(green), channelToSrgb(blue)];
}

function applyMatrix(matrix: Matrix3, [red, green, blue]: RgbTuple): RgbTuple {
  return [
    matrix[0] * red + matrix[1] * green + matrix[2] * blue,
    matrix[3] * red + matrix[4] * green + matrix[5] * blue,
    matrix[6] * red + matrix[7] * green + matrix[8] * blue,
  ];
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Simulate one 8-bit sRGB colour under a CVD transform; returns clamped LINEAR
 * RGB floats — the form ΔE00 is computed from, so a saturated pair isn't
 * re-quantised to 8-bit before Lab (which the spike oracle found moves ΔE00 by
 * up to 0.3). `null` (no transform) returns the plain linear RGB.
 */
export function simulateCvdLinear(rgb: RgbTuple, transform: CvdTransformKey | null): RgbTuple {
  const linear = rgbToLinear(rgb);
  if (transform === null) return linear;
  const [red, green, blue] = applyMatrix(CVD_MATRICES[transform], linear);
  return [clampUnit(red), clampUnit(green), clampUnit(blue)];
}

/** The same simulation, re-encoded as an 8-bit sRGB pixel — what a preview draws. */
export function simulateCvd(rgb: RgbTuple, transform: CvdTransformKey | null): RgbTuple {
  return linearToRgb(simulateCvdLinear(rgb, transform));
}

/** WCAG 2.x relative luminance (0.2126R + 0.7152G + 0.0722B in linear light). */
export function relativeLuminance(rgb: RgbTuple): number {
  const [red, green, blue] = rgbToLinear(rgb);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2.x contrast ratio: (L_lighter + 0.05) / (L_darker + 0.05). */
export function contrastRatio(rgbA: RgbTuple, rgbB: RgbTuple): number {
  const lumA = relativeLuminance(rgbA);
  const lumB = relativeLuminance(rgbB);
  const [lighter, darker] = lumA >= lumB ? [lumA, lumB] : [lumB, lumA];
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatioHex(hexA: string, hexB: string): number {
  return contrastRatio(parseHex(hexA), parseHex(hexB));
}

/** OkLab (Ottosson 2020) straight from linear RGB. */
export function linearToOklab([red, green, blue]: RgbTuple): LabTuple {
  const longWave = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const mediumWave = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const shortWave = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * longWave + 0.793617785 * mediumWave - 0.0040720468 * shortWave,
    1.9779984951 * longWave - 2.428592205 * mediumWave + 0.4505937099 * shortWave,
    0.0259040371 * longWave + 0.7827717662 * mediumWave - 0.808675766 * shortWave,
  ];
}

export type Oklch = { L: number; C: number; h: number };

export function oklch(rgb: RgbTuple): Oklch {
  const [lightness, aAxis, bAxis] = linearToOklab(rgbToLinear(rgb));
  const chroma = Math.hypot(aAxis, bAxis);
  let hue = (Math.atan2(bAxis, aAxis) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { L: lightness, C: chroma, h: chroma < 1e-6 ? 0 : hue };
}

/** sRGB D65 matrix -> CIE XYZ -> CIE Lab (D65 white). */
export function linearToLab([red, green, blue]: RgbTuple): LabTuple {
  const d65White = [0.95047, 1.0, 1.08883];
  const xyz = [
    0.4124564 * red + 0.3575761 * green + 0.1804375 * blue,
    0.2126729 * red + 0.7151522 * green + 0.072175 * blue,
    0.0193339 * red + 0.119192 * green + 0.9503041 * blue,
  ];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = xyz.map((value, index) => f(value / d65White[index])) as [number, number, number];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const degrees = (radians: number) => (radians * 180) / Math.PI;
const radians = (deg: number) => (deg * Math.PI) / 180;

/** CIEDE2000, Sharma, Wu & Dalal (2005) reference formulation, kL = kC = kH = 1. */
export function ciede2000([lightness1, a1, b1]: LabTuple, [lightness2, a2, b2]: LabTuple): number {
  const chroma1 = Math.hypot(a1, b1);
  const chroma2 = Math.hypot(a2, b2);
  const meanChroma = (chroma1 + chroma2) / 2;
  const gFactor = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
  const a1Prime = (1 + gFactor) * a1;
  const a2Prime = (1 + gFactor) * a2;
  const chroma1Prime = Math.hypot(a1Prime, b1);
  const chroma2Prime = Math.hypot(a2Prime, b2);
  const hueOf = (aAxis: number, bAxis: number) => {
    if (aAxis === 0 && bAxis === 0) return 0;
    const hue = degrees(Math.atan2(bAxis, aAxis));
    return hue < 0 ? hue + 360 : hue;
  };
  const hue1Prime = hueOf(a1Prime, b1);
  const hue2Prime = hueOf(a2Prime, b2);

  const deltaLPrime = lightness2 - lightness1;
  const deltaChromaPrime = chroma2Prime - chroma1Prime;
  let deltaHuePrime: number;
  if (chroma1Prime * chroma2Prime === 0) deltaHuePrime = 0;
  else if (Math.abs(hue2Prime - hue1Prime) <= 180) deltaHuePrime = hue2Prime - hue1Prime;
  else if (hue2Prime - hue1Prime > 180) deltaHuePrime = hue2Prime - hue1Prime - 360;
  else deltaHuePrime = hue2Prime - hue1Prime + 360;
  const deltaHPrime = 2 * Math.sqrt(chroma1Prime * chroma2Prime) * Math.sin(radians(deltaHuePrime / 2));

  const meanLPrime = (lightness1 + lightness2) / 2;
  const meanChromaPrime = (chroma1Prime + chroma2Prime) / 2;
  let meanHuePrime: number;
  if (chroma1Prime * chroma2Prime === 0) meanHuePrime = hue1Prime + hue2Prime;
  else if (Math.abs(hue1Prime - hue2Prime) <= 180) meanHuePrime = (hue1Prime + hue2Prime) / 2;
  else if (hue1Prime + hue2Prime < 360) meanHuePrime = (hue1Prime + hue2Prime + 360) / 2;
  else meanHuePrime = (hue1Prime + hue2Prime - 360) / 2;

  const tFactor =
    1 -
    0.17 * Math.cos(radians(meanHuePrime - 30)) +
    0.24 * Math.cos(radians(2 * meanHuePrime)) +
    0.32 * Math.cos(radians(3 * meanHuePrime + 6)) -
    0.2 * Math.cos(radians(4 * meanHuePrime - 63));
  const deltaTheta = 30 * Math.exp(-(((meanHuePrime - 275) / 25) ** 2));
  const rotationC = 2 * Math.sqrt(meanChromaPrime ** 7 / (meanChromaPrime ** 7 + 25 ** 7));
  const scaleL = 1 + (0.015 * (meanLPrime - 50) ** 2) / Math.sqrt(20 + (meanLPrime - 50) ** 2);
  const scaleC = 1 + 0.045 * meanChromaPrime;
  const scaleH = 1 + 0.015 * meanChromaPrime * tFactor;
  const rotationT = -Math.sin(radians(2 * deltaTheta)) * rotationC;

  return Math.sqrt(
    (deltaLPrime / scaleL) ** 2 +
      (deltaChromaPrime / scaleC) ** 2 +
      (deltaHPrime / scaleH) ** 2 +
      rotationT * (deltaChromaPrime / scaleC) * (deltaHPrime / scaleH),
  );
}

/** ΔE00 between two 8-bit sRGB colours, optionally after a CVD transform. */
export function deltaE(rgbA: RgbTuple, rgbB: RgbTuple, transform: CvdTransformKey | null = null): number {
  return ciede2000(linearToLab(simulateCvdLinear(rgbA, transform)), linearToLab(simulateCvdLinear(rgbB, transform)));
}

/** ΔE00 between two hex colours, optionally after a CVD transform. */
export function deltaEHex(hexA: string, hexB: string, transform: CvdTransformKey | null = null): number {
  return deltaE(parseHex(hexA), parseHex(hexB), transform);
}
