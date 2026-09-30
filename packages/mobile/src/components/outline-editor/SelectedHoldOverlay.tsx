import React, { useLayoutEffect, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { overlays } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { holdPathData } from './spray-hold-path';
import { useZoomStrokeStep } from './SprayHoldSvgLayer';
import type { HoldGeometry } from './spray-hold-tools';

/** Selected-ring styles in screen points at 1x, divided by the zoom step like every ring. */
const SELECTED = {
  width: 3,
  haloWidth: 6 + 3,
  fillOpacity: 0.3,
} as const;

/** Room around the hold's own extent for the halo, in render px. */
const HALO_MARGIN_RENDER_PX = 8;

type SelectedHoldOverlayProps = {
  /** The selected hold in board px, or null. Its id is the revision key for the preview. */
  hold: (HoldGeometry & { id: number }) | null;
  /**
   * Bumped after every committed move, so the preview re-syncs to the reducer's
   * answer even when the move changed nothing (a refused move snaps back).
   */
  revision: number;
  /** `[id, cx, cy, r]` — the preview's base position, owned jointly with the gesture overlay. */
  selectedHoldSV: SharedValue<number[]>;
  dragOffsetXSV: SharedValue<number>;
  dragOffsetYSV: SharedValue<number>;
  /** The hold a drag is moving right now, 0 when none. Owned by the gesture overlay. */
  dragHoldIdSV: SharedValue<number>;
  scaleSV: SharedValue<number>;
  /** Board px per render px. */
  boardScale: number;
};

/**
 * The selected hold, drawn on its own so it can MOVE without the ring layer
 * re-rendering.
 *
 * A small SVG sized to the one hold, positioned by an animated style that reads
 * the base position plus the live drag offset — both shared values, so a drag
 * repaints on the UI thread and nothing on the JS thread knows the finger is
 * moving. The path is drawn relative to the hold's own centre, which is what
 * lets the gesture fold the offset into the base in the same frame it lets go
 * (see `SprayEditGestureOverlay`), so the ring never flickers back to where it
 * started while JS commits the move.
 *
 * Lives inside the board's zoom transform (`renderInTransform`), so it tracks
 * the photo at any zoom for free.
 */
export const SelectedHoldOverlay = React.memo(function SelectedHoldOverlay({
  hold,
  revision,
  selectedHoldSV,
  dragOffsetXSV,
  dragOffsetYSV,
  dragHoldIdSV,
  scaleSV,
  boardScale,
}: SelectedHoldOverlayProps) {
  const { brandColors } = useTheme();
  const zoomStep = useZoomStrokeStep(scaleSV);

  // Re-sync the base from the reducer before paint. Layout effect, not effect:
  // the path below changes in this same commit, and a frame drawn with the new
  // path at the old base would jump.
  useLayoutEffect(() => {
    selectedHoldSV.value = hold ? [hold.id, hold.cx, hold.cy, hold.r] : [];
    // A long press selects AND starts the drag, and the finger can be moving
    // before JS renders that selection. Zeroing the offset then would snap the
    // ring back under a finger that is still carrying it, so a drag of this
    // same hold keeps its offset; the drag's own end folds it in.
    if (hold && dragHoldIdSV.value === hold.id) return;
    dragOffsetXSV.value = 0;
    dragOffsetYSV.value = 0;
  }, [hold, revision, selectedHoldSV, dragOffsetXSV, dragOffsetYSV, dragHoldIdSV]);

  const shape = useMemo(() => {
    if (!hold) return null;
    // The hold's farthest reach from its centre: the traced ring can stick out
    // past `r`, a plain circle cannot.
    let reach = hold.r;
    if (hold.outline) {
      for (let index = 0; index + 1 < hold.outline.length; index += 2) {
        reach = Math.max(reach, Math.hypot(hold.outline[index], hold.outline[index + 1]) * hold.r);
      }
    }
    const extent = reach + HALO_MARGIN_RENDER_PX * boardScale;
    return {
      extent,
      sizeRender: (extent * 2) / boardScale,
      path: holdPathData({ cx: 0, cy: 0, r: hold.r, outline: hold.outline }),
    };
  }, [hold, boardScale]);

  const sizeRender = shape?.sizeRender ?? 0;
  const positionStyle = useAnimatedStyle(() => {
    const base = selectedHoldSV.value;
    if (base.length < 4 || boardScale <= 0) return { opacity: 0, transform: [{ translateX: 0 }, { translateY: 0 }] };
    const centreX = (base[1] + dragOffsetXSV.value) / boardScale;
    const centreY = (base[2] + dragOffsetYSV.value) / boardScale;
    return {
      opacity: 1,
      transform: [{ translateX: centreX - sizeRender / 2 }, { translateY: centreY - sizeRender / 2 }],
    };
  }, [boardScale, sizeRender]);

  if (!shape) return null;

  const widthAtZoom = SELECTED.width / zoomStep;
  const haloAtZoom = SELECTED.haloWidth / zoomStep;

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.box, { width: shape.sizeRender, height: shape.sizeRender }, positionStyle]}
    >
      <Svg
        width={shape.sizeRender}
        height={shape.sizeRender}
        viewBox={`${-shape.extent} ${-shape.extent} ${shape.extent * 2} ${shape.extent * 2}`}
      >
        <Path
          d={shape.path}
          fill={brandColors.primaryFill}
          fillOpacity={SELECTED.fillOpacity}
          stroke={brandColors.primaryFill}
          strokeWidth={haloAtZoom}
          vectorEffect="non-scaling-stroke"
        />
        <Path
          d={shape.path}
          fill="none"
          stroke={overlays.onScrim}
          strokeWidth={widthAtZoom}
          vectorEffect="non-scaling-stroke"
        />
      </Svg>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
});
