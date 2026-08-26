/**
 * Build the #2202 review figures from a directory of device captures.
 *
 *   node --import tsx packages/mobile/scripts/spike/build-figures.mjs <captures-dir> <output-dir> [field]
 *   node --import tsx packages/mobile/scripts/spike/build-figures.mjs --keys
 *
 * Captures come from `capture-boards.sh`, one full-screen PNG per
 * board × treatment. This crops each to the board itself (found by scanning for
 * the play-field colour, so it works whatever a board's aspect ratio is),
 * labels it, and writes:
 *
 *   board-<key>.webp             the captured arms side by side, one board
 *   all-boards-<arm>.webp        one arm on every board, for the two leading arms
 *   colour-vision.webp           the two controls under protanopia and deuteranopia
 *   accessibility-glyphs.webp    the opt-in role glyphs off against on, normal and protan
 *   thumbnails-<size>px.webp     the arms at the widths the app actually draws
 *   blue-hand-candidates*.webp   shipped HAND hex against each `PALETTES=` candidate, whole and 1:1
 *   <SHEET_NAME>*.webp           any `SHEET_ARMS=` arms side by side on the narrowed boards (+ `SHEET_SIZES=`)
 *
 * The last two need captures the default run does not take — `GLYPHS='off on'`
 * and `THUMBS=1` — and say so, with the command, if the file is missing.
 *
 * `--keys` prints the board, treatment, background, palette and size keys the
 * spike screen has, one `<kind> <key>` per line. `capture-boards.sh` checks its
 * matrix against that before shooting, because `board-spike.tsx` resolves an
 * unknown key to index 0 rather than failing.
 *
 * See docs/spike/board-rendering-2202/HANDOVER.md.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  SPIKE_BACKGROUNDS,
  SPIKE_PALETTE_LABEL,
  SPIKE_SIZES,
  SPIKE_TREATMENTS,
} from '../../src/components/board-spike/spike-config.ts';
import { SPIKE_BOARDS, boardWantsNeutralHalos } from '../../src/components/board-spike/spike-boards.ts';

// Before `sharp` is loaded: `capture-boards.sh` runs `--keys` to check its own
// axis values against the screen, and a capture host has no reason to carry an
// image library.
if (process.argv[2] === '--keys') {
  const lines = [
    ...SPIKE_BOARDS.map((board) => `board ${board.key}`),
    ...SPIKE_TREATMENTS.map((treatment) => `treatment ${treatment.key}`),
    ...SPIKE_BACKGROUNDS.map((background) => `background ${background.key}`),
    ...Object.keys(SPIKE_PALETTE_LABEL).map((key) => `palette ${key}`),
    ...SPIKE_SIZES.map((size) => `size ${size.key}`),
  ];
  console.log(lines.join('\n'));
  process.exit(0);
}

const require = createRequire(path.resolve(import.meta.dirname, '../../../../package.json'));
const sharp = require('sharp');

const SHOTS = process.argv[2];
const OUT = process.argv[3];

// ---- the matrix, read from the one file that decides it ---------------------

/**
 * The arm list used to live here, in `capture-boards.sh` and in
 * `spike-config.ts` at once, and a disagreement did not error: the screen
 * resolves an unknown treatment key to index 0, so a run shot the wrong panel
 * under the right caption — which has already happened on this branch. So the
 * capture script owns WHICH arms and sizes get shot, `spike-config.ts` owns what
 * an arm is called, and this file owns only its own one-line gloss.
 */
const CAPTURE_SCRIPT = path.resolve(import.meta.dirname, 'capture-boards.sh');
const captureScriptSource = readFileSync(CAPTURE_SCRIPT, 'utf8');

function captureDefault(name) {
  const match = captureScriptSource.match(new RegExp(`^${name}_DEFAULT='([^']*)'`, 'm'));
  if (match === null) {
    throw new Error(
      `capture-boards.sh no longer defines ${name}_DEFAULT as a single-quoted list — fix one or the other`,
    );
  }
  return match[1].split(/\s+/).filter((word) => word.length > 0);
}

/**
 * `ARMS=` narrows the sheet to a run that did not shoot the whole matrix — the
 * field and glyph axes are shot on two or three arms, not four, and without this
 * the first per-board sheet demanded a capture that run never took and the build
 * wrote nothing at all. It can only NARROW: every name still has to be one of
 * the arms the capture script's default shoots, so this is not a second place
 * the matrix is decided.
 */
function narrowed(fullSet, environmentValue, name) {
  if (environmentValue === undefined) return fullSet;
  const wanted = environmentValue.split(/\s+/).filter((word) => word.length > 0);
  for (const key of wanted) {
    if (!fullSet.includes(key)) {
      throw new Error(`${name}='${environmentValue}' names '${key}', which the default run does not shoot`);
    }
  }
  return wanted;
}

const CAPTURED_ARMS = narrowed(captureDefault('TREATMENTS'), process.env.ARMS, 'ARMS');
const THUMBNAIL_ARMS = captureDefault('THUMBNAIL_ARMS');
const THUMBNAIL_SIZES = captureDefault('THUMBNAIL_SIZES');

const TREATMENT_BY_KEY = new Map(SPIKE_TREATMENTS.map((treatment) => [treatment.key, treatment]));

