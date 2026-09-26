import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Image } from 'expo-image';
import type { BoardName, HoldStat } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { EDITING_VEIL_OPACITY } from '../../lib/board-render-settings';
import { useNativeClimbRender } from '../../hooks/use-native-climb-render';
import { useTheme } from '../../providers/theme-provider';
import { hexWithAlpha, holdGeometry } from '../create-climb/holdLayout';
import { buildHeatLayer, heatLayerFrames, type HeatCell, type HeatLayer, type HeatMetric } from './heatmap-buckets';

const NO_LAYER: HeatLayer = { cells: [], codeColors: {}, legend: { kind: 'count', edgeValues: [], total: 0 } };

/**
 * The heat layer for one board: which holds are drawn in which colour, and what
 * the legend says. Memoised on its inputs and the theme's ramp, so the overlay
 * and the legend read the same object and a scheme flip recolours both.
 * `metric: null` (the create board's Erase brush) is no layer at all.
 */
export function useHeatLayer({
  statsByHoldId,
  holdTargets,
  metric,
  skipHoldIds,
}: {
  statsByHoldId: ReadonlyMap<number, HoldStat>;
  holdTargets: readonly BoardHoldTarget[] | null | undefined;
  metric: HeatMetric | null;
  skipHoldIds?: ReadonlySet<number>;
}): HeatLayer {
  const { heatRamp } = useTheme();
  const holdIds = useMemo(() => holdTargets?.map((target) => target.id) ?? [], [holdTargets]);
  return useMemo(
    () =>
      metric === null || statsByHoldId.size === 0
        ? NO_LAYER
        : buildHeatLayer({ statsByHoldId, holdIds, metric, ramp: heatRamp, skipHoldIds }),
    [statsByHoldId, holdIds, metric, heatRamp, skipHoldIds],
  );
}

export type HeatmapOverlayProps = {
  layer: HeatLayer;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  /** For the no-renderer fallback only: where each hold sits. */
  holdTargets: readonly BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  mirrored?: boolean;
};

/**
 * The hold heatmap over a board: each hot hold's traced silhouette filled with
 * its bucket's colour, drawn by the native renderer as ONE image and stacked in
 * the board's `underOverlay` slot — under the climb's own lit holds, inside the
 * mirrored stack, so it never mirrors itself.
 *
 * The buckets travel as synthetic hold-state codes (`p{id}r90{bucket}`) with
 * their colours in `extraHoldStates`, drawn with the Aura `fill` mark and no
 * veil. One PNG per (board, heat, ramp), disk-cached by the renderer like any
 * climb, so pinching the board costs nothing per frame.
 *
 * Where there is no renderer that can draw the fill, small dots stand in, with
 * the alpha baked into each colour rather than an `opacity` per view.
 */
export const HeatmapOverlay = memo(function HeatmapOverlay(props: HeatmapOverlayProps) {
  // Nothing to draw → no render request at all.
  if (props.layer.cells.length === 0) return null;
  return <RenderedHeatmap {...props} />;
});

