// Renders design/velvet-send-design-tokens-v1.png from the Velvet Send tokens.
//
// Headless renderer for the design-tokens reference sheet. The editable source
// of record is ./velvet-send-design-tokens.jsx (a React canvas artifact); this
// script re-expresses the same content as a native SVG so it can be rasterised
// offline with sharp (the repo's standard rasteriser) — no browser required.
//
// All token values mirror docs/ai-design-guidelines.md / packages/mobile/src/theme.
// Regenerate:  node design/render-velvet-send-tokens.mjs

import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- token data (source: docs/ai-design-guidelines.md) ----------
const brand = {
  light: {
    tint: '#6D28D9',
    fill: '#6D28D9',
    onPrimary: '#FFFFFF',
    accent: '#FF8A3D',
    success: '#047857',
    warning: '#B45309',
    error: '#C81E1E',
  },
  dark: {
    tint: '#A78BFA',
    fill: '#7C3AED',
    onPrimary: '#FFFFFF',
    accent: '#FF8A3D',
    success: '#34D399',
    warning: '#FBBF24',
    error: '#F87171',
  },
};

const surfaces = {
  light: {
    background: '#F4F1FB',
    secondaryBackground: '#FFFFFF',
    elevatedSurface: '#FFFFFF',
    label: '#16111F',
    secondaryLabel: '#5B5563',
    tertiaryLabel: '#8E8898',
    separator: 'rgba(60,55,75,0.18)',
    fill: 'rgba(109,40,217,0.10)',
    accent: '#6D28D9',
  },
  dark: {
    background: '#0F0B16',
    secondaryBackground: '#181225',
    elevatedSurface: '#221A32',
    label: '#F5F2FB',
    secondaryLabel: '#A9A2B6',
    tertiaryLabel: '#6E687C',
    separator: 'rgba(180,168,205,0.20)',
    fill: 'rgba(199,184,232,0.12)',
    accent: '#A78BFA',
  },
};

// Logo V-grade purples the violet brand is anchored on (V11–V16 family).
const mark = [
  { v: 'V11', hex: '#9C27B0', role: 'top-left — brightest' },
  { v: 'V12', hex: '#7B1FA2', role: 'top-right' },
  { v: 'V13', hex: '#6A1B9A', role: 'bottom-left' },
  { v: 'V15', hex: '#4A148C', role: 'bottom-right — deepest' },
];

// Canonical V-grade ramp — source: packages/board-constants/src/grade-colors.ts
// (V_GRADE_COLORS). The only palette shared between web and mobile. ★ = logo range.
const grades = [
  ['V0', '#FFD400', 'golden yellow'],
  ['V1', '#FFB300', 'amber'],
  ['V2', '#FF9100', 'orange'],
  ['V3', '#FF6D2E', 'deep orange'],
  ['V4', '#FF5026', 'red-orange'],
  ['V5', '#F03E3E', 'red'],
  ['V6', '#E22A2A', 'red'],
  ['V7', '#CF1F3C', 'crimson'],
  ['V8', '#B81A5A', 'raspberry'],
  ['V9', '#9E1A78', 'magenta'],
  ['V10', '#7E1C8E', 'grape · bridge'],
  ['V11', '#9C27B0', '★ logo'],
  ['V12', '#7B1FA2', '★ logo'],
  ['V13', '#6A1B9A', '★ logo'],
  ['V14', '#5C1A87', 'logo'],
  ['V15', '#4A148C', '★ logo'],
  ['V16', '#38006B', 'logo'],
  ['V17', '#2A0054', 'darkest'],
];

const typeScale = [
  ['largeTitle', 34, 700, 41, 28, 400, 36],
  ['title1', 28, 700, 34, 24, 400, 32],
  ['title2', 22, 700, 28, 22, 400, 28],
  ['title3', 20, 600, 25, 22, 500, 28],
  ['headline', 17, 600, 22, 16, 500, 24],
  ['body', 17, 400, 22, 16, 400, 24],
  ['callout', 16, 400, 21, 16, 400, 24],
  ['subheadline', 15, 400, 20, 14, 400, 20],
  ['footnote', 13, 400, 18, 12, 400, 16],
  ['caption1', 12, 400, 16, 11, 500, 16],
  ['caption2', 11, 400, 13, 11, 500, 16],
];