/**
 * One line on what each arm is testing, at strip width. `spike-config.ts`'s own
 * `note` is the screen's caption and runs two to three times too long to set as
 * a subtitle here, so the gloss is local — but the key, the order and the title
 * are not.
 */
const ARM_SUBTITLE = {
  baseline: 'Control: a fixed circle, LED layer on',
  'thumb-baseline': 'Control at this width: the filled circle `filledStyle` draws',
  'outward-glow': 'Light off the edge, hold surface left clean',
  'glow-tint': 'Fill for shape, crisp silhouette edge, glow for reach',
  'veil-glow': 'Unlit wall washed down in the field colour',
  'veil-tint': 'The same quiet wall, under the filled mark',
  // The glow-size and fill experiments after the blue was settled (issue #2202,
  // fourth pass): each is veil + glow or veil + tint with one rule changed.
  'veil-glow-x15': 'Glow reach and hold cap x1.5',
  'veil-glow-plateau': 'Full alpha over the inner 40% of the glow',
  'veil-glow-x15-plateau': 'Reach x1.5 and the plateau together',
  'veil-glow-disc': 'A soft ring-sized disc under the glow',
  'veil60-glow': 'Veil at 0.60 on the pale dense walls',
  'veil-tint-70': 'Filled mark at alpha 0.70',
  'veil-tint-90': 'Filled mark at alpha 0.90',
};

function armOrDie(key, source) {
  const treatment = TREATMENT_BY_KEY.get(key);
  if (treatment === undefined) {
    throw new Error(
      `${source} names treatment '${key}', which spike-config.ts does not have — the screen would shoot ${SPIKE_TREATMENTS[0].key} under that caption`,
    );
  }
  if (ARM_SUBTITLE[key] === undefined) {
    throw new Error(`${source} names treatment '${key}' with no entry in ARM_SUBTITLE — add its one-line gloss here`);
  }
  return { key, title: treatment.label, subtitle: ARM_SUBTITLE[key] };
}

const TREATMENTS = CAPTURED_ARMS.map((key) => armOrDie(key, 'capture-boards.sh TREATMENTS_DEFAULT'));
const THUMBNAILS = THUMBNAIL_ARMS.map((key) => armOrDie(key, 'capture-boards.sh THUMBNAIL_ARMS_DEFAULT'));

const SIZE_KEYS = new Set(SPIKE_SIZES.map((size) => size.key));
for (const size of THUMBNAIL_SIZES) {
  if (!SIZE_KEYS.has(size)) {
    throw new Error(
      `capture-boards.sh THUMBNAIL_SIZES_DEFAULT names size '${size}', which spike-config.ts does not have`,
    );
  }
}

/**
 * The boards, in the screen's own order, with their labels and their measured
 * share of holds that vanish into the field. Both came from a copy here that
 * went two rounds of fixes out of date before anyone noticed.
 */
const BOARD_KEYS = narrowed(
  SPIKE_BOARDS.map((board) => board.key),
  process.env.BOARDS,
  'BOARDS',
);
const BOARDS = SPIKE_BOARDS.filter((board) => BOARD_KEYS.includes(board.key)).map((board) => ({
  key: board.key,
  label: board.label,
  note: `${(board.lowContrastHoldShare * 100).toFixed(1)}% of holds sit within 0.18 OkLab L of the play field — every-hold outline ${boardWantsNeutralHalos(board) ? 'ON' : 'OFF'}`,
}));

// ---- the play field the captures were taken on ------------------------------

/**
 * How the crop finds the board, so it has to be the colour the capture was taken
 * on. Takes a `SPIKE_BACKGROUNDS` key (`grey`, `light`, `wood`) or a raw hex,
 * and defaults to the dark field the default run pins.
 */
