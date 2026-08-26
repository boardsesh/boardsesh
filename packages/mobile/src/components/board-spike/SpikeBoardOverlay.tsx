import React, { useMemo } from 'react';
import Svg, { Circle, ClipPath, Defs, G, Path, RadialGradient, Stop } from 'react-native-svg';
import type { BoardName, HoldState } from '@boardsesh/shared-schema';
import { getBoardStrokeWidthMultiplier } from '@boardsesh/board-constants/hold-states';
import type { HoldPlacement } from '../board-renderer/types';
import { plainRingPath, polygonPath, spikyRingPath, splinePath, wavyRingPath } from './spike-shapes';
import {
  SPIKE_HOLD_ART_LIGHTNESS,
  SPIKE_HOLD_SILHOUETTE_LIGHTNESS,
  SPIKE_SILHOUETTE_LIGHTNESS_NO_ART,
} from './spike-hold-lightness';
import { SPIKE_HOLD_OUTLINES } from './spike-hold-outlines';
import { SPIKE_LED_DOTS } from './spike-led-dots';
import { RoleGlyph } from './RoleGlyph';
import { spikeBoardByKey } from './spike-boards';
import {
  SPIKE_TUNING,
  spikeRolePalette,
  type HaloScope,
  type HaloShape,
  type SelectorStyle,
  type SpikeLitHold,
  type SpikePaletteKey,
} from './spike-config';

type SpikeBoardOverlayProps = {
  boardKey: string;
  boardWidth: number;
  boardHeight: number;
  placements: HoldPlacement[];
  litHolds: SpikeLitHold[];
  halos: HaloScope;
  haloShape: HaloShape;
  selector: SelectorStyle;
  palette: SpikePaletteKey;
  /** Curve the traced outlines through their points instead of joining them straight. */
  smooth: boolean;
  /**
   * Take the LED over from the board art. Its own axis rather than something a
   * treatment carries: while it was gated on the selector it put 234 near-black
   * discs on grasshopper's candidate panels, over the brightest pixels in the
   * art, that the control panel did not carry — a second variable between arms
   * that are supposed to differ by one.
   */
  leds: boolean;
  /**
   * Draw the role glyph inside every mark. Its own axis and OFF by default,
   * because that is what it is in the product: an accessibility mode that
   * REPLACES the shipped per-role marker shapes, not a layer the default render
   * carries. Every arm can be captured either way, so a glyph finding is a
   * finding about the accessibility mode and never about the default picture.
   */
  glyphs: boolean;
  /** Dim the unlit wall with the play field colour, lit silhouettes punched out. */
  veil: boolean;
  /** The play field behind the art — what the veil is a wash of. */
  playFieldColor: string;
};

/**
 * Bounding box of a traced silhouette, in board pixels relative to the
 * placement centre. Three consumers, all of which used to make do with the
 * placement: the size floor wants the longest extent, the glow's shape cap wants
 * the shortest, and the role glyph wants the box's centre — the placement is a
 * median 5-11% off it (p90 10-21%), and because the bars are clipped to the
 * silhouette an off-centre anchor changes the glyph's rendered SHAPE, not just
 * where it sits.
 */
type OutlineBounds = { centreX: number; centreY: number; longest: number; shortest: number };

function outlineBounds(boardKey: string, holdId: number): OutlineBounds | null {
  const flat = SPIKE_HOLD_OUTLINES[boardKey]?.[holdId];
  if (flat === undefined || flat.length < 6) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < flat.length; index += 2) {
    minX = Math.min(minX, flat[index]);
    maxX = Math.max(maxX, flat[index]);
    minY = Math.min(minY, flat[index + 1]);
    maxY = Math.max(maxY, flat[index + 1]);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return {
    centreX: (minX + maxX) / 2,
    centreY: (minY + maxY) / 2,
    longest: Math.max(width, height),
    shortest: Math.min(width, height),
  };
}

/**
 * Placements that get a neutral casing under the current scope.
 *
 * Never a lit one. The casing exists to give an unlit hold a findable shape; put
 * it under a lit mark and it is a second contour inside the mark, disagreeing
 * with it about where the hold ends.
 */
function haloTargets(scope: HaloScope, placements: HoldPlacement[], litHolds: SpikeLitHold[]): HoldPlacement[] {
  if (scope === 'none') return [];
  const litIds = new Set(litHolds.map((hold) => hold.id));
  const unlit = placements.filter((placement) => !litIds.has(placement.id));
  if (scope === 'all') return unlit;
  const reach = (placements[0]?.r ?? 0) * SPIKE_TUNING.nearRadius;
  return unlit.filter((placement) =>
    litHolds.some((lit) => Math.hypot(lit.cx - placement.cx, lit.cy - placement.cy) < reach),
  );
}