const spacingScale = [
  ['0', 0],
  ['1', 4],
  ['2', 8],
  ['3', 12],
  ['4', 16],
  ['5', 20],
  ['6', 24],
  ['8', 32],
  ['10', 40],
  ['12', 48],
  ['16', 64],
];
const radiiScale = [
  ['none', 0],
  ['sm', 4],
  ['md', 8],
  ['lg', 12],
  ['xl', 16],
  ['full', 28],
]; // 'full' drawn as a pill
const shadowScale = [
  ['xs', 1, 0.05, 1],
  ['sm', 1, 0.1, 2],
  ['md', 4, 0.1, 4],
  ['lg', 10, 0.1, 8],
  ['xl', 20, 0.1, 12],
];

const changelog = [
  ['CANON', 'Velvet Send', 'brand', 'Now the canonical design language — sourced from packages/mobile/src/theme.'],
  [
    'ADD',
    'brand.tint / primary',
    '#6D28D9 · #A78BFA',
    'Violet brand foreground (text, icons, links). Lifts to #A78BFA in dark.',
  ],
  [
    'ADD',
    'brand.primaryFill',
    '#6D28D9 · #7C3AED',
    'Filled-surface brand. Brighter #7C3AED in dark so white text clears AA.',
  ],
  ['ADD', 'brand.accent', '#FF8A3D', 'Warm amber spark — fill-only, always pair with dark text.'],
  [
    'VARIANT',
    'Liquid Glass / Material 3',
    '—',
    'One palette, two render variants. Resolved per device; users can override.',
  ],
  ['LEGACY', 'web rose/sage', '#8C4A52', 'packages/web still on the old palette — pending migration, not a peer.'],
  ['SHARED', 'grade colours', '—', 'Only @boardsesh/board-constants grade colours are shared web↔mobile.'],
];

// ---------- sheet theme (rendered in the dark Velvet Send surface tokens) ----------
const W = 1680,
  S = 2,
  P = 72,
  CW = W - 2 * P;
const C = {
  bg: surfaces.dark.background,
  panel: '#181225',
  panelBd: 'rgba(180,168,205,0.14)',
  swatchBd: 'rgba(180,168,205,0.16)',
  ink: surfaces.dark.label,
  muted: surfaces.dark.secondaryLabel,
  faint: surfaces.dark.tertiaryLabel,
  rule: 'rgba(180,168,205,0.16)',
};
const F = {
  disp: "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  body: "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "Menlo, 'SF Mono', monospace",
};

// ---------- svg builder ----------
let y = 0;
let clipId = 0;
const out = [];
const push = (s) => out.push(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function text(x, baseline, str, { f = F.body, size = 15, weight = 400, fill = C.ink, ls = 0, anchor = 'start' } = {}) {
  push(
    `<text x="${x}" y="${baseline}" font-family="${f}" font-size="${size}" font-weight="${weight}" fill="${fill}" letter-spacing="${ls}" text-anchor="${anchor}">${esc(str)}</text>`,
  );
}
function rect(x, ry, w, h, r, { fill = 'none', stroke = 'none', sw = 1 } = {}) {
  push(
    `<rect x="${x}" y="${ry}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`,
  );
}

// Naive word-wrap; returns array of lines that fit within maxW at the given size.
function wrap(str, maxW, size, factor = 0.52) {
  const cw = size * factor;
  const max = Math.max(1, Math.floor(maxW / cw));
  const words = str.split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > max && cur) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
function paragraph(x, baseline, str, { size = 15, fill = C.muted, lh = 22, maxW = CW } = {}) {
  const lines = wrap(str, maxW, size);
  lines.forEach((ln, i) => text(x, baseline + i * lh, ln, { size, fill }));
  return lines.length * lh;
}

function sectionHead(eyebrow, title, desc, { descMax = 980 } = {}) {
  text(P, y, eyebrow.toUpperCase(), { f: F.mono, size: 12, fill: C.faint, ls: 2.6 });
  y += 30;
  text(P, y + 24, title, { f: F.disp, size: 30, weight: 800, fill: C.ink, ls: -0.4 });
  y += 24 + 22;
  const ph = paragraph(P, y + 14, desc, { size: 15, fill: C.muted, lh: 23, maxW: descMax });
  y += 14 + ph + 30;
}

function rule() {
  y += 18;
  push(`<rect x="${P}" y="${y}" width="${CW}" height="1" fill="${C.rule}" />`);
  y += 42;
}

// A solid colour swatch with caption lines underneath. Returns its full height.
function swatch(x, yTop, w, hex, { name, sub, onSwatch, cardH = 116 } = {}) {
  const isLight = luminance(hex) > 0.6;
  rect(x, yTop, w, cardH, 12, { fill: hex, stroke: C.swatchBd, sw: 1 });
  if (onSwatch) {
    text(x + 14, yTop + cardH - 14, onSwatch.toUpperCase(), {
      f: F.mono,
      size: 11,
      ls: 1.4,
      fill: isLight ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.85)',
    });
  }
  let cy = yTop + cardH + 22;
  if (name) {
    text(x, cy, name, { f: F.mono, size: 13, fill: C.ink });
    cy += 19;
  }
  text(x, cy, hex.toUpperCase(), { f: F.mono, size: 12, fill: C.muted });
  cy += 18;
  let h = cardH + 22 + (name ? 19 : 0) + 18;
  if (sub) {
    const sh = paragraph(x, cy, sub, { size: 12, fill: C.faint, lh: 16, maxW: w });
    h += sh;
  }
  return h;
}

