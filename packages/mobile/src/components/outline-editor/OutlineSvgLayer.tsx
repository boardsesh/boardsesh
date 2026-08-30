import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import type { HoldOutlineKind } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { placementRingPathData, radiusRingToBoardPx, ringToPathData } from './stroke';

const AnimatedPath = Animated.createAnimatedComponent(Path);

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
  /** The stroke under the pencil right now. */
  draft: '#FDE047',
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
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/** Stroke widths in device px — see the `vectorEffect` note on the component. */
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
 * are quoted relative to a hold radius rather than in device px.
 */
export const OutlineSvgLayer = React.memo(function OutlineSvgLayer({
  holdTargets,
  holdById,
  data,
  selectedPlacementId,
  editKind,
  draftPointsSV,
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

  const draftProps = useAnimatedProps(() => {
    'worklet';
    const points = draftPointsSV.value;
    if (points.length < 4) return { d: '' };
    let path = `M${points[0]} ${points[1]}`;
    for (let index = 2; index < points.length; index += 2) {
      path += `L${points[index]} ${points[index + 1]}`;
    }
    return { d: path };
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
        fill="none"
        stroke={OUTLINE_EDITOR_COLORS.selected}
        strokeWidth={STROKE_WIDTH.selected}
        vectorEffect="non-scaling-stroke"
      />
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