/** OkLab lightness of a `#rrggbb` colour — the same expression the lightness generator measures the art with. */
function oklabLightness(hexColor: string): number {
  const hex = hexColor.startsWith('#') ? hexColor.slice(1) : hexColor;
  // Only the six-digit form, which is what every entry in SPIKE_BACKGROUNDS is.
  // A colour this cannot read reports mid-grey rather than falling through to a
  // NaN, which compares false against both thresholds and would silently turn
  // the veil off — the weakest outcome, reached by a typo rather than by a
  // measurement. Digits and length both, since `parseInt('zz', 16)` is NaN.
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return 0.5;
  const toLinear = (channel: number) => {
    const normalised = channel / 255;
    return normalised <= 0.04045 ? normalised / 12.92 : ((normalised + 0.055) / 1.055) ** 2.4;
  };
  const red = toLinear(parseInt(hex.slice(0, 2), 16));
  const green = toLinear(parseInt(hex.slice(2, 4), 16));
  const blue = toLinear(parseInt(hex.slice(4, 6), 16));
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
}

/**
 * How hard the field-colour veil quiets this board's unlit wall, or 0 where
 * there is no wall worth quieting.
 *
 * Two things decide it, and the first version of this function saw neither.
 *
 * The veil is a wash of the PLAY FIELD over the wall, so all it can buy is the
 * gap between the two — bucket that, not the wall on its own. On the plywood
 * chip `#6B4F33` (OkLab L 0.450) Grasshopper's wall is darker than the field, so
 * a wash there makes the wall brighter than the hold it is meant to be quieting
 * behind; that case returns 0 now and the arm degrades to plain outward glow.
 * This is not a chip-only problem: the shipping play view paints
 * `secondaryBackground`, which is white in the Android light fallback.
 *
 * And the annulus table's 0 sentinel is not a dark wall, it is NO ART IN THE
 * BAND — bare play field, where the veil composites the field onto the field and
 * changes nothing. Averaging those in measures how empty a board is rather than
 * how bright: 94 of each MoonBoard's 198 placements are that sentinel, which
 * dragged both boards' means to 0.301 and 0.337 and returned 0, so their veil
 * panel was a byte-identical republish of the outward-glow panel. Filtered, the
 * art that is actually there reads 0.573 and 0.641 — the two loudest walls left
 * once the other five are washed down.
 *
 * A board that is mostly bare grid is still capped at the soft bucket. What the
 * veil dims there is the field's own furniture, not hold art: both MoonBoards
 * paint their A-K / 1-18 grid labels into the board art, and those go down with
 * the wall.
 */
function veilOpacityFor(boardKey: string, playFieldColor: string): number {
  const readings = Object.values(SPIKE_HOLD_ART_LIGHTNESS[boardKey] ?? {});
  const withArt = readings.filter((lightness) => lightness > 0);
  if (withArt.length === 0) return 0;
  const wallLightness = withArt.reduce((total, value) => total + value, 0) / withArt.length;
  const gap = wallLightness - oklabLightness(playFieldColor);
  const bucket =
    gap >= SPIKE_TUNING.veilStrongGap
      ? SPIKE_TUNING.veilStrongOpacity
      : gap >= SPIKE_TUNING.veilSoftGap
        ? SPIKE_TUNING.veilSoftOpacity
        : 0;
  const coverage = withArt.length / readings.length;
  return coverage < SPIKE_TUNING.veilMinCoverage ? Math.min(bucket, SPIKE_TUNING.veilSoftOpacity) : bucket;
}

/** Shape-coded arm: dashed start, wavy hand, spiky finish, plain foot. */
function roleRingPath(role: HoldState, cx: number, cy: number, radius: number): string {
  if (role === 'HAND' || role === 'STARTING') return wavyRingPath(cx, cy, radius);
  if (role === 'FINISH') return spikyRingPath(cx, cy, radius);
  return plainRingPath(cx, cy, radius);
}

/** Target cumulative alpha at a fraction of the glow's full extent. */
function glowFalloff(fraction: number): number {
  const stops = SPIKE_TUNING.glowFalloffStops;
  for (let index = 1; index < stops.length; index += 1) {
    const [previousAt, previousAlpha] = stops[index - 1];
    const [nextAt, nextAlpha] = stops[index];
    if (fraction > nextAt) continue;
    const span = nextAt - previousAt;
    const position = span <= 0 ? 0 : (fraction - previousAt) / span;
    return previousAlpha + (nextAlpha - previousAlpha) * position;
  }
  return stops[stops.length - 1][1];
}

type GlowBand = { width: number; opacity: number };