// A split swatch showing a light/dark token pair. Returns its full height.
function pairSwatch(x, yTop, w, lightHex, darkHex, { name, sub, cardH = 116 } = {}) {
  const id = `clip${clipId++}`;
  push(`<clipPath id="${id}"><rect x="${x}" y="${yTop}" width="${w}" height="${cardH}" rx="12" /></clipPath>`);
  push(`<g clip-path="url(#${id})">`);
  push(`<rect x="${x}" y="${yTop}" width="${w / 2}" height="${cardH}" fill="${lightHex}" />`);
  push(`<rect x="${x + w / 2}" y="${yTop}" width="${w / 2}" height="${cardH}" fill="${darkHex}" />`);
  push('</g>');
  rect(x, yTop, w, cardH, 12, { fill: 'none', stroke: C.swatchBd, sw: 1 });
  text(x + 12, yTop + cardH - 12, 'LIGHT', {
    f: F.mono,
    size: 10,
    ls: 1.2,
    fill: luminance(lightHex) > 0.6 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.8)',
  });
  text(x + w / 2 + 12, yTop + cardH - 12, 'DARK', {
    f: F.mono,
    size: 10,
    ls: 1.2,
    fill: luminance(darkHex) > 0.6 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.8)',
  });
  let cy = yTop + cardH + 22;
  if (name) {
    text(x, cy, name, { f: F.mono, size: 13, fill: C.ink });
    cy += 19;
  }
  text(x, cy, `${lightHex.toUpperCase()}  ·  ${darkHex.toUpperCase()}`, { f: F.mono, size: 12, fill: C.muted });
  cy += 18;
  let h = cardH + 22 + (name ? 19 : 0) + 18;
  if (sub) h += paragraph(x, cy, sub, { size: 12, fill: C.faint, lh: 16, maxW: w });
  return h;
}