const fieldArgument = process.argv[4] ?? 'field';
const namedBackground = SPIKE_BACKGROUNDS.find((background) => background.key === fieldArgument);
const FIELD_HEX = namedBackground?.color ?? fieldArgument;
if (!SHOTS || !OUT || !/^#?[0-9a-fA-F]{6}$/.test(FIELD_HEX)) {
  const names = SPIKE_BACKGROUNDS.map((background) => background.key).join('|');
  console.error(`usage: build-figures.mjs <captures-dir> <output-dir> [${names}|#rrggbb, default field]`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const FONT = 'Liberation Sans, DejaVu Sans, sans-serif';
const INK = '#0C0A11';
const FIELD = [0, 2, 4].map((offset) => parseInt(FIELD_HEX.replace('#', '').slice(offset, offset + 2), 16));
const GAP = 16;
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- finding a capture, and finding the board in it -------------------------

/**
 * Where `capture-boards.sh` puts a shot: the run's root for every axis at its
 * default, a subdirectory named after each axis that is not. Both halves of the
 * rule are written twice, once in each language; a shot this cannot find says
 * which command takes it.
 */
function shotPath(boardKey, armKey, axes = {}) {
  const parts = [];
  if (axes.field !== undefined) parts.push(`field-${axes.field}`);
  if (axes.palette !== undefined) parts.push(`palette-${axes.palette}`);
  if (axes.glyphs !== undefined && axes.glyphs !== 'off') parts.push(`glyphs-${axes.glyphs}`);
  if (axes.size !== undefined && axes.size !== 'full') parts.push(`size-${axes.size}`);
  return path.join(SHOTS, parts.join('__'), `${boardKey}__${armKey}.png`);
}

function requireShot(file, howToCapture) {
  if (!existsSync(file)) {
    throw new Error(`no capture at ${file}\n  take it with: ${howToCapture}`);
  }
  return file;
}

/**
 * One capture's raw pixels, kept for as long as the next call wants the same
 * file. A 1080x2400 screenshot is ~7.8 MB raw and a run reads dozens of them, so
 * this is a window rather than a cache — the two scans below both want the same
 * buffer, and nothing else asks twice.
 */
let lastRaw = { file: null, pixels: null, info: null };
async function rawOf(file) {
  if (lastRaw.file !== file) {
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    lastRaw = { file, pixels: data, info };
  }
  return lastRaw;
}

/**
 * The board's box in a full-screen capture, found from the play field the spike
 * screen paints behind it.
 *
 * At full width the field spans the screen and the board's own art is
 * transparent at its left and right margins, so the field shows there. At the
 * thumbnail widths the field container is only as wide as the board
 * (`SpikeBoard.tsx` sets `alignSelf: 'center'`), so the same scan finds a
 * ~152 px box in the middle of the screen instead. Either way the answer is the
 * board as drawn, at capture resolution and with no resampling.
 *
 * Three field pixels to count a line, and the longest unbroken run of lines to
 * pick the band: a single antialiased pixel of chip or caption text that happens
 * to land on the field colour would otherwise stretch the box over the whole
 * screen.
 */
async function boardBox(file) {
  const { pixels, info } = await rawOf(file);
  const isField = (offset) =>
    pixels[offset] === FIELD[0] && pixels[offset + 1] === FIELD[1] && pixels[offset + 2] === FIELD[2];

  const perRow = Array.from({ length: info.height }, () => 0);
  const perColumn = Array.from({ length: info.width }, () => 0);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (isField((y * info.width + x) * info.channels)) {
        perRow[y] += 1;
        perColumn[x] += 1;
      }
    }
  }

  const longestRun = (counts) => {
    let bestStart = null;
    let bestEnd = null;
    let start = null;
    for (let index = 0; index <= counts.length; index += 1) {
      const inRun = index < counts.length && counts[index] >= 3;
      if (inRun && start === null) start = index;
      if (!inRun && start !== null) {
        if (bestStart === null || index - start > bestEnd - bestStart + 1) {
          bestStart = start;
          bestEnd = index - 1;
        }
        start = null;
      }
    }
    return bestStart === null ? null : { start: bestStart, end: bestEnd };
  };

  const rows = longestRun(perRow);
  if (rows === null) {
    throw new Error(
      `no ${FIELD_HEX} play field in ${file} — name the field the capture was taken on as the third argument`,
    );
  }
  // Columns are the outer bounds rather than a run: at full width the field's
  // two margins are separate runs with the board between them.
  let left = null;
  let right = null;
  for (let x = 0; x < info.width; x += 1) {
    if (perColumn[x] >= 3) {
      if (left === null) left = x;
      right = x;
    }
  }
  return { left, top: rows.start, width: right - left + 1, height: rows.end - rows.start + 1 };
}

/** A rectangle inside the board box, given as fractions of it. */
function boxFraction(box, x0, y0, x1, y1) {
  return {
    left: box.left + Math.round(x0 * box.width),
    top: box.top + Math.round(y0 * box.height),
    width: Math.round((x1 - x0) * box.width),
    height: Math.round((y1 - y0) * box.height),
  };
}

// ---- labels -----------------------------------------------------------------