/**
 * Concentric strokes from `spread` down to `core`, with each band's own alpha
 * solved so that what they COMPOSITE to follows `glowFalloffStops`.
 *
 * The difference is the whole change. Setting each band's alpha directly off a
 * squared ramp stacked twelve translucent strokes into cumulative 1.000 out to
 * the core and 0.826 barely past it, so the glow was a saturated plateau with a
 * cliff rather than a fade. Solving backwards — `a_k = 1 - (1 - A(w_k)) / (1 -
 * A(w_{k-1}))` — makes each band contribute exactly the alpha the band inside it
 * still needs.
 *
 * A band of width `w` reaches half its width past the path, so `w / spread` is
 * the fraction of the glow's extent it covers and `glowFalloffStops` can be read
 * at it directly. The stops carry the peak themselves — a separate 0.95
 * multiplier over the top of them scaled the whole solved curve down, so the
 * innermost band could never composite to the 1.0 the stops ask for at the
 * silhouette edge.
 *
 * Bands whose target is already fully opaque are pinned at 1.0 rather than
 * solved, because the recursion divides by `1 - A(w_{k-1})`; the solve starts at
 * the first band under 1. Nothing hits that with the stops as they stand — a
 * band at target 1.0 would have to be zero-width — but a stops table with a flat
 * top is legal and would otherwise divide by zero. Bands that come out at zero
 * alpha are dropped rather than painted, which is the outermost one whenever the
 * curve ends at 0.
 */
function solveGlowBands(spread: number, core: number, count: number): GlowBand[] {
  const bands: GlowBand[] = [];
  let previousTarget = 0;
  for (let index = 0; index < count; index += 1) {
    const position = index / (count - 1);
    const width = spread + (core - spread) * position;
    const target = glowFalloff(width / spread);
    const alpha = target >= 1 || previousTarget >= 1 ? 1 : 1 - (1 - target) / (1 - previousTarget);
    previousTarget = target;
    if (alpha < 0.001) continue;
    bands.push({ width, opacity: Number(alpha.toFixed(3)) });
  }
  return bands;
}

/**
 * Closest approach between two lit holds' marks, in board pixels — silhouette to
 * silhouette where both are traced, and off the placement circle where one is
 * not, so an untraced MoonBoard cell still keeps its neighbours at arm's length.
 */
function markOutlinePoints(hold: SpikeLitHold, outlines: Record<number, number[]>): number[] {
  const flat = outlines[hold.id];
  if (flat !== undefined && flat.length >= 6) {
    return flat.map((value, index) => (index % 2 === 0 ? hold.cx + value : hold.cy + value));
  }
  const samples: number[] = [];
  for (let step = 0; step < 16; step += 1) {
    const angle = (step / 16) * Math.PI * 2;
    samples.push(hold.cx + hold.radius * Math.cos(angle), hold.cy + hold.radius * Math.sin(angle));
  }
  return samples;
}

function nearestLitGaps(litHolds: SpikeLitHold[], outlines: Record<number, number[]>): Map<number, number> {
  const shapes = litHolds.map((hold) => ({ id: hold.id, points: markOutlinePoints(hold, outlines) }));
  const gaps = new Map<number, number>(shapes.map((shape) => [shape.id, Infinity]));
  for (let first = 0; first < shapes.length; first += 1) {
    for (let second = first + 1; second < shapes.length; second += 1) {
      const left = shapes[first].points;
      const right = shapes[second].points;
      let closest = Infinity;
      for (let leftIndex = 0; leftIndex < left.length; leftIndex += 2) {
        for (let rightIndex = 0; rightIndex < right.length; rightIndex += 2) {
          const dx = left[leftIndex] - right[rightIndex];
          const dy = left[leftIndex + 1] - right[rightIndex + 1];
          const distance = dx * dx + dy * dy;
          if (distance < closest) closest = distance;
        }
      }
      const gap = Math.sqrt(closest);
      gaps.set(shapes[first].id, Math.min(gaps.get(shapes[first].id) ?? Infinity, gap));
      gaps.set(shapes[second].id, Math.min(gaps.get(shapes[second].id) ?? Infinity, gap));
    }
  }
  return gaps;
}

/**
 * The whole spike overlay for one treatment, drawn in board-pixel space and
 * scaled to the surface by the SVG viewBox — the same coordinate contract the
 * Rust renderer's overlay PNG uses, so a treatment that reads well here can be
 * ported into `renderer.rs` unchanged.
 */