function luminance(hex) {
  if (typeof hex !== 'string' || hex[0] !== '#' || hex.length < 7) return 0.5; // rgba()/unknown → assume mid
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Surface tokens are a mix of #hex and rgba(); pass through unchanged for fills.
const hexish = (v) => v;

// Lays out cards across `cols` columns starting at current y; advances y.
function grid(items, render, { cols = 3, gap = 22, cardH = 116 }) {
  const cw = (CW - (cols - 1) * gap) / cols;
  let rowH = 0;
  items.forEach((item, i) => {
    const col = i % cols;
    if (col === 0 && i > 0) {
      y += rowH + 26;
      rowH = 0;
    }
    const x = P + col * (cw + gap);
    const h = render(item, x, y, cw, cardH);
    rowH = Math.max(rowH, h);
  });
  y += rowH;
}

// The four-phone mark, drawn small.
function tile(x, yTop, size) {
  const id = `tile${clipId++}`;
  const gap = size * 0.022;
  const inner = (size - gap) / 2;
  push(
    `<clipPath id="${id}"><rect x="${x}" y="${yTop}" width="${size}" height="${size}" rx="${size * 0.225}" /></clipPath>`,
  );
  push(`<g clip-path="url(#${id})">`);
  push(`<rect x="${x}" y="${yTop}" width="${size}" height="${size}" fill="#000" />`);
  const cells = [
    [0, 0, '#9C27B0'],
    [inner + gap, 0, '#7B1FA2'],
    [0, inner + gap, '#6A1B9A'],
    [inner + gap, inner + gap, '#4A148C'],
  ];
  for (const [cx, cy, hex] of cells)
    push(`<rect x="${x + cx}" y="${yTop + cy}" width="${inner}" height="${inner}" fill="${hex}" />`);
  push('</g>');
}

// ---------- compose ----------
// Header
text(P, y + 14, 'VELVET SEND · DESIGN TOKENS · v1', { f: F.mono, size: 12, fill: C.faint, ls: 2.8 });
text(P, y + 78, 'Color & token reference', { f: F.disp, size: 58, weight: 800, fill: C.ink, ls: -1.4 });
paragraph(
  P,
  y + 124,
  'The single visual reference for Velvet Send — the violet design language in packages/mobile, anchored on the logo’s V11–V16 grade purples. One palette renders through two platform variants: Liquid Glass on iOS 26, Material 3 everywhere else. Values mirror docs/ai-design-guidelines.md.',
  { size: 15.5, fill: C.muted, lh: 24, maxW: 1060 },
);
tile(W - P - 200, y, 200);
y += 234;
push(`<rect x="${P}" y="${y}" width="${CW}" height="1" fill="rgba(180,168,205,0.22)" />`);
y += 56;

// 01 Brand colours
sectionHead(
  '01 — Brand colours',
  'Violet identity, light + dark',
  'Read brand colours from useTheme().brandColors — the provider resolves the right set per scheme. Foreground (tint/primary) and filled-surface (primaryFill) are different values in dark mode: the tint lifts to #A78BFA for legibility on near-black, while filled buttons use a brighter #7C3AED so white text still clears WCAG AA (5.70:1).',
);
grid(
  [
    {
      l: brand.light.tint,
      d: brand.dark.tint,
      name: 'tint / primary',
      sub: 'Brand foreground: text, icons, links, borders',
    },
    { l: brand.light.fill, d: brand.dark.fill, name: 'primaryFill', sub: 'Filled surface / button background' },
    { single: '#FFFFFF', name: 'onPrimary', sub: 'Text + icon sitting on primaryFill' },
    { single: brand.light.accent, name: 'accent', sub: 'Amber spark — fill-only, pair with dark text', on: 'amber' },
  ],
  (it, x, yy, w) =>
    it.single
      ? swatch(x, yy, w, it.single, { name: it.name, sub: it.sub, onSwatch: it.on })
      : pairSwatch(x, yy, w, it.l, it.d, { name: it.name, sub: it.sub }),
  { cols: 4 },
);
rule();

// 02 The mark
sectionHead(
  '02 — The mark',
  'Four V-grade purples from the logo',
  'The brand violet is drawn from the logo’s upper-grade purple cluster (V11–V16) — the project-zone grades a climber works toward. The product tint #6D28D9 sits in this family. The four-quadrant mark stays readable down to favicon scale.',
  { descMax: 900 },
);
tile(P, y, 240);
{
  const gx = P + 240 + 44;
  const gw = CW - 240 - 44;
  const cw = (gw - 22) / 2;
  mark.forEach((m, i) => {
    const col = i % 2,
      row = Math.floor(i / 2);
    swatch(gx + col * (cw + 22), y + row * 150, cw, m.hex, {
      name: `grades.${m.v.toLowerCase()}`,
      sub: m.role,
      cardH: 96,
    });
  });
  y += 240;
}
rule();

// 03 V-grade scale
sectionHead(
  '03 — V-grade scale',
  'The shared climbing-grade ramp',
  'Grade colours live in @boardsesh/board-constants (V_GRADE_COLORS) and are the only palette shared between web and mobile. A yellow→red→purple arc that ends on the logo’s V11–V16 purples (★) — the violet brand grows out of this top end.',
);
{
  const n = grades.length;
  const gap = 6;
  const bw = (CW - (n - 1) * gap) / n;
  grades.forEach(([v, hex], i) => {
    const x = P + i * (bw + gap);
    rect(x, y, bw, 96, 5, { fill: hex });
    text(x + bw / 2, y + 96 - 11, v, {
      f: F.mono,
      size: 11,
      fill: luminance(hex) > 0.55 ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)',
      anchor: 'middle',
    });
  });
  y += 96 + 28;
  const cols = 6,
    lgap = 18;
  const cw = (CW - (cols - 1) * lgap) / cols;
  grades.forEach(([v, hex, note], i) => {
    const col = i % cols,
      row = Math.floor(i / cols);
    const x = P + col * (cw + lgap),
      yy = y + row * 30;
    rect(x, yy - 11, 14, 14, 3, { fill: hex, stroke: C.swatchBd, sw: 1 });
    text(x + 24, yy, v, { f: F.mono, size: 12, fill: C.ink });
    text(x + 64, yy, hex.toUpperCase(), { f: F.mono, size: 11, fill: C.muted });
    text(x + 162, yy, note, { f: F.mono, size: 10, fill: C.faint });
  });
  y += Math.ceil(n / cols) * 30;
}
rule();

