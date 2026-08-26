import type { BoardName, HoldState } from '@boardsesh/shared-schema';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';

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
  | 'thumb-ring'
  | 'glow'
  | 'shape'
  | 'glow-shape'
  | 'casing'
  | 'shape-glow'
  | 'shape-glow-out'
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
  /**
   * Wash the unlit wall with the play field colour, lit silhouettes punched out
   * of it. Defaults to off when absent. A modifier on the wall rather than a way
   * of marking a hold, so it sits alongside a selector instead of being one.
   */
  veil?: boolean;
  /**
   * The glow-size and fill experiments run after the blue was settled (fourth
   * pass, "What the capture said"): each is `veil-glow` or `veil-tint` with
   * exactly one rule changed, so a difference between two panels is that rule.
   */
  /** Multiply the glow's reach (spread and hold cap alike): a plainly bigger glow. */
  reachScale?: number;
  /** Hold the glow at full alpha over the inner part of its extent (`glowPlateauStops`) instead of fading from the edge. */
  plateau?: boolean;
  /** A soft placement-centred disc under the glow: the ring's footprint at low alpha, silhouette punched out. */
  softDisc?: boolean;
  /** Veil at `veilStrongerOpacity` instead of `veilStrongOpacity` on the boards in the strong bucket. */
  veilStrong?: boolean;
  /** Fill alpha for the filled arms, overriding `tintFillOpacity`. */
  tintFill?: number;
};