function RenderedHeatmap({
  layer,
  boardName,
  layoutId,
  sizeId,
  setIds,
  holdTargets,
  boardWidth,
  boardHeight,
  mirrored = false,
}: HeatmapOverlayProps) {
  const frames = useMemo(() => heatLayerFrames(layer.cells), [layer.cells]);
  // The hook is always mounted (hooks cannot be conditional), but it is only
  // handed the frames once the capability probe says the fill can be drawn:
  // until then, and on a binary that cannot, a render would be a classic ring
  // picture that is thrown away — one wasted full-width render in the shared
  // queue per heat change. Asking for the fill mode is what starts the probe.
  const [fillSupported, setFillSupported] = useState<boolean | null>(null);
  const { overlayUri, overlayLoadKey, onOverlayLoad, onOverlayError, boardseshRendererAvailable, rendererUnavailable } =
    useNativeClimbRender({
      frames: fillSupported === true ? frames : '',
      boardName,
      layoutId,
      sizeId,
      setIds,
      backgroundVariant: 'full',
      maxVeilOpacity: EDITING_VEIL_OPACITY,
      extraHoldStates: layer.codeColors,
      markStyleOverride: 'fill',
    });
  if (boardseshRendererAvailable !== fillSupported) setFillSupported(boardseshRendererAvailable);

  // The last image that finished loading, kept on screen while the next one
  // renders: painting a hold on the create board, or switching mode, changes
  // the heat and therefore the cache key, and the new PNG takes a native render
  // to arrive. Without this the whole layer blinked off on every tap.
  const [shownUri, setShownUri] = useState<string | null>(null);
  const handleLoad = useCallback(() => {
    if (overlayUri) setShownUri(overlayUri);
    onOverlayLoad(overlayLoadKey);
  }, [overlayUri, onOverlayLoad, overlayLoadKey]);
  const handleError = useCallback(
    (event: { error: string }) => onOverlayError(event, overlayLoadKey),
    [onOverlayError, overlayLoadKey],
  );

  if (rendererUnavailable || boardseshRendererAvailable === false) {
    return (
      <HeatmapDots
        cells={layer.cells}
        holdTargets={holdTargets}
        boardWidth={boardWidth}
        boardHeight={boardHeight}
        mirrored={mirrored}
      />
    );
  }
  if (boardseshRendererAvailable !== true) return null;
  const retained = shownUri !== null && shownUri !== overlayUri ? shownUri : null;
  return (
    <>
      {retained ? (
        <Image
          key={`retained-${retained}`}
          source={{ uri: retained }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          cachePolicy="memory"
          allowDownscaling={false}
          transition={0}
          accessible={false}
        />
      ) : null}
      {overlayUri ? (
        <Image
          key={overlayLoadKey ?? overlayUri}
          source={{ uri: overlayUri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          cachePolicy="memory"
          // Rendered at the board's own width, like the play view's own overlay, so
          // expo-image has nothing to resample on the main thread.
          allowDownscaling={false}
          transition={0}
          accessible={false}
          onLoad={handleLoad}
          onError={handleError}
        />
      ) : null}
    </>
  );
}

/** At most half a hold's radius, growing with the bucket, so neighbours never overlap. */
const DOT_RADIUS_BY_BUCKET = [0.3, 0.35, 0.4, 0.45, 0.5] as const;
const DOT_ALPHA = 0.85;

type HeatmapDotsProps = {
  cells: readonly HeatCell[];
  holdTargets: readonly BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  mirrored: boolean;
};

/** Pure: the fallback dots, positioned on the same targets the create board taps. */
export function buildHeatmapDots({
  cells,
  holdTargets,
  boardWidth,
  boardHeight,
  measuredWidth,
  mirrored,
}: HeatmapDotsProps & { measuredWidth: number }) {
  if (measuredWidth <= 0 || boardWidth <= 0 || boardHeight <= 0) return [];
  const targetById = new Map(holdTargets.map((target) => [target.id, target]));
  return cells.flatMap((cell) => {
    const target = targetById.get(cell.holdId);
    if (!target) return [];
    const geometry = holdGeometry(
      target,
      boardWidth,
      boardHeight,
      measuredWidth,
      mirrored,
      DOT_RADIUS_BY_BUCKET[cell.bucket] ?? DOT_RADIUS_BY_BUCKET[0],
    );
    return [{ id: cell.holdId, geometry, color: hexWithAlpha(cell.color, DOT_ALPHA) }];
  });
}

/** The no-renderer fallback: one small dot per hot hold. */
const HeatmapDots = memo(function HeatmapDots(props: HeatmapDotsProps) {
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setMeasuredWidth((previous) => (previous === width ? previous : width));
  }, []);
  const dots = useMemo(() => buildHeatmapDots({ ...props, measuredWidth }), [props, measuredWidth]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={handleLayout}>
      {dots.map(({ id, geometry, color }) => (
        <View
          key={id}
          style={[
            styles.dot,
            {
              left: `${geometry.leftPct}%`,
              top: `${geometry.topPct}%`,
              width: geometry.ringDiameter,
              height: geometry.ringDiameter,
              marginLeft: -geometry.ringDiameter / 2,
              marginTop: -geometry.ringDiameter / 2,
              borderRadius: geometry.ringDiameter / 2,
              backgroundColor: color,
            },
          ]}
        />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
  },
});