// 04 Semantic
sectionHead(
  '04 — Semantic colours',
  'Status tones, light + dark',
  'Success, warning and error brighten in dark mode so they stay legible on the near-black surface ladder. Same role keys across both schemes.',
);
grid(
  [
    { l: brand.light.success, d: brand.dark.success, name: 'success', sub: 'Logged climb, confirmation' },
    { l: brand.light.warning, d: brand.dark.warning, name: 'warning', sub: 'Caution, non-blocking warnings' },
    { l: brand.light.error, d: brand.dark.error, name: 'error', sub: 'Destructive, validation errors' },
  ],
  (it, x, yy, w) => pairSwatch(x, yy, w, it.l, it.d, { name: it.name, sub: it.sub }),
  { cols: 3 },
);
rule();

// 04 System surfaces
sectionHead(
  '05 — System surfaces & labels',
  'Backgrounds, text and chrome',
  'Resolved by platform and variant via useTheme().systemColors. iOS Liquid Glass uses Apple PlatformColor (adapts natively); Android and Material use these explicit, violet-tinted hexes. Same keys in every case.',
);
const surfKeys = [
  ['background', 'Screen base'],
  ['secondaryBackground', 'Cards, sheets'],
  ['elevatedSurface', 'Raised tile'],
  ['label', 'Primary text'],
  ['secondaryLabel', 'Secondary text'],
  ['tertiaryLabel', 'Tertiary text'],
  ['separator', 'Hairlines'],
  ['fill', 'Faint violet track'],
  ['accent', 'Links, active tab'],
];
text(P, y, 'LIGHT', { f: F.mono, size: 11, fill: C.faint, ls: 2 });
y += 22;
grid(surfKeys, ([k, sub], x, yy, w) => swatch(x, yy, w, hexish(surfaces.light[k]), { name: k, sub, cardH: 78 }), {
  cols: 3,
});
y += 34;
text(P, y, 'DARK', { f: F.mono, size: 11, fill: C.faint, ls: 2 });
y += 22;
grid(surfKeys, ([k, sub], x, yy, w) => swatch(x, yy, w, hexish(surfaces.dark[k]), { name: k, sub, cardH: 78 }), {
  cols: 3,
});
rule();

