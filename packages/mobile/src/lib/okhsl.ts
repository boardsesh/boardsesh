// OKHSL ↔ sRGB conversion, ported from Björn Ottosson's reference implementation
// (https://bottosson.github.io/posts/colorpicker/ and the accompanying gist).
//
// OKHSL is a perceptual HSL-like space built on Oklab. Its key properties for
// the accessibility hold picker:
//   - Lightness (l) is perceptually uniform AND independent of hue/saturation,
//     so a colour-blind user can dial in a target lightness and trust it.
//   - For any h ∈ [0,360), s ∈ [0,1], l ∈ [0,1], okhslToRgb returns an in-gamut
//     sRGB colour — no clipping needed.
//
// This module is intentionally self-contained (no React Native imports) so it
// runs in plain vitest. Hue is exposed in degrees [0,360); s and l in [0,1].

export type Okhsl = {
  /** Hue in degrees, [0, 360). */
  h: number;
  /** Saturation, [0, 1]. */
  s: number;
  /** Lightness, [0, 1]. */
  l: number;
};

type Rgb = { red: number; green: number; blue: number };
type Triplet = [number, number, number];

export function srgbTransferFunction(a: number): number {
  return a >= 0.0031308 ? 1.055 * Math.pow(a, 1 / 2.4) - 0.055 : 12.92 * a;
}

export function srgbTransferFunctionInverse(a: number): number {
  return a > 0.04045 ? Math.pow((a + 0.055) / 1.055, 2.4) : a / 12.92;
}

function linearSrgbToOklab(r: number, g: number, b: number): Triplet {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  return [
    0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  ];
}

