/**
 * Build the #2202 review figures from a directory of device captures.
 *
 *   node --import tsx packages/mobile/scripts/spike/build-figures.mjs <captures-dir> <output-dir> [field-hex]
 *
 * Captures come from `capture-boards.sh`, one full-screen PNG per
 * board × treatment. This crops each to the board itself (found by scanning for
 * the play-field colour, so it works whatever a board's aspect ratio is),
 * labels it, and writes:
 *
 *   board-<key>.webp            four treatments side by side, one board
 *   all-boards-outward-glow.webp the leading treatment on every board
 *   colour-vision.webp          protan/deutan simulation, baseline vs glyphs
 *
 * See docs/spike/board-rendering-2202/HANDOVER.md.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(path.resolve(import.meta.dirname, '../../../../package.json'));
const sharp = require('sharp');

const SHOTS = process.argv[2];
const OUT = process.argv[3];
/**
 * The play field the spike screen paints behind the board — how the crop finds
 * the board, so it has to be the colour the capture was taken on. Defaults to
 * the dark field; pass the hex of `SPIKE_BACKGROUNDS` grey, ink or ply to crop
 * a run captured with `FIELDS=…`.
 */
const FIELD_HEX = process.argv[4] ?? '#181225';
if (!SHOTS || !OUT || !/^#?[0-9a-fA-F]{6}$/.test(FIELD_HEX)) {
  console.error('usage: build-figures.mjs <captures-dir> <output-dir> [field-hex, default #181225]');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const FONT = 'Liberation Sans, DejaVu Sans, sans-serif';
const INK = '#0C0A11';
const FIELD = [0, 2, 4].map((offset) => parseInt(FIELD_HEX.replace('#', '').slice(offset, offset + 2), 16));
const GAP = 16;
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BOARDS = [
  {
    key: 'grasshopper-master',
    label: 'Grasshopper Master 8x12',
    note: '11.6% of holds sit within 0.18 OkLab L of the play field — every-hold outline ON',
  },
  {
    key: 'tension-classic',
    label: 'Tension Original Full Wall',
    note: '6.2% low-contrast holds — every-hold outline ON (marginal)',
  },
  {
    key: 'tension-mirror-12x12',
    label: 'Tension Board 2 Mirror 12x12',
    note: '0.0% low-contrast holds — every-hold outline OFF',
  },
  {
    key: 'kilter-homewall-10x12',
    label: 'Kilter Homewall 10x12',
    note: '0.2% low-contrast holds — every-hold outline OFF',
  },
  {
    key: 'kilter-original-12x12',
    label: 'Kilter Original 12x12',
    note: '0.2% low-contrast holds — every-hold outline OFF',
  },
  {
    key: 'moonboard-2016',
    label: 'MoonBoard 2016',
    note: '34.6% low-contrast holds, the worst here — every-hold outline ON',
  },
  {
    key: 'moonboard-masters-2019',
    label: 'MoonBoard Masters 2019',
    note: '24.0% low-contrast holds — every-hold outline ON',
  },
];

/**
 * The captured arm set, and it has to stay the same four keys as
 * `capture-boards.sh`'s TREATMENTS default and the first four entries of
 * `SPIKE_TREATMENTS` in `spike-config.ts` — every panel here reads a file named
 * `<board>__<key>.png`, so a key this list has and the capture run does not
 * throws, and a key the capture run has and this list does not is shot and then
 * silently dropped under the remaining captions.
 *
 * Baseline is the control rather than literally what ships: it carries the LED
 * layer like the other three, so the only thing that varies across a row is the
 * mark on the lit holds.
 */
const TREATMENTS = [
  { key: 'baseline', title: 'Baseline', subtitle: 'Control: a fixed circle, LED layer on' },
  { key: 'outward-glow', title: 'Outward glow', subtitle: 'Light off the edge, hold surface left clean' },
  { key: 'glow-tint', title: 'Glow + tint', subtitle: 'Fill for shape, glow for reach, role glyph' },
  { key: 'veil-glow', title: 'Veil + glow', subtitle: 'Unlit wall washed down in the field colour' },
];

/** The spike screen paints the play field behind the board, so its rows are the board. */
async function boardRect(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const x = 3;
  let top = null;
  let bottom = null;
  for (let y = 0; y < info.height; y += 1) {
    const offset = (y * info.width + x) * info.channels;
    if (data[offset] === FIELD[0] && data[offset + 1] === FIELD[1] && data[offset + 2] === FIELD[2]) {
      if (top === null) top = y;
      bottom = y;
    }
  }
  if (top === null) {
    throw new Error(`no ${FIELD_HEX} rows in ${file} — pass the field the capture was taken on as the third argument`);
  }
  return { left: 0, top, width: info.width, height: bottom - top + 1 };
}

function strip(width, height, title, subtitle, titleSize, subSize) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${INK}"/>
      <text x="0" y="${titleSize}" font-family="${FONT}" font-size="${titleSize}" font-weight="bold" fill="#F5F2FB">${escape(title)}</text>
      ${subtitle ? `<text x="0" y="${titleSize + subSize + 8}" font-family="${FONT}" font-size="${subSize}" fill="#A9A2B6">${escape(subtitle)}</text>` : ''}
    </svg>`,
  );
}

const header = (width, title, subtitle) =>
  Buffer.from(
    `<svg width="${width}" height="96" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="96" fill="${INK}"/>
      <text x="0" y="40" font-family="${FONT}" font-size="40" font-weight="bold" fill="#F5F2FB">${escape(title)}</text>
      <text x="0" y="76" font-family="${FONT}" font-size="24" fill="#A9A2B6">${escape(subtitle)}</text>
    </svg>`,
  );

async function perBoardFigure(board) {
  const PANEL = 460;
  const TITLE = 24;
  const SUB = 17;
  const panels = [];
  for (const treatment of TREATMENTS) {
    const file = path.join(SHOTS, `${board.key}__${treatment.key}.png`);
    panels.push(
      await sharp(file)
        .extract(await boardRect(file))
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

async function allBoardsFigure(treatmentKey) {
  const COLUMN = 360;
  const panels = [];
  for (const board of BOARDS) {
    const file = path.join(SHOTS, `${board.key}__${treatmentKey}.png`);
    panels.push({
      board,
      image: await sharp(file)
        .extract(await boardRect(file))
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
        'Outward glow, every board',
        `Same synthesised climb, shipped art, ${FIELD_HEX} play field`,
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
    .toFile(path.join(OUT, `all-boards-${treatmentKey}.webp`));
  console.log(`wrote all-boards-${treatmentKey}.webp`);
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

async function simulate(file, kind, region, width) {
  const { data, info } = await sharp(file).extract(region).raw().toBuffer({ resolveWithObject: true });
  const matrix = MATRICES[kind];
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += info.channels) {
    const r = toLinear(data[i]);
    const g = toLinear(data[i + 1]);
    const b = toLinear(data[i + 2]);
    out[i] = toSrgb(matrix[0] * r + matrix[1] * g + matrix[2] * b);
    out[i + 1] = toSrgb(matrix[3] * r + matrix[4] * g + matrix[5] * b);
    out[i + 2] = toSrgb(matrix[6] * r + matrix[7] * g + matrix[8] * b);
    if (info.channels === 4) out[i + 3] = data[i + 3];
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .resize(width)
    .png()
    .toBuffer();
}

async function colourVisionFigure() {
  const REGION = { left: 60, top: 1150, width: 960, height: 700 };
  const WIDTH = 620;
  const panels = [
    {
      file: 'grasshopper-master__baseline.png',
      kind: 'protanopia',
      title: 'Baseline, protanopia',
      sub: 'HAND blue and FOOT magenta are one colour',
    },
    {
      file: 'grasshopper-master__outward-glow.png',
      kind: 'protanopia',
      title: 'Outward glow + role glyph, protanopia',
      sub: 'FOOT a dot, START a bar, HAND a vertical bar, FINISH an X',
    },
    { file: 'grasshopper-master__baseline.png', kind: 'deuteranopia', title: 'Baseline, deuteranopia', sub: '' },
    {
      file: 'grasshopper-master__outward-glow.png',
      kind: 'deuteranopia',
      title: 'Outward glow + role glyph, deuteranopia',
      sub: '',
    },
  ];
  const images = [];
  for (const panel of panels) images.push(await simulate(path.join(SHOTS, panel.file), panel.kind, REGION, WIDTH));
  const meta = await sharp(images[0]).metadata();
  const labelHeight = 24 + 17 + 18;
  const composites = [
    {
      input: header(
        WIDTH * 2 + GAP,
        'Colour-vision check: role by hue alone vs role by glyph',
        'Grasshopper, Viénot 1999 dichromat transform',
      ),
      left: GAP,
      top: GAP,
    },
  ];
  panels.forEach((panel, index) => {
    const left = GAP + (index % 2) * (meta.width + GAP);
    const top = GAP + 96 + GAP + Math.floor(index / 2) * (labelHeight + 8 + meta.height + GAP);
    composites.push({ input: strip(meta.width, labelHeight, panel.title, panel.sub, 24, 17), left, top });
    composites.push({ input: images[index], left, top: top + labelHeight + 8 });
  });
  await sharp({
    create: {
      width: GAP + 2 * (meta.width + GAP),
      height: GAP + 96 + GAP + 2 * (labelHeight + 8 + meta.height + GAP),
      channels: 4,
      background: INK,
    },
  })
    .composite(composites)
    .webp({ quality: 88 })
    .toFile(path.join(OUT, 'colour-vision.webp'));
  console.log('wrote colour-vision.webp');
}

for (const board of BOARDS) await perBoardFigure(board);
await allBoardsFigure('outward-glow');
await colourVisionFigure();
