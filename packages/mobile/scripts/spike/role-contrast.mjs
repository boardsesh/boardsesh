/**
 * Role-colour contrast and colour-vision oracle for the #2202 blue-HAND job.
 *
 *   node --import tsx packages/mobile/scripts/spike/role-contrast.mjs selftest [--json]
 *   node --import tsx packages/mobile/scripts/spike/role-contrast.mjs table [--field #hex ...] [--json]
 *   node --import tsx packages/mobile/scripts/spike/role-contrast.mjs candidate --board <BoardName> --role HAND --hex #xxxxxx [--json]
 *   node --import tsx packages/mobile/scripts/spike/role-contrast.mjs batch <file.json> [--json]
 *
 * Every number the panel quotes about a role hex should come out of this file,
 * so that "HAND is 3.05:1" and "deutan HAND/FOOT is 24.3" mean one pipeline.
 * Node built-ins only; the palette is read live out of `HOLD_STATE_MAP` at each
 * board's `STATE_TO_PRIMARY_CODE`, resolved as `displayColor ?? color` — the
 * expression `use-native-climb-render.ts` and `worker-manager.ts` draw with.
 *
 * Pipeline, in order:
 *   hex → sRGB 8-bit → linear (IEC 61966-2-1 curve)
 *   CVD: 3×3 matrix in LINEAR RGB (Viénot 1999 copied verbatim from
 *        `build-figures.mjs`; Machado 2009 severity 1.0), clamped to [0,1]. ΔE00 is
 *        taken from those floats; `simulate()` re-encodes to 8-bit with the same
 *        clamp + round `build-figures.mjs#toSrgb` uses when a pixel is wanted.
 *   WCAG 2.x relative luminance (0.2126 / 0.7152 / 0.0722) and (L1+0.05)/(L2+0.05).
 *   OkLab / OkLCh (Ottosson 2020) straight from linear RGB.
 *   CIE XYZ (sRGB D65 matrix) → CIE Lab with the D65 white → CIEDE2000
 *   (Sharma, Wu & Dalal 2005, kL = kC = kH = 1).
 *
 * `build-figures.mjs` carries the Viénot matrices and the sRGB curve but no
 * CIEDE2000 — the reviews' ΔE00 came out of an uncommitted scratch script — so
 * the CIEDE2000 here is the reference formulation, calibrated against the ΔE00
 * values the reviews published (see `selftest`).
 *
 * Viénot 1999 defines protan and deutan only; there is no Viénot tritan. The
 * "Viénot P,D,T" triple the panel asked for is therefore `vienot.protan`,
 * `vienot.deutan` and `tritan.simple` — the linear-RGB tritanopia matrix that
 * circulates with Viénot's two in the "simple" simulator sets (Fidaner, Lin &
 * Ozgüven 2005). It is carried for completeness and labelled for what it is.
 * `machado.tritan` is the only tritan model here with a peer-reviewed source;
 * use it for tritan decisions.
 *
 * Calibration record (run `selftest` for the live table; 36 checks):
 *   - All 17 WCAG contrast checks reproduce the published figures exactly to two
 *     decimals (same formula, same rounding).
 *   - The three OkLab L checks from README ("What the measurements said") match
 *     exactly to three decimals.
 *   - All 14 ΔE00 checks under Viénot protan/deutan and Machado protan reproduce
 *     the published one-decimal figures exactly once the simulated colour is
 *     kept as linear floats (see `simulateLinear`). Re-quantising to 8-bit
 *     before Lab, as the figure sheet must, moved 11 of them by 0.1-0.3, and a
 *     D50 Lab white moved them by 0.6 on average, so the reviews' pipeline was
 *     "linear matrix, clamp, D65 Lab, no rounding" and that is what this is.
 *     The ±0.4 tolerance is now slack; it stays so a future re-publication that
 *     does round cannot turn the oracle red for nothing.
 *   - The two "tritan" checks (Grasshopper STARTING/HAND 24.7, equalL
 *     STARTING/HAND 3.3) could NOT be reproduced by any tritan matrix tried —
 *     Fidaner simple, Machado 2009 (both orientations), the Viénot-method
 *     projection DaltonLens publishes, and the LMS "colorblind" matrix — in
 *     linear or gamma-encoded RGB, and no other pair on either palette lands on
 *     24.7 / 3.3 under any tritan transform either. They are reported as
 *     UNREPRODUCED with every matrix's value printed, do not count as FAIL, and
 *     the published tritan claim in design-review-2/3 and PORT-HANDOVER §0
 *     should be treated as unverified. Under `machado.tritan` the ranking the
 *     reviews asserted still holds (shipped 31.7 vs equalL 15.5); under
 *     `tritan.simple` it reverses (15.2 vs 25.8).
 *   Exit 1 only on a FAIL (a reproducible check outside its tolerance).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';

// ---- play fields ----------------------------------------------------------------

/** The five play fields the app can show (spike-config.ts `SPIKE_BACKGROUNDS`). */
export const FIELDS = {
  field: '#181225',
  grey: '#3A3A3C',
  ink: '#0B0B0C',
  wood: '#6B4F33',
  light: '#FFFFFF',
};

