import type { HoldState } from '@boardsesh/shared-schema';

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

/** Three-state control: follow the per-board measurement, or force it either way. */
export type SpikeOverride = 'auto' | 'on' | 'off';

/** How a lit hold is marked. */
export type SelectorStyle =
  | 'ring'
  | 'glow'
  | 'shape'
  | 'glow-shape'
  | 'casing'
  | 'shape-glow'
  | 'shape-glow-out'
  | 'traced-ring'
  | 'glow-tint'
  | 'tint';

/**
 * Whether a treatment ever draws the neutral outline on UNLIT holds.
 *
 * `never` means the treatment is defined without it (the baseline, and the plain
 * traced outline). `auto` means it participates in the per-board decision in
 * `spike-boards.ts` — on for the boards whose holds actually vanish into the
 * field, off for the ones where every hold already contrasts. Review on Kilter
 * was blunt about this: an outline on 500 holds that already read is just noise.
 */
export type HaloPolicy = 'never' | 'auto';

export type SpikeTreatment = {
  key: string;
  label: string;
  /** Short label for the stepper caption and any compact control. */
  chip: string;
  /** One line on what this treatment is testing, shown under the board. */
  note: string;
  halos: HaloScope;
  /** Defaults to `never` when absent. */
  haloPolicy?: HaloPolicy;
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
    key: 'outward-glow',
    haloPolicy: 'auto',
    chip: 'Outward',
    label: 'Outward glow',
    note: 'The glow is clipped to outside the hold, so the light comes off the edge and the surface stays clean.',
    halos: 'all',
    haloShape: 'outline',
    selector: 'shape-glow-out',
  },
  {
    key: 'traced-ring',
    chip: 'Outline',
    label: 'Traced outline',
    note: "The lit hold's own silhouette in its role colour — no glow, no fill, nothing on unlit holds.",
    halos: 'none',
    haloShape: 'outline',
    selector: 'traced-ring',
  },
  {
    key: 'glow-tint',
    chip: 'Hybrid',
    label: 'Glow + tint',
    note: 'Lightness-normalised fill for shape, a crisp silhouette edge, and an outward glow for reach.',
    halos: 'all',
    haloPolicy: 'auto',
    haloShape: 'outline',
    selector: 'glow-tint',
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
    haloPolicy: 'auto',
    chip: 'Traced',
    label: 'Traced halos',
    note: "The neutral outline follows each hold's real silhouette instead of a fixed circle.",
    halos: 'all',
    haloShape: 'outline',
    selector: 'ring',
  },
  {
    key: 'shaped-glow',
    haloPolicy: 'auto',
    chip: 'Trace+glow',
    label: 'Traced glow',
    note: 'Lit holds glow along their own outline, so the shape you are hunting for is the lit thing.',
    halos: 'all',
    haloShape: 'outline',
    selector: 'shape-glow',
  },
  {
    key: 'hold-tint',
    haloPolicy: 'auto',
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
  /**
   * Traced silhouettes. First pass used 2.2px at 0.2 opacity and the answer from
   * review was "that's just the baseline" — a hairline at a fifth opacity, drawn
   * at board resolution and then scaled down to a phone, is not a visible
   * treatment. Weight and opacity both up until it reads as a decision.
   */
  outlineHaloStrokeWidth: 4,
  outlineHaloOpacity: 0.55,
  /**
   * A dark outline on pale art needs more weight than a light one on dark art to
   * read as the same strength, because the surrounding play field is dark either
   * way and a black line has less to separate it from.
   */
  outlineHaloDarkOpacity: 0.7,
  /**
   * Shape-following glow, built out of concentric strokes along the traced
   * outline from `glowSpreadWidth` down to `glowCoreWidth`.
   *
   * The obvious implementation — one wide stroke through an `FeGaussianBlur` —
   * does not work: react-native-svg's Android backend paints the filter region
   * as a solid rectangle of the stroke colour instead of blurring it (verified
   * on device, react-native-svg 15.15.5). `FeColorMatrix` in the same version is
   * fine, which is what the desaturate toggle uses, so this is a gap in that one
   * primitive rather than filters being unavailable. Four bands showed visible
   * rings; twelve on a squared falloff reads as a smooth fade.
   */
  glowBandCount: 12,
  /**
   * Spread is halved from the first pass (40): at 40 the light reached most of
   * the way to the neighbouring placement — the pitch between placements is only
   * ~50px in board space — so lit holds bled into each other and the glow read as
   * a blob rather than as an edge. The outward-only variant doubles whatever this
   * is, since the clip discards the inner half of the stroke.
   */
  glowSpreadWidth: 21,
  glowCoreWidth: 8,
  glowPeakOpacity: 0.95,
  /**
   * Size floor. A traced silhouette is the real hold, and on boards like Kilter
   * Homewall the real hold is much smaller than the placement circle the baseline
   * draws — so tracing everything shrank the marks and made the climb *harder* to
   * spot than baseline, even though each mark was now correct. When a hold's
   * silhouette is narrower than this fraction of the placement diameter, the
   * baseline ring is drawn as well, so the silhouette carries identity and the
   * ring carries findability.
   */
  sizeFloorFraction: 0.45,
  /**
   * How much wider a small hold's mark may grow to make up the area it loses by
   * being traced rather than circled. Capped, because past this the light starts
   * reaching its neighbours on a dense board.
   */
  smallHoldMaxBoost: 1.7,
  /** Whole-hold tint: fill opacity over the hold, plus a crisp edge on its outline. */
  tintFillOpacity: 0.55,
  tintEdgeWidth: 4,
  /**
   * Target OkLab lightness the hold's art is normalised toward before the role
   * colour goes on. Without it the same role hex composites to a different
   * colour on every board — a HAND on Grasshopper's near-black holds and a HAND
   * on Kilter Homewall's cream ones are not the same blue. Normalising with a
   * translucent white or black (rather than an opaque underlay) keeps the hold's
   * own shading and bolt hole visible underneath.
   */
  tintNormaliseTarget: 0.588,
  /** Crisp saturated silhouette-exact edges are the thing photographic hold art cannot fake. */
  tintBandWidth: 3,
  tintOuterEdgeWidth: 1,
  /**
   * Two-tone casing for the every-hold outline: a dark pass with a lighter core
   * on top. One unconditional language instead of a per-hold black-or-white
   * classifier, which produced visible salt-and-pepper where neighbouring holds
   * happened to land either side of the threshold.
   */
  casingDarkWidth: 3,
  casingDarkColor: '#10101A',
  casingDarkOpacity: 0.55,
  casingLightWidth: 1.25,
  casingLightColor: '#FFFFFF',
  casingLightOpacity: 0.6,
  /**
   * Role glyphs. Role is carried by hue alone in every treatment here, and under
   * protanopia HAND #4455FF and FOOT #FF00FF collapse to one colour (7.7 dE).
   * A glyph inside the existing footprint adds a second channel — silhouette —
   * without growing the mark: none / dot / bar / cross. Identical in every arm,
   * so an experiment measures treatments and not glyph sets.
   */
  /**
   * One line width for every accessibility marker on a board, as a fraction of
   * the placement radius — so it is constant within a board and scales between
   * boards with their hold pitch. Deliberately NOT scaled by the hold it sits
   * on: a marker has to mean the same thing on a jug and on a foot chip, and a
   * vocabulary whose weight changes per hold is harder to learn, not easier.
   */
  glyphLineWidthFraction: 0.11,
  glyphOpacity: 0.95,
  glyphCoreColor: '#FFFFFF',
  glyphCasingColor: '#0B0B10',
  glyphCasingWidthFactor: 1.9,
  glyphCasingOpacity: 0.8,
  /**
   * The LED the board art paints, taken over by the renderer: role colour where
   * the hold is lit, dark where it is not. Grasshopper paints 234 of its 332 LED
   * locations bright and the rest dark, which makes an unlit hold look lit and a
   * lit one look dead — see scripts/spike-led-dots.ts.
   */
  ledDotRadiusFraction: 0.1,
  ledDarkColor: '#0B0B10',
  ledDarkOpacity: 0.85,
} as const;

export type SpikeLitHold = {
  id: number;
  cx: number;
  cy: number;
  radius: number;
  role: HoldState;
};