// 05 Typography
sectionHead(
  '06 — Typography',
  'Apple HIG (Liquid Glass) vs Material 3',
  'Two scales, same keys, resolved per variant via theme.textStyles. System font only (San Francisco / Roboto). HIG keeps bold display weights for brand identity; M3 drops them to regular. Spec format: size / weight / line-height.',
);
{
  const colW = CW / 2 - 20;
  text(P, y, 'LIQUID GLASS · HIG', { f: F.mono, size: 11, fill: C.faint, ls: 1.8 });
  text(P + CW / 2 + 20, y, 'MATERIAL 3', { f: F.mono, size: 11, fill: C.faint, ls: 1.8 });
  y += 26;
  for (const [key, hs, hw, hl, ms, mw, ml] of typeScale) {
    const rowH = Math.max(hl, ml) + 14;
    const baseHig = y + Math.min(hs, 30) * 0.8 + 4;
    text(P, baseHig, key, { f: F.disp, size: Math.min(hs, 30), weight: hw, fill: C.ink, ls: -0.3 });
    text(P + colW, baseHig, `${hs}/${hw}/${hl}`, { f: F.mono, size: 12, fill: C.faint, anchor: 'end' });
    text(P + CW / 2 + 20, baseHig, key, { f: F.disp, size: Math.min(ms, 30), weight: mw, fill: C.ink, ls: -0.3 });
    text(P + CW, baseHig, `${ms}/${mw}/${ml}`, { f: F.mono, size: 12, fill: C.faint, anchor: 'end' });
    y += rowH;
    push(`<rect x="${P}" y="${y - 7}" width="${CW}" height="1" fill="rgba(180,168,205,0.07)" />`);
  }
}
rule();

// 06 Spacing, radii, shadows
sectionHead(
  '07 — Spacing · radii · shadows',
  'Geometry tokens',
  'A 4pt spacing grid, six base radii (the button corner is the one value that differs by variant — 10dp Liquid Glass, 20dp Material), and a five-step shadow ladder carrying both iOS shadow and Android elevation.',
);
{
  // spacing bars
  text(P, y, 'SPACING', { f: F.mono, size: 11, fill: C.faint, ls: 2 });
  y += 28;
  const sx = P;
  spacingScale.forEach(([k, v], i) => {
    const ry = y + i * 30;
    rect(sx, ry, Math.max(v, 2), 14, 2, { fill: brand.dark.tint });
    text(sx + 80, ry + 12, `spacing.${k}`, { f: F.mono, size: 12, fill: C.ink });
    text(sx + 200, ry + 12, `${v}px`, { f: F.mono, size: 12, fill: C.muted });
  });
  // radii samples (right column)
  const rx0 = P + CW / 2 + 20;
  text(rx0, y - 28, 'RADII', { f: F.mono, size: 11, fill: C.faint, ls: 2 });
  radiiScale.forEach(([k, r], i) => {
    const col = i % 3,
      row = Math.floor(i / 3);
    const bx = rx0 + col * 150,
      by = y + row * 140;
    const isPill = k === 'full';
    rect(bx, by, isPill ? 120 : 96, 96, isPill ? 48 : r, { fill: 'none', stroke: brand.dark.tint, sw: 2 });
    text(bx, by + 96 + 22, k === 'full' ? 'full (pill)' : `${k} · ${r}`, { f: F.mono, size: 12, fill: C.muted });
  });
  y += spacingScale.length * 30 + 24;
}
{
  text(P, y, 'SHADOWS', { f: F.mono, size: 11, fill: C.faint, ls: 2 });
  y += 26;
  shadowScale.forEach(([k, dy, op, el], i) => {
    text(P + i * 0, y + i * 22, `shadow.${k}`, { f: F.mono, size: 12, fill: C.ink });
    text(P + 140, y + i * 22, `iOS y${dy} · opacity ${op}`, { f: F.mono, size: 12, fill: C.muted });
    text(P + 420, y + i * 22, `Android elevation ${el}`, { f: F.mono, size: 12, fill: C.faint });
  });
  y += shadowScale.length * 22;
}
rule();