const ROLE_ORDER = ['STARTING', 'HAND', 'FINISH', 'FOOT'];

// ---- sRGB -------------------------------------------------------------------------

export function parseHex(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function toHex([red, green, blue]) {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

/** Copied from build-figures.mjs — the sRGB decode the colour-vision sheet uses. */
const toLinear = (channel) =>
  channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4;
/** Copied from build-figures.mjs — clamp + round to an 8-bit pixel. */
const toSrgb = (value) => {
  const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
};

export const rgbToLinear = (rgb) => rgb.map(toLinear);
export const linearToRgb = (linear) => linear.map(toSrgb);

// ---- colour-vision deficiency ----------------------------------------------------

/** Viénot, Brettel & Mollon (1999), linear RGB. Verbatim from build-figures.mjs. */
const VIENOT = {
  protan: [0.11238, 0.88762, 0, 0.11238, 0.88762, 0, 0.004, -0.004, 1],
  deutan: [0.29275, 0.70725, 0, 0.29275, 0.70725, 0, -0.02234, 0.02234, 1],
};

/**
 * NOT Viénot. The linear-RGB tritanopia matrix from the "simple" simulator sets
 * (Fidaner, Lin & Ozgüven 2005) that is usually shipped beside Viénot's two.
 * Carried so the panel has a third tritan opinion; it is the least trustworthy
 * of the three and it is the one that disagrees with Machado on equalL.
 */
const SIMPLE_TRITAN = [0.95, 0.05, 0, 0, 0.43333, 0.56667, 0, 0.475, 0.525];

/**
 * Machado, Oliveira & Fernandes (2009), severity 1.0, linear RGB. Row-major, the
 * published table transposed into "output = M · input" form.
 */
const MACHADO = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

export const TRANSFORMS = [
  { key: 'normal', label: 'normal', matrix: null },
  { key: 'vienot.protan', label: 'Viénot protan', matrix: VIENOT.protan },
  { key: 'vienot.deutan', label: 'Viénot deutan', matrix: VIENOT.deutan },
  { key: 'tritan.simple', label: 'tritan (simple, not Viénot)', matrix: SIMPLE_TRITAN },
  { key: 'machado.protan', label: 'Machado protan', matrix: MACHADO.protan },
  { key: 'machado.deutan', label: 'Machado deutan', matrix: MACHADO.deutan },
  { key: 'machado.tritan', label: 'Machado tritan', matrix: MACHADO.tritan },
];

function applyMatrix(matrix, [red, green, blue]) {
  return [
    matrix[0] * red + matrix[1] * green + matrix[2] * blue,
    matrix[3] * red + matrix[4] * green + matrix[5] * blue,
    matrix[6] * red + matrix[7] * green + matrix[8] * blue,
  ];
}

/**
 * Simulate one 8-bit sRGB colour under a transform; returns clamped LINEAR RGB
 * floats. This is the form the ΔE00 checks are computed from: re-quantising to
 * 8-bit first moves saturated pairs by up to 0.3 ΔE00 and the published figures
 * were computed without it (selftest mean |delta| 0.03 unrounded vs 0.11 rounded).
 */
export function simulateLinear(rgb, transformKey) {
  const transform = TRANSFORMS.find((entry) => entry.key === transformKey);
  if (!transform) throw new Error(`unknown transform ${transformKey}`);
  const linear = rgbToLinear(rgb);
  if (transform.matrix === null) return linear;
  return applyMatrix(transform.matrix, linear).map((value) => Math.max(0, Math.min(1, value)));
}

/** The same simulation as an 8-bit sRGB pixel — what the colour-vision sheet draws. */
export function simulate(rgb, transformKey) {
  return linearToRgb(simulateLinear(rgb, transformKey));
}

// ---- WCAG -----------------------------------------------------------------------

export function relativeLuminance(rgb) {
  const [red, green, blue] = rgbToLinear(rgb);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(rgbA, rgbB) {
  const lumA = relativeLuminance(rgbA);
  const lumB = relativeLuminance(rgbB);
  const [lighter, darker] = lumA >= lumB ? [lumA, lumB] : [lumB, lumA];
  return (lighter + 0.05) / (darker + 0.05);
}

// ---- OkLab ----------------------------------------------------------------------

export function linearToOklab([red, green, blue]) {
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklch(rgb) {
  const [L, a, b] = linearToOklab(rgbToLinear(rgb));
  const chroma = Math.hypot(a, b);
  let hue = (Math.atan2(b, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { L, C: chroma, h: chroma < 1e-6 ? 0 : hue };
}

// ---- CIE Lab + CIEDE2000 ---------------------------------------------------------

const D65 = [0.95047, 1.0, 1.08883];

export function linearToLab([red, green, blue]) {
  const xyz = [
    0.4124564 * red + 0.3575761 * green + 0.1804375 * blue,
    0.2126729 * red + 0.7151522 * green + 0.072175 * blue,
    0.0193339 * red + 0.119192 * green + 0.9503041 * blue,
  ];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = xyz.map((value, index) => f(value / D65[index]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export const rgbToLab = (rgb) => linearToLab(rgbToLinear(rgb));

const deg = (radians) => (radians * 180) / Math.PI;
const rad = (degrees) => (degrees * Math.PI) / 180;

/** CIEDE2000, Sharma, Wu & Dalal (2005) reference formulation, kL = kC = kH = 1. */
export function ciede2000([L1, a1, b1], [L2, a2, b2]) {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const meanC = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hueOf = (a, b) => {
    if (a === 0 && b === 0) return 0;
    const h = deg(Math.atan2(b, a));
    return h < 0 ? h + 360 : h;
  };
  const h1p = hueOf(a1p, b1);
  const h2p = hueOf(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));

  const meanLp = (L1 + L2) / 2;
  const meanCp = (C1p + C2p) / 2;
  let meanHp;
  if (C1p * C2p === 0) meanHp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) meanHp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) meanHp = (h1p + h2p + 360) / 2;
  else meanHp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos(rad(meanHp - 30)) +
    0.24 * Math.cos(rad(2 * meanHp)) +
    0.32 * Math.cos(rad(3 * meanHp + 6)) -
    0.2 * Math.cos(rad(4 * meanHp - 63));
  const dTheta = 30 * Math.exp(-(((meanHp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (meanLp - 50) ** 2) / Math.sqrt(20 + (meanLp - 50) ** 2);
  const SC = 1 + 0.045 * meanCp;
  const SH = 1 + 0.015 * meanCp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;

  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

/** ΔE00 between two 8-bit sRGB colours after `transformKey` (normal = none). */
export function deltaE(rgbA, rgbB, transformKey = 'normal') {
  return ciede2000(linearToLab(simulateLinear(rgbA, transformKey)), linearToLab(simulateLinear(rgbB, transformKey)));
}

// ---- palettes -------------------------------------------------------------------

export const BOARD_NAMES = Object.keys(HOLD_STATE_MAP);

/** Per-board role palette resolved the way the renderers resolve it. */
export function boardPalette(boardName) {
  const codes = STATE_TO_PRIMARY_CODE[boardName];
  const states = HOLD_STATE_MAP[boardName];
  if (!codes || !states) throw new Error(`unknown board ${boardName}; known: ${BOARD_NAMES.join(', ')}`);
  const palette = {};
  for (const role of ROLE_ORDER) {
    const code = codes[role];
    if (code === undefined) continue;
    const info = states[code];
    if (!info) continue;
    palette[role] = { code, display: (info.displayColor ?? info.color).toUpperCase(), led: info.color.toUpperCase() };
  }
  return palette;
}

const round = (value, places = 2) => Number(value.toFixed(places));

function wcagRow(hex, fields) {
  const rgb = parseHex(hex);
  const out = {};
  for (const [key, fieldHex] of Object.entries(fields)) out[key] = round(contrastRatio(rgb, parseHex(fieldHex)), 2);
  return out;
}

function oklchRow(hex) {
  const { L, C, h } = oklch(parseHex(hex));
  return { L: round(L, 3), C: round(C, 3), h: round(h, 1) };
}

/** Pairwise ΔE00 matrix for `{role: hex}` under every transform, plus the worst pair each. */
function pairMatrices(hexByRole) {
  const roles = Object.keys(hexByRole);
  const result = {};
  for (const { key } of TRANSFORMS) {
    const pairs = {};
    let worst = null;
    for (let a = 0; a < roles.length; a += 1) {
      for (let b = a + 1; b < roles.length; b += 1) {
        const pairKey = `${roles[a]}/${roles[b]}`;
        const value = round(deltaE(parseHex(hexByRole[roles[a]]), parseHex(hexByRole[roles[b]]), key), 1);
        pairs[pairKey] = value;
        if (worst === null || value < worst.dE00) worst = { pair: pairKey, dE00: value };
      }
    }
    result[key] = { pairs, worst };
  }
  return result;
}

// ---- subcommands ----------------------------------------------------------------

export function table({ fields = FIELDS } = {}) {
  const boards = {};
  for (const boardName of BOARD_NAMES) {
    const palette = boardPalette(boardName);
    const roles = {};
    const hexByRole = {};
    for (const [role, entry] of Object.entries(palette)) {
      hexByRole[role] = entry.display;
      roles[role] = {
        code: entry.code,
        display: entry.display,
        led: entry.led,
        wcag: wcagRow(entry.display, fields),
        oklch: oklchRow(entry.display),
      };
    }
    const cvd = pairMatrices(hexByRole);
    const worstPairs = Object.fromEntries(Object.entries(cvd).map(([key, { worst }]) => [key, worst]));
    boards[boardName] = { roles, cvd, worstPairs };
  }
  return { fields, transforms: TRANSFORMS.map(({ key, label }) => ({ key, label })), boards };
}

export function candidate({ board, role = 'HAND', hex, fields = FIELDS }) {
  const palette = boardPalette(board);
  const shipped = palette[role];
  if (!shipped) throw new Error(`${board} has no ${role} role`);
  const candidateHex = toHex(parseHex(hex));
  const currentHexes = Object.fromEntries(Object.entries(palette).map(([name, entry]) => [name, entry.display]));
  const proposedHexes = { ...currentHexes, [role]: candidateHex };
  const current = pairMatrices(currentHexes);
  const proposed = pairMatrices(proposedHexes);

  const otherRoles = Object.keys(palette).filter((name) => name !== role);
  const wcag = wcagRow(candidateHex, fields);
  const othersWorstOnField = Math.min(
    ...otherRoles.map((name) => contrastRatio(parseHex(palette[name].display), parseHex(fields.field ?? FIELDS.field))),
  );

  const perTransform = {};
  for (const { key } of TRANSFORMS) {
    const candidatePairs = Object.entries(proposed[key].pairs).filter(([pairKey]) => pairKey.split('/').includes(role));
    const candidateMin = candidatePairs.reduce(
      (best, [pairKey, value]) => (best === null || value < best.dE00 ? { pair: pairKey, dE00: value } : best),
      null,
    );
    perTransform[key] = {
      currentWorst: current[key].worst,
      newWorst: proposed[key].worst,
      candidateMin,
      collision: proposed[key].worst.dE00 < current[key].worst.dE00,
      pairs: Object.fromEntries(candidatePairs),
    };
  }

  return {
    board,
    role,
    hex: candidateHex,
    shippedDisplay: shipped.display,
    led: shipped.led,
    wcag,
    oklch: oklchRow(candidateHex),
    dE00ToShipped: round(deltaE(parseHex(candidateHex), parseHex(shipped.display)), 1),
    dE00ToLed: round(deltaE(parseHex(candidateHex), parseHex(shipped.led)), 1),
    othersWorstOnField: round(othersWorstOnField, 2),
    meetsOthersWorst:
      contrastRatio(parseHex(candidateHex), parseHex(fields.field ?? FIELDS.field)) >= othersWorstOnField,
    anyCollision: Object.values(perTransform).some((entry) => entry.collision),
    perTransform,
  };
}

// ---- selftest -------------------------------------------------------------------

const GRASSHOPPER = 'grasshopper';
const EQUAL_L = { STARTING: '#00C000', HAND: '#7B96FF', FINISH: '#FF6553', FOOT: '#FE00FE' };

/**
 * The display hexes the published figures were computed against. The checks
 * pin these, not the live map: the fourth pass moved every blue HAND to
 * `#6980FF`, and a selftest that read the live palette would then "fail" on
 * numbers that were right when they were published. `table` and `candidate`
 * keep reading the live map; only the calibration is frozen.
 */
const PUBLISHED_DISPLAY = {
  grasshopper: { HAND: '#4455FF' },
  tension: { HAND: '#4444FF' },
  moonboard: { HAND: '#4444FF' },
  kilter: {},
};

function buildChecks() {
  const display = (board, role) => PUBLISHED_DISPLAY[board]?.[role] ?? boardPalette(board)[role].display;
  const wcag = (name, board, role, field, published) => ({
    kind: 'wcag',
    name,
    tolerance: 0.02,
    published,
    computed: round(contrastRatio(parseHex(display(board, role)), parseHex(field)), 2),
  });
  const de = (name, board, roleA, roleB, transform, published) => ({
    kind: 'dE00',
    name,
    tolerance: 0.4,
    published,
    computed: round(deltaE(parseHex(display(board, roleA)), parseHex(display(board, roleB)), transform), 1),
  });
  const deHex = (name, hexA, hexB, transform, published) => ({
    kind: 'dE00',
    name,
    tolerance: 0.4,
    published,
    computed: round(deltaE(parseHex(hexA), parseHex(hexB), transform), 1),
  });
  const okL = (name, hex, published) => ({
    kind: 'oklabL',
    name,
    tolerance: 0.002,
    published,
    computed: round(oklch(parseHex(hex)).L, 3),
  });

  return [
    // WCAG vs #181225 — PORT-HANDOVER.md §0 table
    wcag('grasshopper HAND #4455FF vs #181225', GRASSHOPPER, 'HAND', FIELDS.field, 3.46),
    wcag('tension HAND #4444FF vs #181225', 'tension', 'HAND', FIELDS.field, 3.05),
    wcag('grasshopper STARTING #00DD00 vs #181225', GRASSHOPPER, 'STARTING', FIELDS.field, 9.85),
    wcag('grasshopper FINISH #FF0000 vs #181225', GRASSHOPPER, 'FINISH', FIELDS.field, 4.56),
    wcag('grasshopper FOOT #FF00FF vs #181225', GRASSHOPPER, 'FOOT', FIELDS.field, 5.81),
    wcag('kilter HAND #00FFFF vs #181225', 'kilter', 'HAND', FIELDS.field, 14.54),
    wcag('kilter STARTING #00FF00 vs #181225', 'kilter', 'STARTING', FIELDS.field, 13.28),
    wcag('kilter FINISH #FF00FF vs #181225', 'kilter', 'FINISH', FIELDS.field, 5.81),
    wcag('kilter FOOT #FFAA00 vs #181225', 'kilter', 'FOOT', FIELDS.field, 9.55),
    wcag('moonboard STARTING #44FF44 vs #181225', 'moonboard', 'STARTING', FIELDS.field, 13.57),
    wcag('moonboard FINISH #FF3333 vs #181225', 'moonboard', 'FINISH', FIELDS.field, 5.01),
    // Other fields — PORT-HANDOVER.md §0 prose
    wcag('grasshopper HAND vs #3A3A3C grey', GRASSHOPPER, 'HAND', FIELDS.grey, 2.16),
    wcag('grasshopper HAND vs #6B4F33 plywood', GRASSHOPPER, 'HAND', FIELDS.wood, 1.43),
    wcag('moonboard HAND vs #3A3A3C grey', 'moonboard', 'HAND', FIELDS.grey, 1.9),
    wcag('moonboard HAND vs #6B4F33 plywood', 'moonboard', 'HAND', FIELDS.wood, 1.26),
    wcag('kilter HAND vs #FFFFFF', 'kilter', 'HAND', FIELDS.light, 1.25),
    wcag('grasshopper HAND vs #FFFFFF', GRASSHOPPER, 'HAND', FIELDS.light, 5.26),
    // OkLab L — README "What the measurements said"
    okL('OkLab L grasshopper HAND #4455FF', '#4455FF', 0.551),
    okL('OkLab L grasshopper STARTING #00DD00', '#00DD00', 0.778),
    okL('OkLab L play field #181225', '#181225', 0.2),
    // ΔE00 — design-review-2/3, PORT-HANDOVER §0, build-figures.mjs comments
    de('grasshopper HAND/FOOT Viénot protan', GRASSHOPPER, 'HAND', 'FOOT', 'vienot.protan', 3.2),
    de('grasshopper HAND/FOOT Machado protan', GRASSHOPPER, 'HAND', 'FOOT', 'machado.protan', 3.8),
    de('grasshopper HAND/FOOT Viénot deutan', GRASSHOPPER, 'HAND', 'FOOT', 'vienot.deutan', 20.6),
    de('grasshopper STARTING/FINISH Viénot deutan', GRASSHOPPER, 'STARTING', 'FINISH', 'vienot.deutan', 12.6),
    {
      ...de(
        'grasshopper STARTING/HAND "tritan" (simple matrix)',
        GRASSHOPPER,
        'STARTING',
        'HAND',
        'tritan.simple',
        24.7,
      ),
      unreproduced: true,
    },
    de('tension HAND/FOOT Viénot deutan', 'tension', 'HAND', 'FOOT', 'vienot.deutan', 24.3),
    de('kilter STARTING/FOOT Viénot deutan', 'kilter', 'STARTING', 'FOOT', 'vienot.deutan', 4.6),
    de('kilter STARTING/FOOT Viénot protan', 'kilter', 'STARTING', 'FOOT', 'vienot.protan', 14.6),
    de('kilter HAND/FOOT Viénot protan', 'kilter', 'HAND', 'FOOT', 'vienot.protan', 39.6),
    de('kilter HAND/FOOT Viénot deutan', 'kilter', 'HAND', 'FOOT', 'vienot.deutan', 48.9),
    de('kilter STARTING/HAND Viénot protan', 'kilter', 'STARTING', 'HAND', 'vienot.protan', 38.7),
    de('kilter STARTING/HAND Viénot deutan', 'kilter', 'STARTING', 'HAND', 'vienot.deutan', 48.5),
    deHex('equalL HAND/FOOT Viénot protan', EQUAL_L.HAND, EQUAL_L.FOOT, 'vienot.protan', 16.5),
    deHex('equalL HAND/FOOT Viénot deutan', EQUAL_L.HAND, EQUAL_L.FOOT, 'vienot.deutan', 1.3),
    deHex('equalL STARTING/FINISH Viénot deutan', EQUAL_L.STARTING, EQUAL_L.FINISH, 'vienot.deutan', 4.7),
    {
      ...deHex('equalL STARTING/HAND "tritan" (simple matrix)', EQUAL_L.STARTING, EQUAL_L.HAND, 'tritan.simple', 3.3),
      unreproduced: true,
    },
  ];
}

export function selftest() {
  const checks = buildChecks().map((check) => {
    const delta = round(check.computed - check.published, 3);
    const exact = Math.abs(delta) < 1e-9;
    const pass = Math.abs(delta) <= check.tolerance + 1e-9;
    const status = pass ? (exact ? 'PASS' : 'PASS(near)') : check.unreproduced ? 'UNREPRODUCED' : 'FAIL';
    return { ...check, delta, status };
  });
  // The tritan record: the two published "tritan" figures under every tritan
  // matrix this file knows, so the reader can see none of them lands on 24.7 / 3.3.
  const grasshopper = boardPalette(GRASSHOPPER);
  const tritanPairs = {
    'grasshopper STARTING/HAND (published 24.7)': [grasshopper.STARTING.display, PUBLISHED_DISPLAY.grasshopper.HAND],
    'equalL STARTING/HAND (published 3.3)': [EQUAL_L.STARTING, EQUAL_L.HAND],
  };
  const tritanNote = {};
  for (const [name, [hexA, hexB]] of Object.entries(tritanPairs)) {
    tritanNote[name] = {
      'tritan.simple': round(deltaE(parseHex(hexA), parseHex(hexB), 'tritan.simple'), 1),
      'machado.tritan': round(deltaE(parseHex(hexA), parseHex(hexB), 'machado.tritan'), 1),
    };
  }
  const failed = checks.filter((check) => check.status === 'FAIL').length;
  const near = checks.filter((check) => check.status === 'PASS(near)').length;
  const exact = checks.filter((check) => check.status === 'PASS').length;
  const unreproduced = checks.filter((check) => check.status === 'UNREPRODUCED').length;
  return { total: checks.length, exact, near, unreproduced, failed, checks, tritanNote };
}

// ---- CLI ------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = { field: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--field') flags.field.push(argv[++index]);
    else if (arg === '--board') flags.board = argv[++index];
    else if (arg === '--role') flags.role = argv[++index];
    else if (arg === '--hex') flags.hex = argv[++index];
    else positional.push(arg);
  }
  return { positional, flags };
}

function fieldsFromFlags(flags) {
  if (flags.field.length === 0) return FIELDS;
  const out = {};
  for (const hex of flags.field) {
    const normalised = toHex(parseHex(hex));
    const known = Object.entries(FIELDS).find(([, value]) => value === normalised);
    out[known ? known[0] : normalised] = normalised;
  }
  if (!out.field) out.field = FIELDS.field; // the acceptance test is always against the default field
  return out;
}

const pad = (text, width) => String(text).padEnd(width);
const num = (value, width, places = 2) =>
  (typeof value === 'number' ? value.toFixed(places) : String(value)).padStart(width);

function printTable(result) {
  const fieldKeys = Object.keys(result.fields);
  for (const [boardName, board] of Object.entries(result.boards)) {
    console.log(`\n== ${boardName}`);
    console.log(
      `${pad('role', 9)} ${pad('display', 8)} ${pad('LED', 8)} ${fieldKeys.map((key) => num(result.fields[key], 8, 0)).join('')}   OkLCh L     C     h`,
    );
    for (const [role, entry] of Object.entries(board.roles)) {
      console.log(
        `${pad(role, 9)} ${pad(entry.display, 8)} ${pad(entry.led, 8)} ${fieldKeys.map((key) => num(entry.wcag[key], 8)).join('')}   ${num(entry.oklch.L, 7, 3)} ${num(entry.oklch.C, 5, 3)} ${num(entry.oklch.h, 5, 1)}`,
      );
    }
    const pairKeys = Object.keys(board.cvd.normal.pairs);
    console.log(`${pad('dE00', 28)} ${pairKeys.map((key) => key.padStart(16)).join('')}   worst`);
    for (const { key, label } of result.transforms) {
      const { pairs, worst } = board.cvd[key];
      console.log(
        `${pad(label, 28)} ${pairKeys.map((pairKey) => num(pairs[pairKey], 16, 1)).join('')}   ${worst.pair} ${worst.dE00.toFixed(1)}`,
      );
    }
  }
}

function printCandidate(result) {
  console.log(
    `\n== ${result.board} ${result.role}: candidate ${result.hex} (shipped display ${result.shippedDisplay}, LED ${result.led})`,
  );
  console.log(
    `WCAG ${Object.entries(result.wcag)
      .map(([key, value]) => `${key} ${value.toFixed(2)}`)
      .join(' | ')}`,
  );
  console.log(
    `OkLCh L ${result.oklch.L} C ${result.oklch.C} h ${result.oklch.h} | dE00 to shipped ${result.dE00ToShipped}, to LED ${result.dE00ToLed}`,
  );
  console.log(
    `others' worst on field ${result.othersWorstOnField} -> ${result.meetsOthersWorst ? 'MEETS' : 'below'}; CVD collision: ${result.anyCollision ? 'YES' : 'none'}`,
  );
  console.log(
    `${pad('transform', 20)} ${pad('current worst', 22)} ${pad('new worst', 22)} ${pad('candidate min', 22)} flag`,
  );
  for (const [key, entry] of Object.entries(result.perTransform)) {
    const show = (item) => `${item.pair} ${item.dE00.toFixed(1)}`;
    console.log(
      `${pad(key, 20)} ${pad(show(entry.currentWorst), 22)} ${pad(show(entry.newWorst), 22)} ${pad(show(entry.candidateMin), 22)} ${entry.collision ? 'COLLISION' : 'ok'}`,
    );
  }
}

function printSelftest(result) {
  console.log(
    `${pad('check', 50)} ${'published'.padStart(10)} ${'computed'.padStart(10)} ${'delta'.padStart(8)}  status`,
  );
  for (const check of result.checks) {
    console.log(
      `${pad(check.name, 50)} ${num(check.published, 10, check.kind === 'wcag' ? 2 : check.kind === 'oklabL' ? 3 : 1)} ${num(check.computed, 10, check.kind === 'wcag' ? 2 : check.kind === 'oklabL' ? 3 : 1)} ${num(check.delta, 8, 3)}  ${check.status}`,
    );
  }
  console.log(
    `\n${result.total} checks: ${result.exact} exact, ${result.near} within tolerance, ${result.unreproduced} unreproduced (published tritan figures, see header), ${result.failed} FAIL`,
  );
  for (const [name, values] of Object.entries(result.tritanNote)) {
    console.log(
      `TRITAN_NOTE ${name}: ${Object.entries(values)
        .map(([key, value]) => `${key} ${value}`)
        .join(', ')}`,
    );
  }
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  if (command === 'selftest') {
    const result = selftest();
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printSelftest(result);
    process.exit(result.failed > 0 ? 1 : 0);
  }
  if (command === 'table') {
    const result = table({ fields: fieldsFromFlags(flags) });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printTable(result);
    return;
  }
  if (command === 'candidate') {
    if (!flags.board || !flags.hex) throw new Error('candidate needs --board <BoardName> --hex #xxxxxx [--role HAND]');
    const result = candidate({
      board: flags.board,
      role: flags.role ?? 'HAND',
      hex: flags.hex,
      fields: fieldsFromFlags(flags),
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printCandidate(result);
    return;
  }
  if (command === 'batch') {
    const file = rest[0];
    if (!file) throw new Error('batch needs a JSON file of [{board, role, hex}]');
    const entries = JSON.parse(readFileSync(file, 'utf8'));
    const fields = fieldsFromFlags(flags);
    const results = entries.map((entry) => {
      try {
        return candidate({ board: entry.board, role: entry.role ?? 'HAND', hex: entry.hex, fields });
      } catch (error) {
        return { board: entry.board, role: entry.role, hex: entry.hex, error: String(error.message ?? error) };
      }
    });
    if (flags.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    console.log(
      `${pad('board', 12)} ${pad('role', 8)} ${pad('hex', 8)} ${'field'.padStart(6)} ${'grey'.padStart(6)} ${'wood'.padStart(6)} ${'light'.padStart(6)} ${'dEship'.padStart(7)} ${'dELED'.padStart(6)} meets collision`,
    );
    for (const result of results) {
      if (result.error) {
        console.log(
          `${pad(result.board, 12)} ${pad(result.role ?? '', 8)} ${pad(result.hex ?? '', 8)} ERROR ${result.error}`,
        );
        continue;
      }
      const collisions = Object.entries(result.perTransform)
        .filter(([, entry]) => entry.collision)
        .map(([key, entry]) => `${key}:${entry.newWorst.pair}=${entry.newWorst.dE00}`)
        .join(',');
      console.log(
        `${pad(result.board, 12)} ${pad(result.role, 8)} ${pad(result.hex, 8)} ${num(result.wcag.field, 6)} ${num(result.wcag.grey ?? NaN, 6)} ${num(result.wcag.wood ?? NaN, 6)} ${num(result.wcag.light ?? NaN, 6)} ${num(result.dE00ToShipped, 7, 1)} ${num(result.dE00ToLed, 6, 1)} ${pad(result.meetsOthersWorst ? 'yes' : 'no', 5)} ${collisions || 'none'}`,
      );
    }
    return;
  }
  console.error(
    'usage: role-contrast.mjs selftest | table [--field #hex] | candidate --board B --role R --hex #hex | batch file.json   (all take --json)',
  );
  process.exit(2);
}

// Importable as a module (the scratch sweeps do); only runs the CLI when invoked directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