function oklabToLinearSrgb(bigL: number, a: number, b: number): Triplet {
  const lRoot = bigL + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = bigL - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = bigL - 0.0894841775 * a - 1.291485548 * b;

  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function toe(x: number): number {
  const k1 = 0.206;
  const k2 = 0.03;
  const k3 = (1 + k1) / (1 + k2);
  return 0.5 * (k3 * x - k1 + Math.sqrt((k3 * x - k1) * (k3 * x - k1) + 4 * k2 * k3 * x));
}

function toeInverse(x: number): number {
  const k1 = 0.206;
  const k2 = 0.03;
  const k3 = (1 + k1) / (1 + k2);
  return (x * x + k1 * x) / (k3 * (x + k2));
}

function toST(cusp: Triplet | [number, number]): [number, number] {
  const [bigL, c] = cusp;
  return [c / bigL, c / (1 - bigL)];
}

// Maximum saturation (S = C/L) for a given hue that still fits in sRGB.
// a and b must be normalised so a^2 + b^2 == 1.
function computeMaxSaturation(a: number, b: number): number {
  let k0: number;
  let k1: number;
  let k2: number;
  let k3: number;
  let k4: number;
  let wl: number;
  let wm: number;
  let ws: number;

  if (-1.88170328 * a - 0.80936493 * b > 1) {
    // Red component
    k0 = 1.19086277;
    k1 = 1.76576728;
    k2 = 0.59662641;
    k3 = 0.75515197;
    k4 = 0.56771245;
    wl = 4.0767416621;
    wm = -3.3077115913;
    ws = 0.2309699292;
  } else if (1.81444104 * a - 1.19445276 * b > 1) {
    // Green component
    k0 = 0.73956515;
    k1 = -0.45954404;
    k2 = 0.08285427;
    k3 = 0.1254107;
    k4 = 0.14503204;
    wl = -1.2684380046;
    wm = 2.6097574011;
    ws = -0.3413193965;
  } else {
    // Blue component
    k0 = 1.35733652;
    k1 = -0.00915799;
    k2 = -1.1513021;
    k3 = -0.50559606;
    k4 = 0.00692167;
    wl = -0.0041960863;
    wm = -0.7034186147;
    ws = 1.707614701;
  }

  let bigS = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;

  // One step of Halley's method to refine.
  const kL = 0.3963377774 * a + 0.2158037573 * b;
  const kM = -0.1055613458 * a - 0.0638541728 * b;
  const kS = -0.0894841775 * a - 1.291485548 * b;

  const lRoot = 1 + bigS * kL;
  const mRoot = 1 + bigS * kM;
  const sRoot = 1 + bigS * kS;

  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  const lDs = 3 * kL * lRoot * lRoot;
  const mDs = 3 * kM * mRoot * mRoot;
  const sDs = 3 * kS * sRoot * sRoot;

  const lDs2 = 6 * kL * kL * lRoot;
  const mDs2 = 6 * kM * kM * mRoot;
  const sDs2 = 6 * kS * kS * sRoot;

  const f = wl * l + wm * m + ws * s;
  const f1 = wl * lDs + wm * mDs + ws * sDs;
  const f2 = wl * lDs2 + wm * mDs2 + ws * sDs2;

  bigS = bigS - (f * f1) / (f1 * f1 - 0.5 * f * f2);

  return bigS;
}

// L_cusp and C_cusp for a given hue (a, b normalised so a^2 + b^2 == 1).
function findCusp(a: number, b: number): [number, number] {
  const sCusp = computeMaxSaturation(a, b);
  const rgbAtMax = oklabToLinearSrgb(1, sCusp * a, sCusp * b);
  const lCusp = Math.cbrt(1 / Math.max(rgbAtMax[0], rgbAtMax[1], rgbAtMax[2]));
  const cCusp = lCusp * sCusp;
  return [lCusp, cCusp];
}

function findGamutIntersection(
  a: number,
  b: number,
  l1: number,
  c1: number,
  l0: number,
  cusp: [number, number],
): number {
  let t: number;
  if ((l1 - l0) * cusp[1] - (cusp[0] - l0) * c1 <= 0) {
    // Lower half
    t = (cusp[1] * l0) / (c1 * cusp[0] + cusp[1] * (l0 - l1));
  } else {
    // Upper half: first intersect with triangle...
    t = (cusp[1] * (l0 - 1)) / (c1 * (cusp[0] - 1) + cusp[1] * (l0 - l1));

    // ...then one step of Halley's method.
    const dL = l1 - l0;
    const dC = c1;

    const kL = 0.3963377774 * a + 0.2158037573 * b;
    const kM = -0.1055613458 * a - 0.0638541728 * b;
    const kS = -0.0894841775 * a - 1.291485548 * b;

    const lDt = dL + dC * kL;
    const mDt = dL + dC * kM;
    const sDt = dL + dC * kS;

    const bigL = l0 * (1 - t) + t * l1;
    const bigC = t * c1;

    const lRoot = bigL + bigC * kL;
    const mRoot = bigL + bigC * kM;
    const sRoot = bigL + bigC * kS;

    const l = lRoot * lRoot * lRoot;
    const m = mRoot * mRoot * mRoot;
    const s = sRoot * sRoot * sRoot;

    const lDt1 = 3 * lDt * lRoot * lRoot;
    const mDt1 = 3 * mDt * mRoot * mRoot;
    const sDt1 = 3 * sDt * sRoot * sRoot;

    const lDt2 = 6 * lDt * lDt * lRoot;
    const mDt2 = 6 * mDt * mDt * mRoot;
    const sDt2 = 6 * sDt * sDt * sRoot;

    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s - 1;
    const r1 = 4.0767416621 * lDt1 - 3.3077115913 * mDt1 + 0.2309699292 * sDt1;
    const r2 = 4.0767416621 * lDt2 - 3.3077115913 * mDt2 + 0.2309699292 * sDt2;
    const uR = r1 / (r1 * r1 - 0.5 * r * r2);
    let tR = -r * uR;

    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s - 1;
    const g1 = -1.2684380046 * lDt1 + 2.6097574011 * mDt1 - 0.3413193965 * sDt1;
    const g2 = -1.2684380046 * lDt2 + 2.6097574011 * mDt2 - 0.3413193965 * sDt2;
    const uG = g1 / (g1 * g1 - 0.5 * g * g2);
    let tG = -g * uG;

    const bComp = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s - 1;
    const b1 = -0.0041960863 * lDt1 - 0.7034186147 * mDt1 + 1.707614701 * sDt1;
    const b2 = -0.0041960863 * lDt2 - 0.7034186147 * mDt2 + 1.707614701 * sDt2;
    const uB = b1 / (b1 * b1 - 0.5 * bComp * b2);
    let tB = -bComp * uB;

    tR = uR >= 0 ? tR : 1e6;
    tG = uG >= 0 ? tG : 1e6;
    tB = uB >= 0 ? tB : 1e6;

    t += Math.min(tR, tG, tB);
  }

  return t;
}

function getStMid(a: number, b: number): [number, number] {
  const s =
    0.11516993 +
    1 /
      (7.4477897 +
        4.1590124 * b +
        a *
          (-2.19557347 +
            1.75198401 * b +
            a * (-2.13704948 - 10.02301043 * b + a * (-4.24894561 + 5.38770819 * b + 4.69891013 * a))));

  const t =
    0.11239642 +
    1 /
      (1.6132032 -
        0.68124379 * b +
        a *
          (0.40370612 +
            0.90148123 * b +
            a * (-0.27087943 + 0.6122399 * b + a * (0.00299215 - 0.45399568 * b - 0.14661872 * a))));

  return [s, t];
}

function getCs(bigL: number, a: number, b: number): Triplet {
  const cusp = findCusp(a, b);
  const cMax = findGamutIntersection(a, b, bigL, 1, bigL, cusp);
  const stMax = toST(cusp);

  const k = cMax / Math.min(bigL * stMax[0], (1 - bigL) * stMax[1]);

  const stMid = getStMid(a, b);
  const cAMid = bigL * stMid[0];
  const cBMid = (1 - bigL) * stMid[1];
  const cMid =
    0.9 * k * Math.sqrt(Math.sqrt(1 / (1 / (cAMid * cAMid * cAMid * cAMid) + 1 / (cBMid * cBMid * cBMid * cBMid))));

  const cA0 = bigL * 0.4;
  const cB0 = (1 - bigL) * 0.8;
  const c0 = Math.sqrt(1 / (1 / (cA0 * cA0) + 1 / (cB0 * cB0)));

  return [c0, cMid, cMax];
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Convert OKHSL (h in degrees, s/l in [0,1]) to 0–255 sRGB. Always in-gamut. */
export function okhslToRgb({ h, s, l }: Okhsl): Rgb {
  const lightness = clamp01(l);
  const saturation = clamp01(s);

  if (lightness >= 1) return { red: 255, green: 255, blue: 255 };
  if (lightness <= 0) return { red: 0, green: 0, blue: 0 };

  const hueTurns = (((h % 360) + 360) % 360) / 360;
  const aNorm = Math.cos(2 * Math.PI * hueTurns);
  const bNorm = Math.sin(2 * Math.PI * hueTurns);
  const bigL = toeInverse(lightness);

  const [c0, cMid, cMax] = getCs(bigL, aNorm, bNorm);

  let t: number;
  let k0: number;
  let k1: number;
  let k2: number;
  if (saturation < 0.8) {
    t = 1.25 * saturation;
    k0 = 0;
    k1 = 0.8 * c0;
    k2 = 1 - k1 / cMid;
  } else {
    t = 5 * (saturation - 0.8);
    k0 = cMid;
    k1 = (0.2 * cMid * cMid * 1.25 * 1.25) / c0;
    k2 = 1 - k1 / (cMax - cMid);
  }

  const c = k0 + (t * k1) / (1 - k2 * t);

  const rgb = oklabToLinearSrgb(bigL, c * aNorm, c * bNorm);
  return {
    red: clampByte(255 * srgbTransferFunction(rgb[0])),
    green: clampByte(255 * srgbTransferFunction(rgb[1])),
    blue: clampByte(255 * srgbTransferFunction(rgb[2])),
  };
}

/** Convert 0–255 sRGB to OKHSL (h in degrees, s/l in [0,1]). */
export function rgbToOkhsl({ red, green, blue }: Rgb): Okhsl {
  const [bigL, labA, labB] = linearSrgbToOklab(
    srgbTransferFunctionInverse(red / 255),
    srgbTransferFunctionInverse(green / 255),
    srgbTransferFunctionInverse(blue / 255),
  );

  const c = Math.sqrt(labA * labA + labB * labB);
  const l = toe(bigL);

  // Achromatic (grey/black/white): hue and saturation are undefined; report 0.
  if (c < 1e-7) {
    return { h: 0, s: 0, l: clamp01(l) };
  }

  const aNorm = labA / c;
  const bNorm = labB / c;
  const hueTurns = 0.5 + (0.5 * Math.atan2(-labB, -labA)) / Math.PI;

  const [c0, cMid, cMax] = getCs(bigL, aNorm, bNorm);

  let s: number;
  if (c < cMid) {
    const k1 = 0.8 * c0;
    const k2 = 1 - k1 / cMid;
    const t = c / (k1 + k2 * c);
    s = t * 0.8;
  } else {
    const k0 = cMid;
    const k1 = (0.2 * cMid * cMid * 1.25 * 1.25) / c0;
    const k2 = 1 - k1 / (cMax - cMid);
    const t = (c - k0) / (k1 + k2 * (c - k0));
    s = 0.8 + 0.2 * t;
  }

  return {
    h: (((hueTurns * 360) % 360) + 360) % 360,
    s: clamp01(s),
    l: clamp01(l),
  };
}

function parseHex(hex: string): Rgb | null {
  const trimmed = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  return {
    red: parseInt(trimmed.slice(0, 2), 16),
    green: parseInt(trimmed.slice(2, 4), 16),
    blue: parseInt(trimmed.slice(4, 6), 16),
  };
}

function rgbToHexString({ red, green, blue }: Rgb): string {
  const channel = (value: number) => clampByte(value).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** Parse a #rrggbb hex string into OKHSL, or null if malformed. */
export function hexToOkhsl(hex: string): Okhsl | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return rgbToOkhsl(rgb);
}

/** Convert OKHSL back to a lowercase #rrggbb hex string. */
export function okhslToHex(okhsl: Okhsl): string {
  return rgbToHexString(okhslToRgb(okhsl));
}