function strip(width, height, title, subtitle, titleSize, subSize) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${INK}"/>
      <text x="0" y="${titleSize}" font-family="${FONT}" font-size="${titleSize}" font-weight="bold" fill="#F5F2FB">${escape(title)}</text>
      ${subtitle ? `<text x="0" y="${titleSize + subSize + 8}" font-family="${FONT}" font-size="${subSize}" fill="#A9A2B6">${escape(subtitle)}</text>` : ''}
    </svg>`,
  );
}

/**
 * `subSize` drops for the narrow sheets. SVG text neither wraps nor ellipsises
 * and the viewport clips what runs past it, so a subtitle set at 24 on a
 * 1112 px thumbnail sheet loses its last third with no sign that it did.
 */
const header = (width, title, subtitle, subSize = 24) =>
  Buffer.from(
    `<svg width="${width}" height="96" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="96" fill="${INK}"/>
      <text x="0" y="40" font-family="${FONT}" font-size="40" font-weight="bold" fill="#F5F2FB">${escape(title)}</text>
      <text x="0" y="${52 + subSize}" font-family="${FONT}" font-size="${subSize}" fill="#A9A2B6">${escape(subtitle)}</text>
    </svg>`,
  );

/**
 * Trim a label to what fits a column. SVG text neither wraps nor ellipsises, and
 * a thumbnail column is 152 px wide — a board name set past its edge would run
 * over the next board's tile. 0.55 em per character is the usual approximation
 * for this font at these sizes; it only has to be close enough not to overlap.
 */
function fitText(text, width, fontSize) {
  const characters = Math.floor(width / (fontSize * 0.55));
  return text.length <= characters ? text : `${text.slice(0, Math.max(1, characters - 1))}…`;
}

// ---- the full-size figures --------------------------------------------------

async function perBoardFigure(board) {
  const PANEL = 460;
  const TITLE = 24;
  const SUB = 17;
  const panels = [];
  for (const arm of TREATMENTS) {
    const file = requireShot(shotPath(board.key, arm.key), `capture-boards.sh <dir>`);
    panels.push(
      await sharp(file)
        .extract(await boardBox(file))
        .resize(PANEL)
        .png()
        .toBuffer(),
    );
  }
  const meta = await sharp(panels[0]).metadata();
  const labelHeight = TITLE + SUB + 18;
  const composites = [
    {
      input: header(PANEL * TREATMENTS.length + GAP * (TREATMENTS.length - 1), board.label, board.note),
      left: GAP,
      top: GAP,
    },
  ];
  for (const [index, panel] of panels.entries()) {
    const left = GAP + index * (meta.width + GAP);
    const top = GAP + 96 + GAP;
    composites.push({
      input: strip(meta.width, labelHeight, TREATMENTS[index].title, TREATMENTS[index].subtitle, TITLE, SUB),
      left,
      top,
    });
    composites.push({ input: panel, left, top: top + labelHeight + 8 });
  }
  await sharp({
    create: {
      width: GAP + TREATMENTS.length * (meta.width + GAP),
      height: GAP + 96 + GAP + labelHeight + 8 + meta.height + GAP,
      channels: 4,
      background: INK,
    },
  })
    .composite(composites)
    .webp({ quality: 88 })
    .toFile(path.join(OUT, `board-${board.key}.webp`));
  console.log(`wrote board-${board.key}.webp`);
}

async function allBoardsFigure(armKey) {
  const COLUMN = 360;
  const panels = [];
  for (const board of BOARDS) {
    const file = requireShot(shotPath(board.key, armKey), `capture-boards.sh <dir>`);
    panels.push({
      board,
      image: await sharp(file)
        .extract(await boardBox(file))
        .resize(COLUMN)
        .png()
        .toBuffer(),
    });
  }
  const heights = await Promise.all(panels.map(async (panel) => (await sharp(panel.image).metadata()).height));
  const tallest = Math.max(...heights);
  const labelHeight = 34;
  const composites = [
    {
      input: header(
        COLUMN * BOARDS.length + GAP * (BOARDS.length - 1),
        `${TREATMENT_BY_KEY.get(armKey)?.label ?? armKey}, every board`,
        `Same synthesised climb, shipped art, ${FIELD_HEX} play field, glyphs off`,
      ),
      left: GAP,
      top: GAP,
    },
  ];
  for (const [index, panel] of panels.entries()) {
    const left = GAP + index * (COLUMN + GAP);
    const top = GAP + 96 + GAP;
    composites.push({ input: strip(COLUMN, labelHeight, panel.board.label, '', 22, 0), left, top });
    composites.push({ input: panel.image, left, top: top + labelHeight + 8 });
  }
  await sharp({
    create: {
      width: GAP + BOARDS.length * (COLUMN + GAP),
      height: GAP + 96 + GAP + labelHeight + 8 + tallest + GAP,
      channels: 4,
      background: INK,
    },
  })
    .composite(composites)
    .webp({ quality: 88 })
    .toFile(path.join(OUT, `all-boards-${armKey}.webp`));
  console.log(`wrote all-boards-${armKey}.webp`);
}

// ---- colour-vision simulation ------------------------------------------------

const toLinear = (channel) =>
  channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4;
const toSrgb = (value) => {
  const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
};

/** Viénot, Brettel & Mollon (1999) dichromat simulation, applied in linear RGB. */
const MATRICES = {
  protanopia: [0.11238, 0.88762, 0, 0.11238, 0.88762, 0, 0.004, -0.004, 1],
  deuteranopia: [0.29275, 0.70725, 0, 0.29275, 0.70725, 0, -0.02234, 0.02234, 1],
};

/** `kind` of `null` is the normal-vision panel: crop and scale, no transform. */
async function simulate(file, kind, region, width) {
  const { data, info } = await sharp(file).extract(region).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  if (kind === null) {
    data.copy(out);
  } else {
    const matrix = MATRICES[kind];
    for (let index = 0; index < data.length; index += info.channels) {
      const red = toLinear(data[index]);
      const green = toLinear(data[index + 1]);
      const blue = toLinear(data[index + 2]);
      out[index] = toSrgb(matrix[0] * red + matrix[1] * green + matrix[2] * blue);
      out[index + 1] = toSrgb(matrix[3] * red + matrix[4] * green + matrix[5] * blue);
      out[index + 2] = toSrgb(matrix[6] * red + matrix[7] * green + matrix[8] * blue);
      if (info.channels === 4) out[index + 3] = data[index + 3];
    }
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .resize(width)
    .png()
    .toBuffer();
}

/**
 * Two-by-two of panels that share a crop: `columns` across, `rows` down.
 * `panels` is row-major, each `{ file, kind, title, sub }`.
 */
async function dichromatSheet({ output, title, subtitle, crop, panelWidth, panels, columns }) {
  const images = [];
  for (const panel of panels) {
    const region = boxFraction(await boardBox(panel.file), ...crop);
    images.push(await simulate(panel.file, panel.kind, region, panelWidth));
  }
  const meta = await sharp(images[0]).metadata();
  const labelHeight = 24 + 17 + 18;
  const composites = [
    { input: header(meta.width * columns + GAP * (columns - 1), title, subtitle), left: GAP, top: GAP },
  ];
  panels.forEach((panel, index) => {
    const left = GAP + (index % columns) * (meta.width + GAP);
    const top = GAP + 96 + GAP + Math.floor(index / columns) * (labelHeight + 8 + meta.height + GAP);
    composites.push({ input: strip(meta.width, labelHeight, panel.title, panel.sub, 24, 17), left, top });
    composites.push({ input: images[index], left, top: top + labelHeight + 8 });
  });
  await sharp({
    create: {
      width: GAP + columns * (meta.width + GAP),
      height: GAP + 96 + GAP + Math.ceil(panels.length / columns) * (labelHeight + 8 + meta.height + GAP),
      channels: 4,
      background: INK,
    },
  })
    .composite(composites)
    .webp({ quality: 88 })
    .toFile(path.join(OUT, output));
  console.log(`wrote ${output}`);
}

/**
 * The crop both dichromat sheets use: Grasshopper's lower two thirds.
 *
 * Grasshopper because it is the board #2202 was filed against and the board with
 * the least room between two roles: over `spikeRolePalette('shipped', …)` — which
 * is STARTING `#00DD00`, HAND `#4455FF`, FINISH `#FF0000`, FOOT `#FF00FF` — the
 * Viénot protan transform above puts HAND and FOOT 3.2 ΔE00 apart (sRGB→Lab D65,
 * CIEDE2000). That is the tightest pair on the board under either transform, and
 * far tighter than the same pair's 20.6 under deutan, which is why the sheet's
 * dichromat row is protanopia.
 *
 * It is NOT the only pair worth a look, and this crop deliberately excludes the
 * other one: STARTING against FINISH is 39.1 under protan but **12.6 under
 * deutan**, closer than HAND/FOOT's own deutan 20.6. Everything else runs 64 to
 * 85 under both. So FINISH is not the safe colour it looks like in a protan
 * panel — it is half of the board's tightest deuteranopia pair.
 *
 * This band because the HAND/FOOT pair is what is in it: the synthesised climb
 * puts both STARTING holds, all six FOOT holds and the two lowest HAND holds
 * below 0.52 of the board (`CLIMB_TARGETS` in `spike-boards.ts`), so the
 * collapsing pair sits side by side three times over. The climb's one FINISH is
 * at 0.06, above the crop.
 */