export const SPIKE_TREATMENTS: readonly SpikeTreatment[] = [
  {
    key: 'baseline',
    chip: 'Base',
    label: 'Baseline',
    note: 'Stroke-only role rings, no outline on unlit holds. Carries the LED layer, so it is the control and not literally what ships.',
    halos: 'none',
    selector: 'ring',
  },
  {
    key: 'thumb-baseline',
    chip: 'Base thumb',
    label: 'Baseline (thumbnail)',
    note: 'What renderer.rs draws under filledStyle: the same ring at an 8.0 base stroke, filled at alpha 0.302. The control for any size below full.',
    halos: 'none',
    selector: 'thumb-ring',
  },
  // The two candidate arms carry NO casing on unlit holds. They used to, and the
  // baseline did not, so every comparison between them was a comparison of two
  // variables: on grasshopper the wall-only mean luminance went 36.2 to 39.3 and
  // the bright-pixel share 0.50% to 2.32% purely from the casing. `shaped-halos`
  // below is the casing as its own chip, which is where it belongs.
  {
    key: 'outward-glow',
    chip: 'Outward',
    label: 'Outward glow',
    note: 'The glow is clipped to outside the hold, so the light comes off the edge and the surface stays clean.',
    halos: 'none',
    selector: 'shape-glow-out',
  },
  {
    key: 'glow-tint',
    chip: 'Hybrid',
    label: 'Glow + tint',
    note: 'Lightness-normalised fill for shape, a crisp silhouette edge, and an outward glow for reach.',
    halos: 'none',
    selector: 'glow-tint',
  },
  {
    key: 'veil-glow',
    chip: 'Veil',
    label: 'Veil + glow',
    note: 'The unlit wall is washed down in the field colour with the lit holds punched out, under the same outward glow.',
    halos: 'none',
    selector: 'shape-glow-out',
    veil: true,
  },
  // Composed from pieces that already exist — the `glow-tint` selector with the
  // veil modifier beside it — because the question it answers is whether the
  // fill still earns anything once the wall has been turned down, and that is a
  // combination rather than a new drawing.
  //
  // The hypothesis it tests is that the answer differs by SURFACE: a fill
  // survives a downsample where a hollow ring and a soft glow do not, so what
  // wins on a 1080 px play view need not win in a 76 dp list cell. The app
  // already behaves that way — `ClimbListThumbnail` passes `filledStyle` and
  // `renderer.rs` switches to a heavier stroke and a translucent fill for it —
  // so a per-surface answer is a tuning change there, not a new mechanism.
  {
    key: 'veil-tint',
    chip: 'Veil+tint',
    label: 'Veil + tint',
    note: 'The quiet wall under the filled arm. A fill survives downsampling where a hollow ring and a soft glow do not, so the arm that wins at 152 px need not be the one that wins full size.',
    halos: 'none',
    selector: 'glow-tint',
    veil: true,
  },
  // After the blue was settled at #6980FF the mark on TB2 Mirror still reads
  // weaker than the baseline ring did, and it is not reach: measured against
  // each board's real placement radius (TB2 31.8, MoonBoard 29.2, Grasshopper
  // 49.1) the glow's outer edge already sits 1.15-1.25x the ring's radius out.
  // What the ring had was a thick band at full alpha; on TB2 only 1 px of the
  // glow's 8.5 px extent holds 3:1 against the field. Levers that stack with
  // the hex, each as veil + glow (or veil + tint) with one rule changed, so the
  // panels differ by that rule alone.
  {
    key: 'veil-glow-x15',
    chip: 'Reach x1.5',
    label: 'Veil + glow, reach x1.5',
    note: "Veil + glow with the glow's reach and its hold cap both multiplied by 1.5 — simply a bigger glow. Overruns unlit neighbours on the dense boards; the question is whether they then read as lit.",
    halos: 'none',
    selector: 'shape-glow-out',
    veil: true,
    reachScale: 1.5,
  },
  {
    key: 'veil-glow-plateau',
    chip: 'Plateau',
    label: 'Veil + glow, plateau',
    note: 'Veil + glow holding full alpha over the inner 40% of its extent before fading — the thick saturated band the baseline ring had, on the silhouette instead of a circle.',
    halos: 'none',
    selector: 'shape-glow-out',
    veil: true,
    plateau: true,
  },
  {
    key: 'veil-glow-x15-plateau',
    chip: 'x1.5+plateau',
    label: 'Veil + glow, reach x1.5 and plateau',
    note: 'Both: the bigger glow with the flat inner band, in case they compound.',
    halos: 'none',
    selector: 'shape-glow-out',
    veil: true,
    reachScale: 1.5,
    plateau: true,
  },
  {
    key: 'veil-glow-disc',
    chip: 'Disc',
    label: 'Veil + glow, soft disc',
    note: "Veil + glow over a soft placement-centred disc at low alpha — the ring's footprint says 'here', the silhouette glow says 'this hold'. The hold's own surface is punched out of the disc.",
    halos: 'none',
    selector: 'shape-glow-out',
    veil: true,
    softDisc: true,
  },
  {
    key: 'veil60-glow',
    chip: 'Veil 0.60',
    label: 'Veil 0.60 + glow',
    note: 'Veil + glow with the strong bucket at 0.60 instead of 0.45 — TB2 Mirror, Tension Original, Kilter Homewall, Masters. Targets the wall competing with the glow; the unlit holds pay for it.',
    halos: 'none',
    selector: 'shape-glow-out',
    veil: true,
    veilStrong: true,
  },
  {
    key: 'veil-tint-70',
    chip: 'Tint 0.70',
    label: 'Veil + tint, fill 0.70',
    note: 'Veil + tint with the fill at alpha 0.70 instead of 0.55 — the hold itself lit, for the thumbnail surfaces where a fill is what survives the downsample.',
    halos: 'none',
    selector: 'glow-tint',
    veil: true,
    tintFill: 0.7,
  },
  {
    key: 'veil-tint-90',
    chip: 'Tint 0.90',
    label: 'Veil + tint, fill 0.90',
    note: 'Veil + tint with the fill at alpha 0.90: the hold painted in its role colour, shading all but gone.',
    halos: 'none',
    selector: 'glow-tint',
    veil: true,
    tintFill: 0.9,
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
 * `shipped` is what the wall in front of you actually lights, resolved per board
 * out of `HOLD_STATE_MAP` at the board's canonical role code as
 * `displayColor ?? color` — the same expression `use-native-climb-render.ts:701`
 * and the web's `worker-manager.ts:328` use — with one deliberate difference:
 * a dark-blue HAND is drawn as the fourth pass's `#6980FF` (see
 * `RECOMMENDED_HAND_DISPLAY`), so every capture from here on starts from the
 * recommendation rather than from the hex it replaces. The boards genuinely differ, and
 * the first pass of this spike drew Grasshopper's set on all seven: Kilter's
 * HAND is cyan `#00FFFF` where Grasshopper's is blue `#4455FF`, and Kilter
 * spends on FINISH the magenta Grasshopper spends on FOOT — so a magenta mark
 * meant two different things depending on which panel you were looking at.
 *
 * `grasshopper` pins Grasshopper's set on every board anyway, so the boards can
 * still be compared to each other with hue held constant.
 *
 * `equalL` lifts every role to L 0.70 and bisects chroma down to whatever still
 * fits sRGB (HAND keeps 63% of its chroma, FOOT 100%). It is a comparison chip,
 * not a proposal: computed correctly it fixes protan HAND/FOOT and creates three
 * worse collisions, and the role hex is what the app streams to the wall's LEDs.
 */
export type SpikePaletteKey = 'shipped' | 'grasshopper' | 'equalL' | BlueHandCandidateKey;

/**
 * The fourth design pass's finalists for the blue HAND
 * (`docs/spike/board-rendering-2202/design-review-4-blue-hand.md`): the board's
 * own palette with HAND's *display* hex swapped and nothing else moved. One chip
 * per hex, applied to whichever board is showing, so a `PALETTES=` capture puts
 * every hex on every blue board and the sheet decides. The capture picked
 * `#6980FF` on all five blue boards, and `shipped` now draws it, so the
 * `hand-6980FF` chip equals `shipped` on those boards and stays only so the
 * capture that decided it can be re-run as taken; `hand-1C8AFF` is the
 * runner-up (hue 255), `hand-707BBB` and `hand-667CFF` the two that lost. The
 * LED hex is untouched by all four — `aurora.ts:270` never reads `displayColor`.
 */
export type BlueHandCandidateKey = 'hand-1C8AFF' | 'hand-707BBB' | 'hand-667CFF' | 'hand-6980FF';

const BLUE_HAND_CANDIDATES: Record<BlueHandCandidateKey, string> = {
  'hand-1C8AFF': '#1C8AFF',
  'hand-707BBB': '#707BBB',
  'hand-667CFF': '#667CFF',
  'hand-6980FF': '#6980FF',
};

function isBlueHandCandidate(palette: SpikePaletteKey): palette is BlueHandCandidateKey {
  return palette in BLUE_HAND_CANDIDATES;
}

/** Role colours for one board. Partial: MoonBoard has no FOOT role at all. */
export type SpikeRolePalette = Partial<Record<HoldState, string>>;

const GRASSHOPPER_ROLE_COLORS: SpikeRolePalette = {
  STARTING: '#00DD00',
  HAND: '#4455FF',
  FINISH: '#FF0000',
  FOOT: '#FF00FF',
};

const EQUAL_L_ROLE_COLORS: SpikeRolePalette = {
  STARTING: '#00C000',
  HAND: '#7B96FF',
  FINISH: '#FF6553',
  FOOT: '#FE00FE',
};

const boardRoleColorCache = new Map<BoardName, SpikeRolePalette>();

/**
 * The blue HAND the fourth pass settled on, drawn by the spike ahead of the
 * `HOLD_STATE_MAP` change: `#6980FF` is the shipped hue (OkLCh h 272) at OkLab
 * L 0.65, rendered 4.83-4.92:1 against the field on every blue board where the
 * app's own `#4444FF` / `#4455FF` render 2.8-3.2 (`design-review-4-blue-hand.md`,
 * "What the capture said"). Applied wherever a board's HAND displays one of the
 * dark blues, so Kilter's cyan is untouched and a board that has already moved
 * is left alone. The LED hex is not read here and does not move.
 */
const RECOMMENDED_HAND_DISPLAY = '#6980FF';
const DARK_BLUE_HANDS = new Set(['#0000FF', '#4444FF', '#4455FF']);

function boardRoleColors(boardName: BoardName): SpikeRolePalette {
  const cached = boardRoleColorCache.get(boardName);
  if (cached !== undefined) return cached;

  const stateInfo = HOLD_STATE_MAP[boardName];
  const resolved: SpikeRolePalette = {};
  for (const [role, code] of Object.entries(STATE_TO_PRIMARY_CODE[boardName]) as Array<
    [HoldState, number | undefined]
  >) {
    // A board without a role — MoonBoard has no FOOT — simply has no entry, and
    // the overlay falls back to white for a role it cannot colour.
    if (code === undefined) continue;
    const info = stateInfo[code];
    if (info === undefined) continue;
    const display = info.displayColor ?? info.color;
    resolved[role] = role === 'HAND' && DARK_BLUE_HANDS.has(display.toUpperCase()) ? RECOMMENDED_HAND_DISPLAY : display;
  }
  boardRoleColorCache.set(boardName, resolved);
  return resolved;
}

export function spikeRolePalette(palette: SpikePaletteKey, boardName: BoardName): SpikeRolePalette {
  if (palette === 'grasshopper') return GRASSHOPPER_ROLE_COLORS;
  if (palette === 'equalL') return EQUAL_L_ROLE_COLORS;
  if (isBlueHandCandidate(palette)) return { ...boardRoleColors(boardName), HAND: BLUE_HAND_CANDIDATES[palette] };
  return boardRoleColors(boardName);
}

export const SPIKE_PALETTE_LABEL: Record<SpikePaletteKey, string> = {
  shipped: 'Hues: board',
  grasshopper: 'Hues: grass',
  equalL: 'Hues: equal L',
  'hand-1C8AFF': 'HAND #1C8AFF',
  'hand-707BBB': 'HAND #707BBB',
  'hand-667CFF': 'HAND #667CFF',
  'hand-6980FF': 'HAND #6980FF',
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
  // Not a proposal — the shipping play view paints `secondaryBackground`, which
  // is white in the Android light fallback, so this is the field anyone whose
  // phone is in light mode already has. Every arm here was captured on `field`.
  { key: 'light', label: 'Light', color: '#FFFFFF' },
] as const;

export type SpikeBackgroundKey = (typeof SPIKE_BACKGROUNDS)[number]['key'];

/**
 * The widths the app actually draws a board at, in DEVICE pixels.
 *
 * `full` is the play view — the only size any arm in this spike has been
 * captured at, and the widest the app renders. The rest are the surfaces that
 * outnumber it:
 *
 *   152  a 76 dp climb-list cell on a 2x screen (`climb-list-thumbnail-metrics.ts`)
 *   228  the same cell on a 3x screen
 *   384  the iOS Live Activity's `maxCompositeDimension`
 *
 * Rendering the board at the size instead of scaling a full-size render down is
 * the whole point: what is being asked is which marks survive that few pixels,
 * and a browser-scaled 1080 px raster answers a different question. The list
 * cell also passes `filledStyle`, so at these sizes the control is
 * `thumb-baseline` and not `baseline` — they are two different drawings.
 */
export const SPIKE_SIZES = [
  { key: 'full', label: 'Full', deviceWidth: null },
  { key: '152', label: '152 px', deviceWidth: 152 },
  { key: '228', label: '228 px', deviceWidth: 228 },
  { key: '384', label: '384 px', deviceWidth: 384 },
] as const;

export type SpikeSizeKey = (typeof SPIKE_SIZES)[number]['key'];

/**
 * Overlay geometry.
 *
 * Every width here is a FRACTION of the placement radius, which is the one
 * length a board carries with it: constant within a board, and proportional to
 * its hold pitch. That matters because the boards do not share a coordinate
 * space — MoonBoard's art box is 650 board px wide against 1080 for the other
 * five, and both are width-fit to the same screen, so an absolute board-pixel
 * width renders 1.66x larger there. The fractions are calibrated on Grasshopper
 * (r 49.091), where each one reproduces the absolute constant it replaced.
 *
 * Anything not named `*Fraction` is not one, and documents its own unit at its
 * own key. `strokeWidthBase` is absolute board pixels because the baseline arm's
 * job is to draw exactly what `renderer.rs:150` draws — `6.0 * scale_x *
 * getBoardStrokeWidthMultiplier(board)` — and a control expressed in some other
 * unit is no longer the thing that ships.
 */
export const SPIKE_TUNING = {
  /**
   * Placements sit one radius apart on this board, so a neutral ring at the full
   * placement radius would draw a solid mesh. 0.58 keeps each ring inside its own
   * cell while still tracing roughly a hold's worth of area.
   */
  haloRadius: 0.58,
  haloStrokeWidthFraction: 0.053,
  haloOpacity: 0.2,
  /** The `near` scope draws far fewer rings, so it can afford to be more visible. */
  nearHaloOpacity: 0.34,
  /** Centre distance (in placement radii) that counts as "next to a lit hold". */
  nearRadius: 2.3,
  glowRadius: 1.7,
  /**
   * The renderer's base hold-outline stroke, in board pixels, before the board's
   * own multiplier. Hardcoding Grasshopper's 1.35 into this drew the control ring
   * at 8.1 board px on all seven boards, 35% over what the app draws on the six
   * that have no multiplier.
   */
  strokeWidthBase: 6,
  /**
   * The same stroke on the thumbnail path. `renderer.rs:151` swaps the 6.0 for
   * an 8.0 whenever `config.thumbnail` is set, and `:201` fills the marker at
   * alpha 77 of 255 — 0.302 — first, "so lit holds read as solid dots once
   * scaled". `ClimbListThumbnail` passes `filledStyle: true`, so every list row
   * in the app is that second drawing and not the one the play view gets. Both
   * are in board pixels for the same reason `strokeWidthBase` is: the renderer
   * multiplies them by `scale_x`, which is exactly what the viewBox does here.
   *
   * The renderer's other branch — `HoldRenderStyle::AboveMarker`, a filled dot
   * at r * 0.62 sitting r * 1.28 above the placement under `thumbnail`
   * (`:210-211`) — is not drawn here because nothing can reach it: it belongs to
   * MoonBoard's AUX role, and `STATE_TO_PRIMARY_CODE` assigns no code to AUX, so
   * neither a saved climb nor this spike's synthesised one ever carries it.
   */
  thumbStrokeWidthBase: 8,
  thumbFillOpacity: 77 / 255,
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
   * Shape-following glow, built out of concentric strokes along the traced
   * outline from `glowSpreadFraction` down to `glowCoreFraction`.
   *
   * The obvious implementation — one wide stroke through an `FeGaussianBlur` —
   * does not work: react-native-svg's Android backend paints the filter region
   * as a solid rectangle of the stroke colour instead of blurring it (verified
   * on device, react-native-svg 15.15.5). `FeColorMatrix` in the same version
   * renders correctly on the same device, so this is a gap in that one primitive
   * rather than filters being unavailable.
   *
   * Fifteen is the floor, not the count: `solveGlowBands` adds bands wherever the
   * step between two of them would render wider than `glowStepMaxDevicePx`. The
   * floor is what the widest board needs at the reference width with no size
   * boost — Grasshopper's outward arm spans 20.1 device px there, which is 15
   * bands at 1.5 px a step; MoonBoard 2016 lands on 15 too, from a smaller spread
   * blown up 1.66x by its narrower board box. Twelve was chosen before the solve
   * and stepped 2 device px on a boosted MoonBoard hold, where the concentric
   * arcs were countable in a 3.4x crop.
   */
  glowBandCount: 15,
  /**
   * Spread is halved from the first pass (40): at 40 the light reached most of
   * the way to the neighbouring placement — the pitch between placements is only
   * ~50px in board space — so lit holds bled into each other and the glow read as
   * a blob rather than as an edge. The outward-only variant doubles whatever this
   * is, since the clip discards the inner half of the stroke.
   *
   * 0.43 r is the 21 board px this used to be, on Grasshopper. On MoonBoard it is
   * 12.5 instead of 21, which is the point: at 21 board px on a 650-wide board the
   * light reached 35 device px and the glow stopped tracing the silhouette and
   * read as a plain disc.
   *
   * The core is the innermost band's width, so `core / spread` is where on the
   * falloff curve the glow's brightest ink sits — everything inside it is the
   * composite of every band and cannot be brighter. At 0.163 r that landed at
   * 0.379 of the extent, two thirds of the way down the ramp, and the leading
   * arm's peak came out at 0.438 instead of the 1.00 the stops ask for at the
   * silhouette edge. 0.0215 r is 0.05 of the spread, inside the curve's flat top,
   * and composites to 0.967. It costs the byte-for-byte match with the captures
   * taken before the solve landed; those captures are of the plateau the solve
   * exists to remove.
   *
   * Raised 0.43 -> 0.55 -> 0.7 over two rounds of looking at it on a phone.
   * Tying the spread to the placement radius fixed the cross-board unit problem
   * and shrank the mark doing it: the three boards carrying 476-499 placements
   * came out at 12.9-16.6 board px of reach against 19.4-21.1 on the two
   * carrying 303-332, and the outward glow ended up putting LESS coloured ink on
   * a lit hold than the baseline ring does on six of the seven boards.
   *
   * 0.7 with the 1.8 cap below gives, per board: grasshopper 34.4,
   * Tension Original 31.5, Kilter Homewall 27.0, TB2 Mirror 22.2, Kilter
   * Original 21.0, both MoonBoards 20.4. Measured against every traced hold, the
   * cap then clips 3 of grasshopper's 332, 1 each on Kilter Original and
   * MoonBoard 2016 and none anywhere else — so the fraction, not the cap, is
   * what decides the mark on all seven boards, which is the point.
   *
   * 0.85 is past the knee even at the raised cap: 11 of TB2 Mirror's 498, 13 of
   * Kilter Original's 476 and 15 of MoonBoard 2016's 140 clip, and a clipped
   * glow has stopped tracing the hold and become a disc around it.
   */
  glowSpreadFraction: 0.7,
  glowCoreFraction: 0.0215,
  /**
   * Ceiling on the glow's one-sided RENDERED reach as a multiple of the hold's
   * own SHORT extent. It is a reach, so the MARK it permits is
   * `shortest x (1 + 2 x cap)` = **3.4x** the hold's short extent, not 1.2x —
   * which is what the round magenta discs on Tension Original's bottom foot row
   * are. Past that the glow stops being an outline of anything and becomes a
   * disc with a chip in the middle, and two holds in one climb 250 px apart
   * carry visibly different marks.
   *
   * On the reach and not on the band width, because `smallHoldMaxBoost` multiplies
   * the reach afterwards and small holds are exactly the ones being capped: as a
   * width cap it fired on 0 of the 2,360 committed outlines while 136 of them
   * still rendered past 1.2x their short extent — Tension Original 54, Kilter
   * Original 41, MoonBoard 2016 27, TB2 Mirror 13, Masters 1. Nothing sits near
   * the line: the closest hold the cap leaves alone reaches 0.97 of it.
   *
   * Raised 1.2 -> 1.4 -> 1.8 alongside the spread. On the boards with the
   * smallest holds this cap, not the fraction, was deciding the mark: MoonBoard
   * 2016's p10 short extent is 13 board px, so at 1.2 the reach was ceilinged at
   * 15.6 whatever the spread said, and raising the spread alone changed nothing
   * on exactly the holds it was raised for. TB2 Mirror is the same shape of
   * problem — 498 placements, a 26 board px median short extent, and the hardest
   * board in the set to pick a lit hold out of.
   *
   * The reason a bigger cap is safe on those two and not obviously safe
   * everywhere is that they have the room. Measured silhouette-to-silhouette,
   * the median gutter is 21.7 board px on MoonBoard 2016 and 20.4 on Masters —
   * the only two boards where the glow's reach was SMALLER than the space around
   * the hold — against 6.0 on Kilter Homewall and 8.7 on TB2 Mirror. Kilter
   * Homewall's glow has always overrun its gutter and that is fine: measured
   * over the unlit holds' own art the glow buries less of it than the baseline
   * circle does. What the cap is really protecting is the hold's shape, and at
   * 1.8 it still clips at most 3 of any board's traced holds, so it has stopped
   * being the thing that decides the mark on any of them.
   */
  glowHoldExtentCap: 1.8,
  /**
   * Cumulative alpha the glow should reach at a given fraction of its full
   * extent, measured outward from the silhouette edge. Per-band alphas are
   * solved from this rather than set individually: setting each band's own alpha
   * on a squared ramp composited to 1.000 all the way out to the core, so the
   * inner two-fifths of the glow was a flat plateau of saturated role colour and
   * the falloff only started where the review asked for it to be half gone.
   *
   * The first stop carries the peak. A separate multiplier over the top of these
   * scaled the solved curve to 95% of every stop, which is a second knob on the
   * same quantity and put the arm's brightest ink below what the curve says.
   *
   * Bands are discrete, so what renders is a staircase that holds each band's
   * target out to the next band in, and the composite is decided by the band
   * count alone. Read at 0.00 / 0.15 / 0.40 / 0.70 / 1.00 of the extent: at the
   * 15-band floor it is 0.967 / 0.831 / 0.365 / 0.117 / 0.000, and at the 20
   * bands Grasshopper's smallest holds ask for, 0.967 / 0.900 / 0.421 / 0.130 /
   * 0.000. The shortfall between stops is one step of the staircase, and 0.967
   * rather than 1.000 at the edge is the innermost band sitting at 0.05 of the
   * extent rather than at 0.
   */
  // The plateau is the default from 2026-08-26 (Marco's pick off the glow-size
  // capture, design-review-4-blue-hand.md "Bigger, not further"): full alpha
  // over the inner 0.4 of the extent, then the fade. The table it replaced —
  // [0, 1] [0.15, 0.83] [0.4, 0.37] [0.7, 0.12] [1, 0] — faded from the edge and
  // left TB2 Mirror's HAND with 1 px of its 8.5 px extent at 3:1; this one
  // doubles every board's share at 3:1 and takes the wall out of the picture
  // (TB2 36% of the annulus brighter than the glow to 4%) without dimming an
  // unlit hold. `glowPlateauStops` below is the same table, kept so the arms
  // that were captured under that name still resolve.
  glowFalloffStops: [
    [0.0, 1.0],
    [0.4, 0.97],
    [0.6, 0.6],
    [0.8, 0.22],
    [1.0, 0.0],
  ] as ReadonlyArray<readonly [number, number]>,
  /**
   * The one quantity here in device pixels rather than board units, because it is
   * about the display raster and not about the mark: a step between two bands
   * finer than this is below the point where the arcs become countable. Board
   * pixels reach the screen through the viewBox, so the conversion needs a
   * reference width — 1080, the capture width and the widest surface the app
   * renders a board at.
   */
  glowStepMaxDevicePx: 1.5,
  glowStepReferenceWidth: 1080,
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
  tintEdgeWidthFraction: 0.081,
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
  tintBandWidthFraction: 0.061,
  tintOuterEdgeWidthFraction: 0.02,
  /**
   * Two-tone casing for the every-hold outline: a dark pass with a lighter core
   * on top. One unconditional language instead of a per-hold black-or-white
   * classifier, which produced visible salt-and-pepper where neighbouring holds
   * happened to land either side of the threshold.
   *
   * The first pass drew this at a 2.2 board px hairline at 0.2 opacity and the
   * answer from review was "that's just the baseline": a hairline at a fifth
   * opacity, drawn at board resolution and then scaled down to a phone, is not a
   * visible treatment. Weight and opacity both up until it reads as a decision,
   * and the dark pass carries more of both than the light one — the play field is
   * dark either way, so a dark line has less to separate it from.
   */
  casingDarkWidthFraction: 0.061,
  casingDarkColor: '#10101A',
  casingDarkOpacity: 0.55,
  casingLightWidthFraction: 0.025,
  casingLightColor: '#FFFFFF',
  casingLightOpacity: 0.6,
  /**
   * Role glyphs. Role is carried by hue alone in every treatment here, and under
   * protanopia HAND #4455FF and FOOT #FF00FF land 3.2 dE00 apart — one colour.
   * A glyph inside the existing footprint adds a second channel — silhouette —
   * without growing the mark: bar / bar / ring / X.
   *
   * Their own axis, DEFAULT OFF, because that is what they are in the product:
   * an accessibility mode a climber turns on, which REPLACES the per-role marker
   * shapes the app ships today (#3204) rather than layering over them. The
   * default render carries no glyph on any arm, so nothing measured about an arm
   * here is measuring the glyph — and anything measured with `glyphs=on` is a
   * measurement of the accessibility mode, to be judged on whether it serves
   * someone who needs it.
   */
  /**
   * One line width for every accessibility marker on a board, as a fraction of
   * the placement radius — so it is constant within a board and scales between
   * boards with their hold pitch. Deliberately NOT scaled by the hold it sits
   * on: a marker has to mean the same thing on a jug and on a foot chip, and a
   * vocabulary whose weight changes per hold is harder to learn, not easier.
   */
  glyphLineWidthFraction: 0.11,
  /**
   * How far the bars run out before the silhouette clip trims them, in placement
   * radii. Past the hold's own edge on purpose: the clip is what decides the
   * length, so the bar always spans the whole hold whatever shape it is.
   */
  glyphReachRadii: 1.6,
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
  /**
   * Field-colour veil over the unlit wall: the board rect filled with the play
   * field colour and every lit silhouette punched out of it as an even-odd hole.
   * Every other arm in this spike is additive — it spends ink on the 16 lit
   * placements out of 303 to 499, 10 out of 198 on the MoonBoards, and leaves the
   * rest alone — and this is the counterpart that quiets the other 95-97%
   * instead. One path, no mask and no filter, so the board-art guard stays clear
   * and `renderer.rs` draws it as a single even-odd fill — against the 632
   * stroked paths the every-hold casing costs on Grasshopper, two per unlit
   * placement, and 966 on Kilter Homewall.
   *
   * Strength is bucketed on the GAP between the wall and the field it is being
   * washed toward, in OkLab lightness — see `veilOpacityFor`, which owns the
   * arithmetic and the reason the annulus table's 0 sentinel is filtered out
   * first. Over the committed table on the default field `#181225` (L 0.200)
   * that gap is TB2 Mirror 0.541, Tension Original 0.461, MoonBoard Masters
   * 0.441, Kilter Homewall 0.426, MoonBoard 2016 0.373, Kilter Original 0.325,
   * Grasshopper 0.216.
   *
   * The two thresholds are the wall-lightness ones they replace minus that
   * 0.200, so on the default field the seven boards keep the strength they were
   * captured with. What changes is the two boards the old sentinel-fed mean read
   * as empty rather than bright — both MoonBoards go from no veil at all to the
   * soft bucket — and every field that is not `#181225`.
   */
  veilStrongOpacity: 0.45,
  veilSoftOpacity: 0.3,
  /**
   * The `veilStrong` modifier's bucket: what the strong-bucket boards get
   * instead of 0.45. 0.60 takes TB2 Mirror's unlit holds from 3.08 to 2.22
   * against the field (the field lens's number) — the trade this arm exists to
   * look at.
   */
  veilStrongerOpacity: 0.6,
  /**
   * The `softDisc` modifier: peak alpha of the placement-centred disc under the
   * glow, flat to 0.6 of the placement radius and fading to 0 at the radius.
   * Low on purpose — it is the ring's footprint as a hint, not a second mark,
   * and it never reaches the hold's own surface.
   */
  softDiscOpacity: 0.3,
  /**
   * The `plateau` modifier's falloff, now identical to `glowFalloffStops`: the
   * `veil-glow-plateau` and `veil-glow-x15-plateau` arms were captured under
   * this name and stay resolvable; `veil-glow` draws the same thing.
   */
  glowPlateauStops: [
    [0.0, 1.0],
    [0.4, 0.97],
    [0.6, 0.6],
    [0.8, 0.22],
    [1.0, 0.0],
  ] as ReadonlyArray<readonly [number, number]>,
  veilStrongGap: 0.34,
  veilSoftGap: 0.175,
  /**
   * Share of a board's placements that must carry an art reading before the
   * strong bucket is allowed. Under it the board is mostly bare grid, and what
   * the veil dims there is the field's own furniture rather than hold art —
   * on both MoonBoards the A-K / 1-18 grid labels, which are painted into the
   * art and go down with the wall.
   */
  veilMinCoverage: 0.6,
} as const;

export type SpikeLitHold = {
  id: number;
  cx: number;
  cy: number;
  radius: number;
  role: HoldState;
};
