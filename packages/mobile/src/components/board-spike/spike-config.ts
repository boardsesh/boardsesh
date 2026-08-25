import type { HoldState } from '@boardsesh/shared-schema';

/**
 * Fixed board + climb the rendering spike draws (issue #2202).
 *
 * Grasshopper Master 8x12 with Tweeners: 332 hold placements on the board photo
 * the issue was filed against, which is the density that makes the problem
 * visible. The climb is synthesised from real placements (a start pair, a hand
 * line up the wall, a finish, six feet) rather than pulled from the catalogue,
 * so the spike needs no network, no login and no seeded database.
 */
export const SPIKE_BOARD = {
  boardName: 'grasshopper',
  layoutId: 1,
  sizeId: 5,
  setIds: [1, 2, 3, 4, 6],
} as const;

export const SPIKE_FRAMES =
  'p85r1p121r1p58r2p96r2p333r2p114r2p396r2p138r2p103r2p466r3p50r4p126r4p47r4p155r4p81r4p116r4';

/** Which holds get a neutral outline: none, every placement, or only the ones near a lit hold. */
export type HaloScope = 'none' | 'all' | 'near';

/**
 * What that neutral outline is shaped like. `circle` is a ring at a fraction of
 * the placement radius — cheap, and what a renderer can draw from geometry
 * alone. `outline` follows the hold's real silhouette, traced out of the art's
 * alpha channel by `spike-hold-outlines.ts`. The difference matters most where
 * hold sizes differ most: a circle says nothing about whether the thing you are
 * looking for on the wall is a fingernail chip or a jug.
 */
export type HaloShape = 'circle' | 'outline';

/** How a lit hold is marked. */
export type SelectorStyle = 'ring' | 'glow' | 'shape' | 'glow-shape' | 'casing' | 'shape-glow' | 'tint';

export type SpikeTreatment = {
  key: string;
  label: string;
  /** Chip label — kept short so all six fit one row on a phone. */
  chip: string;
  /** One line on what this treatment is testing, shown under the board. */
  note: string;
  halos: HaloScope;
  /** Defaults to `circle` when absent. */
  haloShape?: HaloShape;
  selector: SelectorStyle;
};

export const SPIKE_TREATMENTS: readonly SpikeTreatment[] = [
  {
    key: 'baseline',
    chip: 'Base',
    label: 'Baseline',
    note: 'What ships today: stroke-only role rings, no outline on unlit holds.',
    halos: 'none',
    selector: 'ring',
  },
  {
    key: 'piece-halos',
    chip: 'Halos',
    label: 'Piece halos',
    note: 'A thin neutral outline on every placement, so each hold has a findable shape.',
    halos: 'all',
    selector: 'ring',
  },
  {
    key: 'glow-halos',
    chip: 'Glow',
    label: 'Glow halos',
    note: 'Role rings replaced by a fading halo — the hold reads as lit, like an LED behind it.',
    halos: 'all',
    selector: 'glow',
  },
  {
    key: 'local-halos',
    chip: 'Near',
    label: 'Neighbour halos',
    note: 'Neutral outlines only near lit holds, so the region you are looking at is the busy one.',
    halos: 'near',
    selector: 'ring',
  },
  {
    key: 'shape-coded',
    chip: 'Shape',
    label: 'Shape-coded',
    note: 'Role carried by outline shape: dashed start, wavy hand, spiky finish, plain foot.',
    halos: 'all',
    selector: 'shape',
  },
  {
    key: 'shaped-halos',
    chip: 'Traced',
    label: 'Traced halos',
    note: "The neutral outline follows each hold's real silhouette instead of a fixed circle.",
    halos: 'all',
    haloShape: 'outline',
    selector: 'ring',
  },
  {
    key: 'shaped-glow',
    chip: 'Trace+glow',
    label: 'Traced glow',
    note: 'Lit holds glow along their own outline, so the shape you are hunting for is the lit thing.',
    halos: 'all',
    haloShape: 'outline',
    selector: 'shape-glow',
  },
  {
    key: 'hold-tint',
    chip: 'Tint',
    label: 'Whole-hold tint',
    note: 'No ring at all: the lit hold itself takes the role hue, the way an LED behind it would.',
    halos: 'all',
    haloShape: 'outline',
    selector: 'tint',
  },
  {
    key: 'contrast-casing',
    chip: 'Casing',
    label: 'Contrast casing',
    note: 'Each ring gets a casing picked black-or-white from the art lightness under it.',
    halos: 'all',
    selector: 'casing',
  },
  {
    key: 'glow-shape',
    chip: 'Both',
    label: 'Glow + shape',
    note: 'Both redundancies at once: a fading halo for reach, a role shape for identity.',
    halos: 'all',
    selector: 'glow-shape',
  },
];