const GRASSHOPPER_CROP = [0.14, 0.52, 0.88, 0.99];

async function colourVisionFigure() {
  // Baseline and Outward glow, the two controls, with the glyphs OFF as they
  // ship: this sheet is about what hue alone does across the two arms, and the
  // glyph's own answer is the sheet below.
  const baseline = requireShot(shotPath('grasshopper-master', 'baseline'), 'capture-boards.sh <dir>');
  const glow = requireShot(shotPath('grasshopper-master', 'outward-glow'), 'capture-boards.sh <dir>');
  await dichromatSheet({
    output: 'colour-vision.webp',
    title: 'The two controls under protanopia and deuteranopia',
    subtitle: 'Grasshopper, glyphs off — Viénot 1999 dichromat transform, role is hue alone',
    crop: GRASSHOPPER_CROP,
    panelWidth: 620,
    columns: 2,
    panels: [
      {
        file: baseline,
        kind: 'protanopia',
        title: 'Baseline, protanopia',
        sub: 'HAND blue and FOOT magenta are one colour, 3.2 ΔE00 apart',
      },
      {
        file: glow,
        kind: 'protanopia',
        title: 'Outward glow, protanopia',
        sub: 'The glow finds the hold; it says nothing about which role it is',
      },
      { file: baseline, kind: 'deuteranopia', title: 'Baseline, deuteranopia', sub: '' },
      { file: glow, kind: 'deuteranopia', title: 'Outward glow, deuteranopia', sub: '' },
    ],
  });
}

async function accessibilityGlyphFigure() {
  // Outward glow rather than a veil arm: the veil turns the whole wall down, so
  // on a veil panel some of what the glyph appears to buy is the veil's contrast.
  // Outward glow leaves the wall exactly as the art painted it, which makes the
  // glyph the only thing that changes between the two columns.
  const capture = 'capture-boards.sh <dir> && GLYPHS=on capture-boards.sh <dir> outward-glow';
  const off = requireShot(shotPath('grasshopper-master', 'outward-glow'), capture);
  const on = requireShot(shotPath('grasshopper-master', 'outward-glow', { glyphs: 'on' }), capture);
  await dichromatSheet({
    output: 'accessibility-glyphs.webp',
    title: 'Accessibility mode: role by hue alone against role by glyph',
    subtitle: 'Grasshopper, outward glow, glyphs off vs on — the lower row is the Viénot 1999 protan transform',
    crop: GRASSHOPPER_CROP,
    panelWidth: 700,
    columns: 2,
    panels: [
      {
        file: off,
        kind: null,
        title: 'Glyphs off — what the app renders',
        sub: 'The default. Role is hue: blue HAND, magenta FOOT, green START',
      },
      {
        file: on,
        kind: null,
        title: 'Glyphs on — the accessibility mode',
        sub: 'FOOT a ring, START a horizontal bar, HAND a vertical bar — the FINISH X is above this crop',
      },
      {
        file: off,
        kind: 'protanopia',
        title: 'Glyphs off, protanopia',
        sub: 'HAND and FOOT are 3.2 ΔE00 apart — one colour, and nothing else',
      },
      {
        file: on,
        kind: 'protanopia',
        title: 'Glyphs on, protanopia',
        sub: 'Same two hues; the ring and the bar carry the role now',
      },
    ],
  });
}

