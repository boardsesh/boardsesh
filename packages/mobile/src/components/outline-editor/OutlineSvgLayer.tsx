import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import type { HoldOutlineKind } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { placementRingPathData, radiusRingToBoardPx, ringToPathData } from './stroke';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * The live stroke's `[x0, y0, x1, y1, …]` as an open SVG polyline, on the UI
 * thread. Shared by both draft paths so the thin preview and the brush band can
 * never disagree about where the stroke went.
 */
function draftPolylinePathData(points: number[]): string {
  'worklet';
  if (points.length < 4) return '';
  let path = `M${points[0]} ${points[1]}`;
  for (let index = 2; index < points.length; index += 2) {
    path += `L${points[index]} ${points[index + 1]}`;
  }
  return path;
}

/**
 * Editor role colours. Deliberately fixed rather than theme-derived: this is an
 * admin tool whose whole job is telling four states apart at a glance over
 * arbitrary board art, so the hues are chosen against the board photo, not
 * against the app's light/dark surfaces.
 */
export const OUTLINE_EDITOR_COLORS = {
  /** What the tracer produced and nobody has touched. */
  traced: '#9CA3AF',
  /** A stored SILHOUETTE override. */
  overridden: '#34D399',
  /** The shard outline still sitting under a differing override. */
  ghost: '#6B7280',
  /** No shard outline and no override — the renderer falls back to a plain ring. */
  missing: '#F59E0B',
  /** A stored LED_INNER annotation: the inner edge of the LED base plate. */
  ledInner: '#60A5FA',
  /**
   * The area of the placement being edited, washed over the board art.
   *
   * A translucent green wash, and by default no boundary line at all. The job on
   * this screen is seeing where the outline disagrees with the hold under it,
   * and a wash shows that as a sliver of green sitting off the hold, or a corner
   * of hold with no green on it — either reads at a glance. A hard edge only
   * says where the line is, and over busy board art it competes with the hold's
   * own edges rather than standing apart from them.
   *
   * A solid hue: the alpha is a prop, because how much green it takes to read a
   * mismatch depends on the art underneath.
   */
  selectedFill: '#22C55E',
  /** The stroke under the pencil right now. */
  draft: '#FDE047',
  /** The brush trail while it is adding area. */
  brushAdd: '#22C55E',
  /** The brush trail while it is erasing area. */
  brushErase: '#EF4444',
} as const;

export type OutlineLayerData = {
  /** Traced silhouettes from the deployed shard, by placement id. */
  shardByPlacement: Map<number, number[]>;
  /** Stored SILHOUETTE overrides, by placement id. */
  silhouetteByPlacement: Map<number, number[]>;
  /** Stored LED_INNER annotations, by placement id. */
  ledInnerByPlacement: Map<number, number[]>;
};