export const SpikeBoardOverlay = React.memo(function SpikeBoardOverlay({
  boardKey,
  boardWidth,
  boardHeight,
  placements,
  litHolds,
  halos,
  haloShape,
  selector,
  palette,
  smooth,
  leds,
  glyphs,
  veil,
  playFieldColor,
}: SpikeBoardOverlayProps) {
  // The generated tables are keyed by board key; the role hues and the stroke
  // multiplier are per PRODUCT. Every caller passes a key out of SPIKE_BOARDS —
  // the fallback only keeps the overlay renderable if one is ever mistyped.
  const boardName: BoardName = spikeBoardByKey(boardKey)?.boardName ?? 'grasshopper';
  const colors = spikeRolePalette(palette, boardName);
  const outlines = SPIKE_HOLD_OUTLINES[boardKey] ?? {};
  const ringLightness = SPIKE_HOLD_ART_LIGHTNESS[boardKey] ?? {};
  const silhouetteLightness = SPIKE_HOLD_SILHOUETTE_LIGHTNESS[boardKey] ?? {};

  const outlinePath = useMemo(
    () =>
      (holdId: number, cx: number, cy: number): string | null => {
        const points = outlines[holdId];
        if (points === undefined || points.length < 6) return null;
        return smooth ? splinePath(points, cx, cy) : polygonPath(points, cx, cy);
      },
    [outlines, smooth],
  );

  const litById = useMemo(() => new Map(litHolds.map((hold) => [hold.id, hold])), [litHolds]);
  const targets = useMemo(() => haloTargets(halos, placements, litHolds), [halos, placements, litHolds]);
  const litGaps = useMemo(() => nearestLitGaps(litHolds, outlines), [litHolds, outlines]);
  const litRoles = useMemo(() => [...new Set(litHolds.map((hold) => hold.role))], [litHolds]);

  // The veil, as one even-odd path: the whole board rect with every lit hold's
  // own silhouette punched out of it, so the wash quiets the wall and never the
  // mark. One element, and no <Mask>, <Filter> or <Image href> anywhere in it —
  // the board-art guard stays clear and renderer.rs draws it as a single filled
  // path. A lit hold the tracer could not read falls back to its placement
  // circle, which is the shape its own mark is drawn as.
  const veilOpacity = useMemo(
    () => (veil ? veilOpacityFor(boardKey, playFieldColor) : 0),
    [veil, boardKey, playFieldColor],
  );
  const veilPath = useMemo(() => {
    if (veilOpacity <= 0) return null;
    const holes = litHolds.map(
      (hold) => outlinePath(hold.id, hold.cx, hold.cy) ?? plainRingPath(hold.cx, hold.cy, hold.radius),
    );
    return `M 0 0 H ${boardWidth} V ${boardHeight} H 0 Z ${holes.join(' ')}`;
  }, [veilOpacity, litHolds, outlinePath, boardWidth, boardHeight]);

  const haloOpacity = halos === 'near' ? SPIKE_TUNING.nearHaloOpacity : SPIKE_TUNING.haloOpacity;
  const drawsGlow = selector === 'glow' || selector === 'glow-shape';
  const drawsCasing = selector === 'casing';
  const drawsShapeGlow = selector === 'shape-glow' || selector === 'shape-glow-out';
  const outwardOnly = selector === 'shape-glow-out';
  const drawsTint = selector === 'tint';
  const drawsHybrid = selector === 'glow-tint';
  const drawsShape = selector === 'shape' || selector === 'glow-shape';
  const drawsThumbRing = selector === 'thumb-ring';

  // One line width and one LED size per board: both are keyed to the placement
  // radius, which is constant within a board and carries its hold pitch.
  const placementRadius = placements[0]?.r ?? 0;
  const scaled = (fraction: number) => placementRadius * fraction;
  const glyphLineWidth = Math.max(1.5, scaled(SPIKE_TUNING.glyphLineWidthFraction));
  const ledDotRadius = Math.max(1.5, scaled(SPIKE_TUNING.ledDotRadiusFraction));
  // The board's own stroke multiplier, not Grasshopper's: 1.35 on Grasshopper and
  // 1.0 on Kilter, Tension and MoonBoard, which is what renderer.rs draws there.
  // The thumbnail control takes the 8.0 base the renderer swaps in under
  // `filledStyle` rather than the play view's 6.0.
  const strokeWidth =
    (drawsThumbRing ? SPIKE_TUNING.thumbStrokeWidthBase : SPIKE_TUNING.strokeWidthBase) *
    getBoardStrokeWidthMultiplier(boardName);
  const outlineWidth = selector === 'glow-shape' ? strokeWidth * 0.7 : strokeWidth;

  const ledData = SPIKE_LED_DOTS[boardKey];
  // MoonBoard's LED sits half a row below its hold rather than on it, so the dot
  // has to move with the board rather than always being drawn at the centre.
  const ledOffsetY = ledData?.ledOffsetY ?? 0;
  const ledHolds = useMemo(() => new Set(ledData?.hasLed ?? []), [ledData]);
  const artBrightLeds = useMemo(() => new Set(ledData?.brightInArt ?? []), [ledData]);
  // Where the art actually paints the bright blob, which is a median 2.15 board px
  // off the point the dot is drawn at — enough that a dot the same size as the
  // blob leaves a bright crescent uncovered on 206 of grasshopper's 234.
  const ledOffsets: Partial<Record<number, readonly [number, number]>> = ledData?.brightOffsets ?? {};
  // A lit LED only reads as belonging to its hold when it is drawn ON it.
  // MoonBoard's grid puts it 25 board px below a silhouette that reaches at most
  // 25, so it lands in a gap — and on a board where an empty cell is the normal
  // case, a saturated role dot in a gap reads as a light on a hold that is not
  // there. Dropped rather than stemmed: `led-placements-data.ts` has
  // `moonboard: {}`, so nothing in the data even confirms the downward sign, and
  // the mark already carries the role.
  const drawsLitLedDot = ledOffsetY === 0;

  const insideClipId = (holdId: number) => `spike-inside-${boardKey}-${holdId}`;
  const outsideClipId = (holdId: number) => `spike-outside-${boardKey}-${holdId}`;

  /**
   * The un-traced arms' mark: the baseline's role ring, the thumbnail
   * baseline's filled one, the shape-coded arm's role-shaped ring, or nothing at
   * all where a radial-gradient halo is the whole treatment.
   */
  const ringMark = (hold: SpikeLitHold) => {
    const color = colors[hold.role] ?? '#FFFFFF';
    // What the list row and the accessory thumbnail actually get today: the same
    // placement circle, filled at 0.302 under a heavier stroke. It is a
    // different drawing from the play view's, so it is the only honest control
    // for a panel rendered at a thumbnail width — measuring a candidate at 152
    // px against a downsampled 6.0-stroke hollow ring compares it to something
    // the app never draws at that size.
    if (drawsThumbRing) {
      return (
        <Circle
          cx={hold.cx}
          cy={hold.cy}
          r={hold.radius}
          fill={color}
          fillOpacity={SPIKE_TUNING.thumbFillOpacity}
          stroke={color}
          strokeWidth={strokeWidth}
        />
      );
    }
    if (!drawsShape) {
      if (drawsGlow) return null;
      return <Circle cx={hold.cx} cy={hold.cy} r={hold.radius} fill="none" stroke={color} strokeWidth={outlineWidth} />;
    }
    const radius = selector === 'glow-shape' ? hold.radius * 1.02 : hold.radius;
    const dashed = hold.role === 'STARTING';
    return (
      <Path
        d={roleRingPath(hold.role, hold.cx, hold.cy, radius)}
        fill="none"
        stroke={color}
        strokeWidth={outlineWidth}
        strokeDasharray={dashed ? '26,16' : undefined}
        strokeLinecap={dashed ? 'round' : undefined}
        strokeLinejoin="round"
      />
    );
  };

  // Gated in the one place every arm draws it through, so no arm can carry the
  // accessibility mode while another does not.
  const roleGlyph = (hold: SpikeLitHold, bounds: OutlineBounds | null) => {
    if (!glyphs) return null;
    return (
      <RoleGlyph
        role={hold.role}
        cx={hold.cx + (bounds?.centreX ?? 0)}
        cy={hold.cy + (bounds?.centreY ?? 0)}
        reach={bounds === null ? hold.radius : hold.radius * SPIKE_TUNING.glyphReachRadii}
        lineWidth={glyphLineWidth}
        clipId={bounds === null ? undefined : insideClipId(hold.id)}
      />
    );
  };

  /**
   * The glow's bands for one hold. Its extent gives up reach twice over: to the
   * hold's own short axis, so it stays an outline instead of becoming a disc with
   * a chip in it, and to the gap to the nearest lit silhouette, so two lit holds
   * a few board px apart do not fuse into one envelope. `scale` is 2 where the
   * bands are clipped to outside the silhouette, since a stroke straddles its
   * path and the clip throws the inner half away.
   */
  const glowBandsFor = (hold: SpikeLitHold, bounds: OutlineBounds | null, boost: number, scale: number) => {
    const holdCap = bounds === null ? Infinity : bounds.shortest * SPIKE_TUNING.glowHoldExtentCap;
    const neighbourCap = Math.max(
      SPIKE_TUNING.glowNeighbourFloorWidth,
      SPIKE_TUNING.glowNeighbourFraction * (litGaps.get(hold.id) ?? Infinity),
    );
    // Both caps are on the CLIPPED arms' rendered reach, which is `spread * boost`
    // at scale 2, and the boost multiplies reach, so both divide it back out here.
    // Capping the band WIDTH instead let the boost carry the mark straight back
    // past the cap: across the 2,360 committed outlines a width cap fired on none
    // of them while 136 still rendered past 1.2x their own short extent — 54 on
    // Tension Original, 41 on Kilter Original, 27 on MoonBoard 2016, 13 on TB2
    // Mirror and 1 on Masters. MoonBoard 2016 is the board change 6 was written
    // about. On the un-clipped `shaped-glow` chip the stroke straddles the path,
    // so reach there is half that and both caps bind twice as tight as asked —
    // conservative, and that arm is not one of the four captured.
    const spread = Math.min(scaled(SPIKE_TUNING.glowSpreadFraction), holdCap / boost, neighbourCap / boost);
    // Keeping core/spread constant keeps the falloff's shape when the spread is
    // capped, instead of collapsing the ramp into the innermost band.
    const core = Math.min(
      scaled(SPIKE_TUNING.glowCoreFraction),
      spread * (SPIKE_TUNING.glowCoreFraction / SPIKE_TUNING.glowSpreadFraction),
    );
    const reachSpan = ((spread - core) * boost * scale) / 2;
    const devicePxPerBoardPx = SPIKE_TUNING.glowStepReferenceWidth / boardWidth;
    const bandCount = Math.max(
      SPIKE_TUNING.glowBandCount,
      Math.ceil((reachSpan * devicePxPerBoardPx) / SPIKE_TUNING.glowStepMaxDevicePx) + 1,
    );
    return solveGlowBands(spread, core, bandCount);
  };

  return (
    <Svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      <Defs>
        {litRoles.map((role) => {
          const color = colors[role] ?? '#FFFFFF';
          return (
            // Transparent through the middle so the hold's own moulding still
            // shows: the halo is a light around the hold, not a disc over it.
            <RadialGradient key={role} id={`spike-glow-${role}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={color} stopOpacity={0} />
              <Stop offset="42%" stopColor={color} stopOpacity={0} />
              <Stop offset="53%" stopColor={color} stopOpacity={0.95} />
              <Stop offset="70%" stopColor={color} stopOpacity={0.34} />
              <Stop offset="100%" stopColor={color} stopOpacity={0} />
            </RadialGradient>
          );
        })}
        {/* Clip ids carry the board key because placement ids repeat across
            boards and react-native-svg's Android backend never clears the clip
            map it resolves them through — a stale definition from the board you
            were looking at a moment ago is worse than a missing one. */}
        {litHolds.map((hold) => {
          const path = outlinePath(hold.id, hold.cx, hold.cy);
          if (path === null) return null;
          // The silhouette edge is stroked at double width through this clip so
          // only its inner half survives. A centred stroke sits proud of the art
          // on every edge and blunts tapers into lozenges — and taper is how you
          // recognise a hold on the wall.
          return (
            <ClipPath key={`inside-${hold.id}`} id={insideClipId(hold.id)}>
              <Path d={path} />
            </ClipPath>
          );
        })}
        {(outwardOnly || drawsHybrid) &&
          litHolds.map((hold) => {
            const path = outlinePath(hold.id, hold.cx, hold.cy);
            if (path === null) return null;
            return (
              // Everything on the board MINUS this hold. A stroke is centred on
              // its path, so half of every glow band would fall inside the hold
              // and wash out the surface you are about to grab; clipping to the
              // outside makes the light come off the edge the way a real LED
              // behind the hold does.
              <ClipPath key={`clip-${hold.id}`} id={outsideClipId(hold.id)}>
                <Path d={`M 0 0 H ${boardWidth} V ${boardHeight} H 0 Z ${path}`} clipRule="evenodd" />
              </ClipPath>
            );
          })}
      </Defs>

      {/* First thing painted, so everything else in the overlay sits on top of
          it. Every other arm here is additive — the synthesised climb lights 16
          placements of 303 to 499, 10 of 198 on the MoonBoards, and the rest is
          left alone; this one quiets that other 95-97% instead. */}
      {veilPath !== null && <Path d={veilPath} fill={playFieldColor} fillOpacity={veilOpacity} fillRule="evenodd" />}

      <G>
        {targets.map((placement) => {
          if (haloShape === 'outline') {
            const path = outlinePath(placement.id, placement.cx, placement.cy);
            if (path === null) return null;
            // One unconditional two-tone casing rather than a per-hold
            // black-or-white choice. The classifier version flipped polarity on
            // visually identical neighbours wherever their measured lightness
            // straddled the threshold, which reads as salt-and-pepper; a dark
            // pass with a lighter core on top reads on both pale and dark art
            // without having to decide which it is.
            return (
              <G key={`halo-${placement.id}`}>
                <Path
                  d={path}
                  fill="none"
                  stroke={SPIKE_TUNING.casingDarkColor}
                  strokeOpacity={SPIKE_TUNING.casingDarkOpacity}
                  strokeWidth={scaled(SPIKE_TUNING.casingDarkWidthFraction)}
                  strokeLinejoin="round"
                />
                <Path
                  d={path}
                  fill="none"
                  stroke={SPIKE_TUNING.casingLightColor}
                  strokeOpacity={SPIKE_TUNING.casingLightOpacity}
                  strokeWidth={scaled(SPIKE_TUNING.casingLightWidthFraction)}
                  strokeLinejoin="round"
                />
              </G>
            );
          }
          return (
            <Circle
              key={`halo-${placement.id}`}
              cx={placement.cx}
              cy={placement.cy}
              r={placement.r * SPIKE_TUNING.haloRadius}
              fill="none"
              stroke="#FFFFFF"
              strokeOpacity={haloOpacity}
              strokeWidth={scaled(SPIKE_TUNING.haloStrokeWidthFraction)}
            />
          );
        })}
      </G>

      {/* The LED, taken over from the board art. Grasshopper brightens 234 of its
          332 LED locations and leaves the rest dark, so an unlit hold can look lit
          and a lit one can look dead; Tension draws all of its darker than the
          hold. Role colour where the hold is lit, dark where it is not. Central on
          Grasshopper, Tension and Woods, and the bolt hole on Kilter.

          On its own axis, and on in every arm including the control. renderer.rs
          draws none of this, so the control panel is not literally what ships
          today — but a layer that is on in the candidates and off in the control
          is a second variable between the arms, and 234 near-black discs over the
          brightest pixels in grasshopper's art is a large one. The chip turns it
          off for all four arms together. */}
      {leds && (
        <G>
          {placements.map((placement) => {
            const litHold = litById.get(placement.id);
            const isLit = litHold !== undefined;
            if (isLit && (!ledHolds.has(placement.id) || !drawsLitLedDot)) return null;
            if (!isLit && !artBrightLeds.has(placement.id)) return null;
            const [blobDx, blobDy] = ledOffsets[placement.id] ?? [0, 0];
            // Where the dot goes depends on what it is there to be. Over one of
            // the art's own bright blobs it is a cover, so it stays on the blob
            // — that offset is what stopped 206 of grasshopper's 234 from
            // keeping a bright crescent. Everywhere else it is the hold's light,
            // and it has to agree with the mark, which is anchored on the traced
            // silhouette: the placement centre is a median 2.1 to 4.1 board px
            // off that box's centre (kilter-homewall p90 7.6, max 13.8 over the
            // committed outlines), which is enough to squeeze a second
            // role-coloured pip out from behind a bar, and enough to put the
            // FOOT ring's hole — the place the ring is designed to show role
            // colour through — over the hold's own dark bolt hole instead.
            const silhouette = artBrightLeds.has(placement.id) ? null : outlineBounds(boardKey, placement.id);
            const fill = litHold ? (colors[litHold.role] ?? '#FFFFFF') : SPIKE_TUNING.ledDarkColor;
            return (
              <Circle
                key={`led-${placement.id}`}
                cx={placement.cx + (silhouette?.centreX ?? blobDx)}
                cy={placement.cy + ledOffsetY + (silhouette?.centreY ?? blobDy)}
                r={ledDotRadius}
                fill={fill}
                fillOpacity={litHold ? 1 : SPIKE_TUNING.ledDarkOpacity}
              />
            );
          })}
        </G>
      )}

      <G>
        {drawsCasing &&
          litHolds.map((hold) => (
            <Circle
              key={`casing-${hold.id}`}
              cx={hold.cx}
              cy={hold.cy}
              r={hold.radius}
              fill="none"
              // The annulus table, which is the band this ring is drawn in.
              stroke={(ringLightness[hold.id] ?? 0) >= SPIKE_TUNING.casingLightnessThreshold ? '#000000' : '#FFFFFF'}
              strokeOpacity={SPIKE_TUNING.casingOpacity}
              strokeWidth={strokeWidth * SPIKE_TUNING.casingWidthMultiplier}
            />
          ))}
        {drawsGlow &&
          litHolds.map((hold) => (
            <Circle
              key={`glow-${hold.id}`}
              cx={hold.cx}
              cy={hold.cy}
              r={hold.radius * SPIKE_TUNING.glowRadius}
              fill={`url(#spike-glow-${hold.role})`}
            />
          ))}

        {(drawsShapeGlow || drawsTint || drawsHybrid) &&
          litHolds.map((hold) => {
            const color = colors[hold.role] ?? '#FFFFFF';
            const path = outlinePath(hold.id, hold.cx, hold.cy);
            const bounds = outlineBounds(boardKey, hold.id);
            // No traced silhouette (a bare MoonBoard grid cell, say) — fall back
            // to a ring rather than leaving a lit hold unmarked. The role mark
            // still goes on: the vocabulary has to be complete, or the absence of
            // a glyph becomes meaningful, and on MoonBoard the fallback is common
            // enough that dropping it would leave a third of a climb unlabelled.
            if (path === null) {
              return (
                <G key={`sel-${hold.id}`}>
                  <Circle
                    cx={hold.cx}
                    cy={hold.cy}
                    r={hold.radius}
                    fill="none"
                    stroke={color}
                    strokeWidth={strokeWidth}
                  />
                  {roleGlyph(hold, null)}
                </G>
              );
            }
            // Small holds get a bigger mark, not a second one. The first pass
            // drew the baseline circle on top of the traced silhouette whenever
            // the hold was narrow, which reads as two marks disagreeing about
            // where the hold is — a precise outline and a circle that is not it.
            // Boosting the light instead keeps one shape and still stops a
            // correct-but-tiny mark from losing findability against baseline.
            const sizeFloor = hold.radius * 2 * SPIKE_TUNING.sizeFloorFraction;
            const smallHoldBoost = Math.min(
              SPIKE_TUNING.smallHoldMaxBoost,
              Math.max(1, sizeFloor / Math.max(1, bounds?.longest ?? Infinity)),
            );
            if (drawsHybrid) {
              // Lift the art under the hold toward a common lightness before the
              // role colour goes on, so the role hex still reads on
              // Grasshopper's near-black holds. Translucent, not an opaque
              // underlay — the hold's own shading and bolt hole have to survive.
              //
              // Measured INSIDE the silhouette, which is the art this fill
              // actually covers. The ring's annulus table reads 0 wherever no art
              // falls in the band — 45 of Tension Original's 303 — and a sentinel
              // is not nullish, so `?? target` sailed past it and painted those
              // holds white at alpha 0.588.
              const measured = silhouetteLightness[hold.id];
              const artLightness =
                measured === undefined || measured === SPIKE_SILHOUETTE_LIGHTNESS_NO_ART
                  ? SPIKE_TUNING.tintNormaliseTarget
                  : measured;
              const target = SPIKE_TUNING.tintNormaliseTarget;
              // One-way: lift dark art toward the target, never push bright art
              // down to it. The downward half fired on 78% to 100% of the traced
              // holds on the three palest walls — every one of TB2 Mirror's 498,
              // 239 of Tension Original's 303, 387 of Kilter Homewall's 499 —
              // and a black wash under a translucent role fill is why the filled
              // arm scored BELOW the control on the board with the brightest
              // wall in the set. The cost is that a HAND on pale wood and a HAND
              // on near-black holds are no longer exactly the same blue; that
              // consistency is worth less than the contrast it was taking.
              const liftsArt = artLightness < target;
              const normaliseOpacity = liftsArt ? (target - artLightness) / Math.max(1e-3, 1 - artLightness) : 0;
              return (
                <G key={`sel-${hold.id}`}>
                  <G clipPath={`url(#${outsideClipId(hold.id)})`}>
                    {glowBandsFor(hold, bounds, smallHoldBoost, 2).map((band) => (
                      <Path
                        key={band.width}
                        d={path}
                        fill="none"
                        stroke={color}
                        strokeOpacity={band.opacity}
                        strokeWidth={band.width * 2 * smallHoldBoost}
                        strokeLinejoin="round"
                      />
                    ))}
                  </G>
                  {liftsArt && <Path d={path} fill="#FFFFFF" fillOpacity={Math.min(0.9, normaliseOpacity)} />}
                  <Path d={path} fill={color} fillOpacity={SPIKE_TUNING.tintFillOpacity} />
                  <G clipPath={`url(#${insideClipId(hold.id)})`}>
                    <Path
                      d={path}
                      fill="none"
                      stroke={color}
                      strokeWidth={scaled(SPIKE_TUNING.tintBandWidthFraction) * 2}
                      strokeLinejoin="round"
                    />
                  </G>
                  <Path
                    d={path}
                    fill="none"
                    stroke="#FFFFFF"
                    strokeOpacity={0.85}
                    strokeWidth={scaled(SPIKE_TUNING.tintOuterEdgeWidthFraction)}
                    strokeLinejoin="round"
                  />
                  {roleGlyph(hold, bounds)}
                </G>
              );
            }
            if (drawsTint) {
              return (
                <G key={`sel-${hold.id}`}>
                  <Path d={path} fill={color} fillOpacity={SPIKE_TUNING.tintFillOpacity} />
                  <Path
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeWidth={scaled(SPIKE_TUNING.tintEdgeWidthFraction)}
                    strokeLinejoin="round"
                  />
                  {roleGlyph(hold, bounds)}
                </G>
              );
            }
            // A stroke straddles its path, so the outward-only variant doubles
            // the widths: the clip throws the inner half away and the visible
            // spread of light stays the same.
            const scale = outwardOnly ? 2 : 1;
            return (
              <G key={`sel-${hold.id}`}>
                <G clipPath={outwardOnly ? `url(#${outsideClipId(hold.id)})` : undefined}>
                  {glowBandsFor(hold, bounds, smallHoldBoost, scale).map((band) => (
                    <Path
                      key={band.width}
                      d={path}
                      fill="none"
                      stroke={color}
                      strokeOpacity={band.opacity}
                      strokeWidth={band.width * scale * smallHoldBoost}
                      strokeLinejoin="round"
                    />
                  ))}
                </G>
                {roleGlyph(hold, bounds)}
              </G>
            );
          })}

        {!drawsShapeGlow &&
          !drawsTint &&
          !drawsHybrid &&
          litHolds.map((hold) => {
            // The glyph goes through the same gate here as on every other arm,
            // so `glyphs=on` moves all of them together. It used to be drawn
            // unconditionally, and in a luminance-only render of grasshopper it
            // is the strongest element on a mark — which made every capture a
            // picture of the accessibility mode rather than of the default.
            return (
              <G key={`sel-${hold.id}`}>
                {ringMark(hold)}
                {roleGlyph(hold, outlineBounds(boardKey, hold.id))}
              </G>
            );
          })}
      </G>
    </Svg>
  );
});