// ---- the sizes the app actually draws ---------------------------------------

/**
 * What each captured width stands for in the app. Every one of these surfaces
 * outnumbers the play view, and none of them has ever been in a spike figure.
 */
const SIZE_SURFACE = {
  152: 'a 76 dp climb-list cell at 2x DPR (climb-list-thumbnail-metrics.ts)',
  228: 'the same climb-list cell at 3x DPR',
  // `maxCompositeDimension` caps the composite's LONG side, not its width
  // (ThumbnailFetcher.swift's `min(1, 384 / max(width, height))`), and every
  // board here is portrait or square — so 384 is the tallest the Live Activity
  // composite ever is, and the widget draws it at roughly 240 px wide inside an
  // 80x100pt lock-screen image. This row is the cap, not what the widget shows.
  384: "the iOS Live Activity composite's 384 px long-side cap (ThumbnailFetcher.swift)",
};

/**
 * One sheet per width: the arms down the page, the seven boards across it, every
 * tile at 1:1 out of a capture taken at that width.
 *
 * A strip and not a single tile because the open question at 152 px is what the
 * veil's whole-thumbnail darkening does at list density — whether it reads as
 * elegant or as muddy when a scroll puts twenty of them on screen — and one
 * thumbnail in isolation cannot answer that. A real list is one board repeated;
 * seven different boards is the harder version of the same question, and it is
 * the only version this spike's captures can honestly show.
 *
 * Nothing here is resampled. `renderer.rs` draws a different picture for a
 * thumbnail than for the play view — an 8.0 base stroke and a 0.3-alpha fill
 * under `filledStyle`, which `ClimbListThumbnail` passes — so a downscaled
 * full-size capture is not the control. `thumb-baseline` is.
 */
async function thumbnailFigure(sizeKey) {
  // The board is laid out in dp and the device rounds dp x density back to whole
  // pixels, so a tile can land a pixel either side of its nominal width. Columns
  // are set to the widest tile in the sheet rather than to the nominal number.
  const capture = `THUMBS=1 capture-boards.sh <dir>`;
  const rows = [];
  for (const arm of THUMBNAILS) {
    const tiles = [];
    for (const board of BOARDS) {
      const file = requireShot(shotPath(board.key, arm.key, { size: sizeKey }), capture);
      tiles.push(
        await sharp(file)
          .extract(await boardBox(file))
          .png()
          .toBuffer(),
      );
    }
    rows.push({ arm, tiles });
  }

  const metas = [];
  for (const row of rows) for (const tile of row.tiles) metas.push(await sharp(tile).metadata());
  const column = Math.max(...metas.map((meta) => meta.width));
  const tallest = Math.max(...metas.map((meta) => meta.height));

  // List density, not figure density: the tiles have to sit as close together as
  // climb rows do or the question the sheet asks changes.
  const TILE_GAP = 8;
  const LABEL = 24;
  const ARM_LABEL = 24 + 17 + 18;
  const sheetWidth = BOARDS.length * column + (BOARDS.length - 1) * TILE_GAP;
  const rowHeight = ARM_LABEL + 8 + tallest + GAP;

  const composites = [
    {
      input: header(
        sheetWidth,
        `${sizeKey} px board — ${THUMBNAILS.length} arms, ${BOARDS.length} boards, 1:1`,
        `${SIZE_SURFACE[sizeKey] ?? 'a width the app draws'} · overlay drawn at this width, not a scaled-down 1080 px render`,
        18,
      ),
      left: GAP,
      top: GAP,
    },
  ];
  BOARDS.forEach((board, index) => {
    composites.push({
      input: strip(column, LABEL, fitText(board.label, column, 15), '', 15, 0),
      left: GAP + index * (column + TILE_GAP),
      top: GAP + 96 + GAP,
    });
  });
  rows.forEach((row, rowIndex) => {
    const top = GAP + 96 + GAP + LABEL + 8 + rowIndex * rowHeight;
    composites.push({
      input: strip(sheetWidth, ARM_LABEL, row.arm.title, row.arm.subtitle, 24, 17),
      left: GAP,
      top,
    });
    row.tiles.forEach((tile, index) => {
      composites.push({
        input: tile,
        left: GAP + index * (column + TILE_GAP),
        top: top + ARM_LABEL + 8,
      });
    });
  });

  await sharp({
    create: {
      width: GAP + sheetWidth + GAP,
      height: GAP + 96 + GAP + LABEL + 8 + rows.length * rowHeight,
      channels: 4,
      background: INK,
    },
  })
    .composite(composites)
    .webp({ quality: 88 })
    .toFile(path.join(OUT, `thumbnails-${sizeKey}px.webp`));
  console.log(`wrote thumbnails-${sizeKey}px.webp`);
}