type OutlineSvgLayerProps = {
  holdTargets: BoardHoldTarget[];
  /** The same holds keyed by placement id. Passed in rather than rebuilt (or
   *  scanned with `.find`) so resolving the selection stays O(1) — the screen
   *  already maintains this index. */
  holdById: Map<number, BoardHoldTarget>;
  data: OutlineLayerData;
  selectedPlacementId: number | null;
  editKind: HoldOutlineKind;
  /** The live stroke in board px, written by `DrawStrokeOverlay`. */
  draftPointsSV: SharedValue<number[]>;
  /** What the stroke in progress will do on commit. Spelled out here rather than
   *  imported as `DrawMode`: that type lives in `EditToolbar`, which already
   *  imports the colours from this file. */
  brushMode: 'redraw' | 'add' | 'erase';
  /** Brush half-width in BOARD px, so the painted band holds its real size as
   *  the board is zoomed. Only read in add/erase mode. */
  brushRadiusBoardPx: number;
  /**
   * True while a stroke is actually under the pencil.
   *
   * `draftPointsSV` carries two different things at different moments: the live
   * swept path during a stroke, and the committed ring once the stroke lands.
   * Only the first is a brush band. Without this the committed outline would be
   * drawn as a 12-48 board-px coloured swath centred on it, hiding the very
   * boundary the commit is about to store — in exactly the two modes where the
   * edit is subtle. A shared value, so a stroke starting or ending never costs
   * a React render.
   */
  strokeLiveSV: SharedValue<boolean>;
  /**
   * The unsaved edit for the selected placement, in radius units, or null.
   *
   * The highlight has to be drawn from THIS and not from the stored tables, or
   * the shape being edited never changes on screen: an erase would shrink the
   * ring that gets saved while the fill kept showing the ring it replaced, which
   * reads as the eraser doing nothing at all.
   */
  draftOutline: number[] | null;
  /**
   * Draw the selected hold's boundary as a line on top of its wash.
   *
   * Off by default, because a crisp edge tracing the wash's own border is what
   * makes a mismatch HARDER to see: the eye locks onto the line rather than onto
   * where the green disagrees with the hold under it. It earns its place when
   * you want to read the exact vertices, so it is a switch and not a fixture.
   */
  showSelectedOutline: boolean;
  /** Alpha of the wash, 0-1. Adjustable because how much green it takes to read
   *  a mismatch depends entirely on the art underneath — a pale Kilter hold and
   *  a dark Woods photo want very different amounts. */
  washOpacity: number;
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/** Stroke widths in device px — see the `vectorEffect` note on the component.
 *  The brush trail has no entry here on purpose: its width is board geometry,
 *  not a line weight, so it comes from the brush radius instead. */
const STROKE_WIDTH = {
  selectedEdge: 1.6,
  traced: 1,
  overridden: 1.6,
  ghost: 1,
  missing: 1,
  ledInner: 1.4,
  draft: 2.4,
} as const;

/**
 * Every placement's outline, in one SVG.
 *
 * Concatenated by ROLE, not by placement: a board config carries up to a few
 * thousand placements, and one `<Path>` element each would be thousands of
 * native views to mount and diff. Each role instead gets a single `d` built by
 * joining `M…Z` subpaths, so the layer is seven nodes regardless of board size
 * — five role buckets, the selection, and the live draft — and each rebuilds only
 * when its own bucket changes.
 *
 * Coordinates are BOARD px throughout, mapped to the rendered box by the
 * `viewBox` — the same frame the stored rings convert into, so nothing here
 * needs to know the zoom. `vectorEffect="non-scaling-stroke"` keeps line weight
 * readable at any board size; dash lengths stay in user units, which is why they
 * are quoted relative to a hold radius rather than in device px. The brush trail
 * is the one deliberate exception; see the note where it is drawn.
 */
export const OutlineSvgLayer = React.memo(function OutlineSvgLayer({
  holdTargets,
  holdById,
  data,
  selectedPlacementId,
  editKind,
  draftPointsSV,
  brushMode,
  brushRadiusBoardPx,
  strokeLiveSV,
  draftOutline,
  showSelectedOutline,
  washOpacity,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: OutlineSvgLayerProps) {
  const { shardByPlacement, silhouetteByPlacement, ledInnerByPlacement } = data;

  const buckets = useMemo(() => {
    const traced: string[] = [];
    const overridden: string[] = [];
    const ghost: string[] = [];
    const missing: string[] = [];
    const ledInner: string[] = [];

    for (const hold of holdTargets) {
      // The hold being edited is drawn by its wash alone. Its role hairline would
      // sit directly under that wash as a hard edge, which is the one thing this
      // surface must not have: you are judging the wash against the hold in the
      // photo, and a crisp line tracing the wash's own border gives the eye
      // something to lock onto that is not the hold.
      if (hold.id === selectedPlacementId) continue;
      const shardOutline = shardByPlacement.get(hold.id);
      const silhouetteOverride = silhouetteByPlacement.get(hold.id);
      const ledInnerOverride = ledInnerByPlacement.get(hold.id);

      if (silhouetteOverride) {
        overridden.push(ringToPathData(radiusRingToBoardPx(silhouetteOverride, hold)));
        // Keep the tracer's version visible underneath so the correction can be
        // judged against what it replaced.
        if (shardOutline) ghost.push(ringToPathData(radiusRingToBoardPx(shardOutline, hold)));
      } else if (shardOutline) {
        traced.push(ringToPathData(radiusRingToBoardPx(shardOutline, hold)));
      } else {
        missing.push(placementRingPathData(hold));
      }

      if (ledInnerOverride) {
        ledInner.push(ringToPathData(radiusRingToBoardPx(ledInnerOverride, hold)));
      }
    }

    return {
      traced: traced.join(''),
      overridden: overridden.join(''),
      ghost: ghost.join(''),
      missing: missing.join(''),
      ledInner: ledInner.join(''),
    };
  }, [holdTargets, selectedPlacementId, shardByPlacement, silhouetteByPlacement, ledInnerByPlacement]);

  // The placement being edited, filled so the AREA reads rather than just its
  // boundary — an outline that is wrong by one lobe is far easier to spot as a
  // shape that does not match the hold under it than as a line near its edge.
  //
  // Drawn from the unsaved draft whenever there is one, so the fill tracks every
  // brush stroke. Reading the stored tables here instead would leave the shape
  // frozen at whatever was last saved while the edit happened invisibly.
  const selectedPath = useMemo(() => {
    if (selectedPlacementId == null) return '';
    const hold = holdById.get(selectedPlacementId);
    if (!hold) return '';
    if (draftOutline) return ringToPathData(radiusRingToBoardPx(draftOutline, hold));
    if (editKind === 'LED_INNER') {
      const ledInnerOverride = ledInnerByPlacement.get(hold.id);
      return ledInnerOverride ? ringToPathData(radiusRingToBoardPx(ledInnerOverride, hold)) : '';
    }
    const outline = silhouetteByPlacement.get(hold.id) ?? shardByPlacement.get(hold.id);
    return outline ? ringToPathData(radiusRingToBoardPx(outline, hold)) : placementRingPathData(hold);
  }, [
    selectedPlacementId,
    editKind,
    holdById,
    draftOutline,
    silhouetteByPlacement,
    shardByPlacement,
    ledInnerByPlacement,
  ]);

  // Dash length scaled off the board's own size so it reads the same on a
  // 4000px-wide Kilter and a small Tension.
  const dashLength = Math.max(2, boardWidth / 300);

  const brushing = brushMode !== 'redraw';

  // Two hooks, and which one paints is decided on the UI thread: `draftPointsSV`
  // carries the live swept path during a stroke and the committed ring after it,
  // and only the first of those is a brush band. Gating in the worklets rather
  // than in JSX means the swap lands on the frame the stroke ends, and neither
  // hook is called conditionally.
  // The thin trail draws ONLY while a redraw stroke is under the pencil. Once a
  // stroke commits, the wash is already showing the ring it produced, and
  // drawing it again as a line would put back the hard edge the wash replaced.
  const draftProps = useAnimatedProps(() => {
    'worklet';
    if (brushing || !strokeLiveSV.value) return { d: '' };
    return { d: draftPolylinePathData(draftPointsSV.value) };
  });

  const brushProps = useAnimatedProps(() => {
    'worklet';
    if (!strokeLiveSV.value) return { d: '' };
    return { d: draftPolylinePathData(draftPointsSV.value) };
  });

  if (renderWidth <= 0 || renderHeight <= 0) return null;

  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width={renderWidth}
      height={renderHeight}
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
    >
      <Path
        d={buckets.ghost}
        fill="none"
        stroke={OUTLINE_EDITOR_COLORS.ghost}
        strokeWidth={STROKE_WIDTH.ghost}
        strokeOpacity={0.5}
        strokeDasharray={[dashLength, dashLength]}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.missing}
        fill="none"
        stroke={OUTLINE_EDITOR_COLORS.missing}
        strokeWidth={STROKE_WIDTH.missing}
        strokeOpacity={0.8}
        strokeDasharray={[dashLength, dashLength]}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.traced}
        fill="none"
        stroke={OUTLINE_EDITOR_COLORS.traced}
        strokeWidth={STROKE_WIDTH.traced}
        strokeOpacity={0.85}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.overridden}
        fill="none"
        stroke={OUTLINE_EDITOR_COLORS.overridden}
        strokeWidth={STROKE_WIDTH.overridden}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.ledInner}
        fill="none"
        stroke={OUTLINE_EDITOR_COLORS.ledInner}
        strokeWidth={STROKE_WIDTH.ledInner}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={selectedPath}
        fill={OUTLINE_EDITOR_COLORS.selectedFill}
        fillOpacity={washOpacity}
        fillRule="evenodd"
        stroke={showSelectedOutline ? OUTLINE_EDITOR_COLORS.selectedFill : 'none'}
        strokeWidth={showSelectedOutline ? STROKE_WIDTH.selectedEdge : 0}
        vectorEffect="non-scaling-stroke"
      />
      {/*
       * The brush trail, previewing the commit rather than the gesture.
       *
       * `strokeWidth` is in USER UNITS and this is the one path in the layer
       * WITHOUT `vectorEffect="non-scaling-stroke"`: everywhere else the
       * stroke is a line weight that has to stay readable at any zoom, but
       * here the width IS board geometry and has to scale with the board.
       *
       * Round caps and joins are load-bearing, not cosmetic. A round-capped,
       * round-joined polyline of width 2r is exactly the Minkowski sum of the
       * path with a disc of radius r, which is the same region the commit
       * stamps disc by disc — so this previews the real result for free.
       * Miter joins would spike outward on every direction change and promise
       * area the disc stamp never fills.
       *
       * Mounted in every mode and blanked by its worklet rather than unmounted,
       * so a mode change never remounts a native node mid-gesture.
       */}
      {brushing ? (
        <AnimatedPath
          animatedProps={brushProps}
          fill="none"
          stroke={brushMode === 'add' ? OUTLINE_EDITOR_COLORS.brushAdd : OUTLINE_EDITOR_COLORS.brushErase}
          strokeWidth={2 * brushRadiusBoardPx}
          strokeOpacity={0.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      <AnimatedPath
        animatedProps={draftProps}
        fill="none"
        stroke={OUTLINE_EDITOR_COLORS.draft}
        strokeWidth={STROKE_WIDTH.draft}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
});
