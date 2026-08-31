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
  /** The placement currently being edited. */
  selected: '#FFFFFF',
  /** The wash inside the placement being edited, so the region reads as an AREA
   *  and not just a boundary — the brush edits the area. Carries its own alpha
   *  because it has to stay faint enough for the hold photo to show through
   *  whatever the board art underneath happens to be. */
  selectedFill: 'rgba(255, 255, 255, 0.16)',
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
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/** Stroke widths in device px — see the `vectorEffect` note on the component.
 *  The brush trail has no entry here on purpose: its width is board geometry,
 *  not a line weight, so it comes from the brush radius instead. */
const STROKE_WIDTH = {
  traced: 1,
  overridden: 1.6,
  ghost: 1,
  missing: 1,
  ledInner: 1.4,
  selected: 2.6,
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
  }, [holdTargets, shardByPlacement, silhouetteByPlacement, ledInnerByPlacement]);

  // The placement being edited, drawn again on top in white so it reads over
  // whichever role colour it already carries. The ring shown is the one for the
  // kind currently being edited, so switching mode moves the highlight.
  const selectedPath = useMemo(() => {
    if (selectedPlacementId == null) return '';
    const hold = holdById.get(selectedPlacementId);
    if (!hold) return '';
    if (editKind === 'LED_INNER') {
      const ledInnerOverride = ledInnerByPlacement.get(hold.id);
      return ledInnerOverride ? ringToPathData(radiusRingToBoardPx(ledInnerOverride, hold)) : '';
    }
    const outline = silhouetteByPlacement.get(hold.id) ?? shardByPlacement.get(hold.id);
    return outline ? ringToPathData(radiusRingToBoardPx(outline, hold)) : placementRingPathData(hold);
  }, [selectedPlacementId, editKind, holdById, silhouetteByPlacement, shardByPlacement, ledInnerByPlacement]);

  // Dash length scaled off the board's own size so it reads the same on a
  // 4000px-wide Kilter and a small Tension.
  const dashLength = Math.max(2, boardWidth / 300);

  // Two hooks, one rendered path: `useAnimatedProps` can't be called
  // conditionally, and both have to keep reading `draftPointsSV` on the UI
  // thread so a stroke never costs a React render per frame.
  const draftProps = useAnimatedProps(() => {
    'worklet';
    return { d: draftPolylinePathData(draftPointsSV.value) };
  });

  const brushProps = useAnimatedProps(() => {
    'worklet';
    return { d: draftPolylinePathData(draftPointsSV.value) };
  });

  const brushing = brushMode !== 'redraw';

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
        stroke={OUTLINE_EDITOR_COLORS.selected}
        strokeWidth={STROKE_WIDTH.selected}
        vectorEffect="non-scaling-stroke"
      />
      {brushing ? (
        /*
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
         */
        <AnimatedPath
          animatedProps={brushProps}
          fill="none"
          stroke={brushMode === 'add' ? OUTLINE_EDITOR_COLORS.brushAdd : OUTLINE_EDITOR_COLORS.brushErase}
          strokeWidth={2 * brushRadiusBoardPx}
          strokeOpacity={0.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <AnimatedPath
          animatedProps={draftProps}
          fill="none"
          stroke={OUTLINE_EDITOR_COLORS.draft}
          strokeWidth={STROKE_WIDTH.draft}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </Svg>
  );
});