// ---- arms x boards sheets --------------------------------------------------

/**
 * One grid: a column per (arm, axes) and a row per board, in three kinds —
 * `whole` (the board at column width), `detail` (a 1:1 crop of the middle of
 * the board, where the synthesised climb's HAND holds sit, because a judgement
 * made on a 300 px downsample is a judgement about the downsample) and `thumb`
 * (the `size-<n>` capture, shown at 2x nearest so a 152 px tile is legible).
 */
async function gridSheet({ name, title, subtitle, columns, kind, sizeKey }) {
  const detail = kind === 'detail';
  const thumb = kind === 'thumb';
  const COLUMN = detail ? 420 : thumb ? Number(sizeKey) * 2 : 300;
  const rows = [];
  for (const board of BOARDS) {
    const tiles = [];
    for (const column of columns) {
      const axes = { ...(thumb ? { size: sizeKey } : {}), ...column.axes };
      const file = requireShot(shotPath(board.key, column.arm, axes), column.howToCapture);
      const box = await boardBox(file);
      const region = detail ? boxFraction(box, 0.18, 0.18, 0.82, 0.62) : box;
      tiles.push(
        await sharp(file)
          .extract(region)
          .resize(COLUMN, null, thumb ? { kernel: 'nearest' } : {})
          .png()
          .toBuffer(),
      );
    }
    const height = (await sharp(tiles[0]).metadata()).height;
    rows.push({ board, tiles, height });
  }
  const LABEL = 24 + 17 + 18;
  const ROW_LABEL = 30;
  const sheetWidth = columns.length * COLUMN + GAP * (columns.length - 1);
  const composites = [{ input: header(sheetWidth, title, subtitle), left: GAP, top: GAP }];
  columns.forEach((column, index) => {
    composites.push({
      input: strip(COLUMN, LABEL, fitText(column.title, COLUMN, 24), fitText(column.subtitle, COLUMN, 17), 24, 17),
      left: GAP + index * (COLUMN + GAP),
      top: GAP + 96 + GAP,
    });
  });
  let top = GAP + 96 + GAP + LABEL + 8;
  for (const row of rows) {
    composites.push({ input: strip(sheetWidth, ROW_LABEL, row.board.label, '', 22, 0), left: GAP, top });
    row.tiles.forEach((tile, index) => {
      composites.push({ input: tile, left: GAP + index * (COLUMN + GAP), top: top + ROW_LABEL + 6 });
    });
    top += ROW_LABEL + 6 + row.height + GAP;
  }
  await sharp({ create: { width: GAP + sheetWidth + GAP, height: top, channels: 4, background: INK } })
    .composite(composites)
    .webp({ quality: 88 })
    .toFile(path.join(OUT, name));
  console.log(`wrote ${name}`);
}

const kindSuffix = (kind, sizeKey) => (kind === 'detail' ? '-detail' : kind === 'thumb' ? `-${sizeKey}px` : '');
const kindGloss = (kind) =>
  kind === 'detail'
    ? 'middle of the board at capture resolution'
    : kind === 'thumb'
      ? 'the list cell, shown at 2x nearest'
      : 'whole board';

/**
 * The §0 contrast job: shipped against each candidate role palette, on the
 * boards whose HAND is the dark blue. Needs the `PALETTES='<keys>'` sweep of
 * `capture-boards.sh` on `baseline veil-glow` — the shipped shots sit in the run
 * root, each candidate's under `palette-<key>/`. Columns are baseline and veil +
 * glow on the shipped palette, then veil + glow on every candidate; one row per
 * board. `PALETTES=` here names which candidate keys to lay out, in order, and
 * every key has to be one the screen has (`SPIKE_PALETTE_LABEL`), the same rule
 * `capture-boards.sh` enforces before shooting.
 */
async function blueHandFigure(kind) {
  const paletteKeys = (process.env.PALETTES ?? '').split(/\s+/).filter((word) => word.length > 0);
  if (paletteKeys.length === 0) {
    throw new Error(
      `no capture at <PALETTES unset>\n  take it with: PALETTES='<keys>' capture-boards.sh <dir> baseline veil-glow, then PALETTES='<keys>' build-figures.mjs`,
    );
  }
  for (const key of paletteKeys) {
    if (SPIKE_PALETTE_LABEL[key] === undefined) {
      throw new Error(`PALETTES names '${key}', which spike-config.ts does not have`);
    }
  }
  const thumb = kind === 'thumb';
  const howToCapture = thumb
    ? `THUMBS=1 SIZES=152 PALETTES='${paletteKeys.join(' ')}' capture-boards.sh <dir> thumb-baseline veil-glow`
    : `PALETTES='${paletteKeys.join(' ')}' capture-boards.sh <dir> baseline veil-glow`;
  const columns = [
    {
      title: thumb ? 'Thumb baseline' : 'Baseline',
      subtitle: 'shipped palette',
      arm: thumb ? 'thumb-baseline' : 'baseline',
      axes: {},
      howToCapture,
    },
    { title: 'Veil + glow', subtitle: 'shipped palette', arm: 'veil-glow', axes: {}, howToCapture },
    ...paletteKeys.map((key) => ({
      title: 'Veil + glow',
      subtitle: SPIKE_PALETTE_LABEL[key],
      arm: 'veil-glow',
      axes: { palette: key },
      howToCapture,
    })),
  ];
  await gridSheet({
    name: `blue-hand-candidates${kindSuffix(kind, '152')}.webp`,
    title: `Blue HAND candidates${kind === 'detail' ? ', 1:1 detail' : thumb ? ', 152 px thumbnail' : ''}`,
    subtitle: `Shipped display hex against each candidate, ${FIELD_HEX} play field, glyphs off — ${kindGloss(kind)}`,
    columns,
    kind,
    sizeKey: '152',
  });
}