/**
 * Role palettes.
 *
 * `shipped` is HOLD_STATE_MAP's grasshopper displayColor. Measured in OkLab it
 * spans L 0.551 (HAND) to 0.778 (STARTING) — a 23-point lightness spread, which
 * is why the blue hand rings are the first thing to vanish into the board photo.
 * `equalL` lifts every role to L 0.70 and bisects chroma down to whatever still
 * fits sRGB (HAND keeps 63% of its chroma, FOOT 100%).
 */
export type SpikePaletteKey = 'shipped' | 'equalL';

export const SPIKE_PALETTES: Record<SpikePaletteKey, Record<string, string>> = {
  shipped: { STARTING: '#00DD00', HAND: '#4455FF', FINISH: '#FF0000', FOOT: '#FF00FF' },
  equalL: { STARTING: '#00C000', HAND: '#7B96FF', FINISH: '#FF6553', FOOT: '#FE00FE' },
};

export const SPIKE_PALETTE_LABEL: Record<SpikePaletteKey, string> = {
  shipped: 'L: shipped',
  equalL: 'L: equal',
};

/**
 * Play-field backgrounds. `field` is today's dark surface; the rest stand in for
 * the "let the user (or the gym) pick a background" idea in the issue.
 */
export const SPIKE_BACKGROUNDS = [
  { key: 'field', label: 'Field', color: '#181225' },
  { key: 'grey', label: 'Grey', color: '#3A3A3C' },
  { key: 'ink', label: 'Ink', color: '#0B0B0C' },
  { key: 'wood', label: 'Ply', color: '#6B4F33' },
] as const;

export type SpikeBackgroundKey = (typeof SPIKE_BACKGROUNDS)[number]['key'];

/** Neutral-outline and halo geometry, all as fractions of the placement radius. */
export const SPIKE_TUNING = {
  /**
   * Placements sit one radius apart on this board, so a neutral ring at the full
   * placement radius would draw a solid mesh. 0.58 keeps each ring inside its own
   * cell while still tracing roughly a hold's worth of area.
   */
  haloRadius: 0.58,
  haloStrokeWidth: 2.6,
  haloOpacity: 0.2,
  /** The `near` scope draws far fewer rings, so it can afford to be more visible. */
  nearHaloOpacity: 0.34,
  /** Centre distance (in placement radii) that counts as "next to a lit hold". */
  nearRadius: 2.3,
  glowRadius: 1.7,
  /** Renderer base stroke (6.0) times grasshopper's 1.35 board multiplier. */
  strokeWidth: 6 * 1.35,
  /**
   * Contrast casing: a stroke drawn under the role ring, wide enough to leave a
   * visible edge on both sides of it. Its colour flips at this OkLab lightness —
   * the same choice CSS `contrast-color()` makes, resolved offline against the
   * measured art rather than against a declared background colour.
   */
  casingWidthMultiplier: 2,
  casingOpacity: 0.7,
  casingLightnessThreshold: 0.5,
  /** Traced silhouettes are drawn thinner than the circular rings — they are longer. */
  outlineHaloStrokeWidth: 2.2,
  /**
   * Shape-following glow: the same traced path stroked repeatedly, wide and faint
   * to narrow and solid. SVG has no gradient that follows an arbitrary outline, so
   * the fade is built out of concentric strokes.
   */
  shapeGlowBands: [
    { width: 46, opacity: 0.1 },
    { width: 32, opacity: 0.2 },
    { width: 20, opacity: 0.42 },
    { width: 10, opacity: 0.95 },
  ],
  /** Whole-hold tint: fill opacity over the hold, plus a crisp edge on its outline. */
  tintFillOpacity: 0.55,
  tintEdgeWidth: 4,
} as const;

export type SpikeLitHold = {
  id: number;
  cx: number;
  cy: number;
  radius: number;
  role: HoldState;
};