// 07 Variants
sectionHead(
  '08 — The two variants',
  'Liquid Glass and Material 3',
  'Same palette and component APIs; the chrome follows the platform. A control is the same product in both, drawn the way that platform draws controls. Users on iOS 26 get Liquid Glass by default; everyone else gets Material 3, and either can be chosen explicitly.',
);
{
  const pw = (CW - 28) / 2;
  const ph = 230;
  const panels = [
    {
      title: 'Liquid Glass',
      sub: 'iOS 26 — Apple HIG',
      btnR: 10,
      lines: [
        'Button corner — 10dp',
        'Sheet corners — soft (glass)',
        'Tab bar — 49pt',
        'Type — Apple HIG scale',
        'Motion — reanimated springs',
      ],
    },
    {
      title: 'Material 3',
      sub: 'Android / older iOS / fallback',
      btnR: 20,
      lines: [
        'Button corner — 20dp',
        'Sheet corners — 28dp',
        'Nav bar — 80dp + indicator pill',
        'Type — Material 3 scale',
        'Feedback — ripple',
      ],
    },
  ];
  panels.forEach((p, i) => {
    const x = P + i * (pw + 28);
    rect(x, y, pw, ph, 14, { fill: 'rgba(255,255,255,0.015)', stroke: C.panelBd, sw: 1 });
    text(x + 24, y + 38, p.title, { f: F.disp, size: 22, weight: 800, fill: C.ink });
    text(x + 24, y + 62, p.sub.toUpperCase(), { f: F.mono, size: 11, fill: C.faint, ls: 1.6 });
    // sample button
    rect(x + 24, y + 86, 200, 46, p.btnR, { fill: brand.dark.fill });
    text(x + 124, y + 86 + 29, 'Log ascent', { f: F.disp, size: 15, weight: 700, fill: '#FFFFFF', anchor: 'middle' });
    p.lines.forEach((ln, j) => text(x + 250, y + 100 + j * 26, ln, { f: F.mono, size: 12.5, fill: C.muted }));
  });
  y += ph;
}
rule();

// 08 Changelog / migration
sectionHead(
  '09 — What this establishes',
  'Velvet Send vs the legacy web palette',
  'Velvet Send replaces the old rose/sage web palette as the design language. Web hasn’t migrated yet — that palette is legacy, not a peer.',
);
{
  const kindColor = { CANON: '#A78BFA', ADD: '#34D399', VARIANT: '#60A5FA', LEGACY: '#FBBF24', SHARED: '#A9A2B6' };
  const cols = [P + 0, P + 130, P + 430, P + 720];
  text(cols[0], y, 'KIND', { f: F.mono, size: 11, fill: C.faint, ls: 1.4 });
  text(cols[1], y, 'TOKEN', { f: F.mono, size: 11, fill: C.faint, ls: 1.4 });
  text(cols[2], y, 'VALUE', { f: F.mono, size: 11, fill: C.faint, ls: 1.4 });
  text(cols[3], y, 'NOTE', { f: F.mono, size: 11, fill: C.faint, ls: 1.4 });
  y += 12;
  push(`<rect x="${P}" y="${y}" width="${CW}" height="1" fill="${C.rule}" />`);
  y += 26;
  changelog.forEach(([kind, token, value, note]) => {
    const kc = kindColor[kind] || C.muted;
    rect(cols[0], y - 14, 86, 22, 11, { fill: `${kc}1A`, stroke: `${kc}66`, sw: 1 });
    text(cols[0] + 12, y + 1, kind, { f: F.mono, size: 10, fill: kc, ls: 1 });
    text(cols[1], y + 1, token, { f: F.mono, size: 13, fill: C.ink });
    text(cols[2], y + 1, value, { f: F.mono, size: 12, fill: C.muted });
    const nh = paragraph(cols[3], y + 1, note, { size: 12.5, fill: C.muted, lh: 17, maxW: P + CW - cols[3] });
    y += Math.max(28, nh + 12);
  });
}

// footer
y += 30;
push(`<rect x="${P}" y="${y}" width="${CW}" height="1" fill="rgba(180,168,205,0.1)" />`);
y += 30;
text(P, y, 'Boardsesh · Velvet Send · design tokens · v1', { f: F.mono, size: 11, fill: C.faint });
text(W - P, y, 'Source: docs/ai-design-guidelines.md · packages/mobile/src/theme', {
  f: F.mono,
  size: 11,
  fill: C.faint,
  anchor: 'end',
});
y += 56;

// ---------- assemble + rasterise ----------
const H = Math.ceil(y);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * S}" height="${H * S}"><rect width="${W}" height="${H}" fill="${C.bg}" />${out.join('')}</svg>`;

const svgPath = join(HERE, 'velvet-send-design-tokens.svg');
const pngPath = join(HERE, 'velvet-send-design-tokens-v1.png');
writeFileSync(svgPath, svg);
await sharp(Buffer.from(svg)).png().toFile(pngPath);
// eslint-disable-next-line no-console
console.log(`rendered ${pngPath}  (${W * S}×${H * S})`);