/**
 * Any set of arms side by side on the narrowed boards: `SHEET_ARMS='<keys>'`
 * names the columns (every key an arm `spike-config.ts` has, with a gloss in
 * `ARM_SUBTITLE`), `SHEET_NAME` the output basename (default `arms`), and
 * `SHEET_SIZES` which `size-<n>` captures to lay out as thumbnail sheets beside
 * the full-size whole and detail ones (default none). The full-size shots come
 * from `BOARDS='…' capture-boards.sh <dir> <arms…>`, the thumbnail ones from the
 * same with `THUMBS=1 SIZES='…'`. This is how a tuning experiment — a bigger
 * glow, a stronger veil, a heavier fill — gets its own sheet without touching
 * the default matrix.
 */
async function armsSheetFigure(kind, sizeKey) {
  const armKeys = (process.env.SHEET_ARMS ?? '').split(/\s+/).filter((word) => word.length > 0);
  if (armKeys.length === 0) {
    throw new Error(`no capture at <SHEET_ARMS unset>\n  take it with: SHEET_ARMS='<arms>' build-figures.mjs`);
  }
  const arms = armKeys.map((key) => armOrDie(key, 'SHEET_ARMS'));
  const name = process.env.SHEET_NAME ?? 'arms';
  const howToCapture =
    kind === 'thumb'
      ? `THUMBS=1 SIZES='${sizeKey}' BOARDS='${BOARD_KEYS.join(' ')}' capture-boards.sh <dir> ${armKeys.join(' ')}`
      : `BOARDS='${BOARD_KEYS.join(' ')}' capture-boards.sh <dir> ${armKeys.join(' ')}`;
  await gridSheet({
    name: `${name}${kindSuffix(kind, sizeKey)}.webp`,
    title: `${name}${kind === 'detail' ? ', 1:1 detail' : kind === 'thumb' ? `, ${sizeKey} px` : ''}`,
    subtitle: `${armKeys.join(' · ')} — ${FIELD_HEX} play field, glyphs off — ${kindGloss(kind)}`,
    columns: arms.map((arm) => ({ title: arm.title, subtitle: arm.subtitle, arm: arm.key, axes: {}, howToCapture })),
    kind,
    sizeKey,
  });
}

// ---- run --------------------------------------------------------------------

for (const board of BOARDS) await perBoardFigure(board);
// Both leading arms get an every-board sheet: the glow is the one that wins on
// the most boards, the veil is the one that changes the most on the pale dense
// ones, and comparing them across seven boards at once is the whole point. A
// run narrowed with `ARMS=` to a subset that left one of them out skips that
// sheet, the way the optional sheets below skip, rather than dying on it.
for (const armKey of ['outward-glow', 'veil-glow']) {
  if (CAPTURED_ARMS.includes(armKey)) await allBoardsFigure(armKey);
  else console.log(`skipped all-boards-${armKey}.webp\n  ARMS='${CAPTURED_ARMS.join(' ')}' does not include it`);
}
// The sheets a given run may not have the captures for — the two dichromat ones
// want Grasshopper, the thumbnail ones want the `THUMBS=1` sweep. Skipped with
// the command that takes them rather than failing the whole run, so a narrowed
// run still produces the figures it can.
for (const sheet of [
  { name: 'colour-vision.webp', build: colourVisionFigure },
  { name: 'accessibility-glyphs.webp', build: accessibilityGlyphFigure },
  ...THUMBNAIL_SIZES.map((sizeKey) => ({
    name: `thumbnails-${sizeKey}px.webp`,
    build: () => thumbnailFigure(sizeKey),
  })),
  { name: 'blue-hand-candidates.webp', build: () => blueHandFigure('whole') },
  { name: 'blue-hand-candidates-detail.webp', build: () => blueHandFigure('detail') },
  { name: 'blue-hand-candidates-152px.webp', build: () => blueHandFigure('thumb') },
  { name: 'arms sheet (whole)', build: () => armsSheetFigure('whole') },
  { name: 'arms sheet (detail)', build: () => armsSheetFigure('detail') },
  ...(process.env.SHEET_SIZES ?? '')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((sizeKey) => ({ name: `arms sheet (${sizeKey} px)`, build: () => armsSheetFigure('thumb', sizeKey) })),
]) {
  try {
    await sheet.build();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('no capture at')) throw error;
    console.log(`skipped ${sheet.name}\n  ${error.message.split('\n').join('\n  ')}`);
  }
}
