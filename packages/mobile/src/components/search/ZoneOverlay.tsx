import React, { useCallback, useEffect, useMemo } from 'react';
import { StyleSheet, View, type ColorValue, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, runOnJS, type SharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import type { ZoneBoxInput } from '@boardsesh/shared-schema';
import {
  clampZoneBox,
  computeHandleRadius,
  gridToSvg,
  svgToGrid,
  type BoardDimensions,
  type DragMode,
} from '@boardsesh/climb-filters';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';

// Apple HIG / Material minimum touch target. Glass uses 44, Material 48; we take
// the larger so the transparent hit area satisfies both variants.
const MIN_HIT = 48;
// Step (in grid units) a single VoiceOver increment/decrement resizes a corner —
// keeps the adjustable action usable without a precise drag.
const A11Y_STEP = 2;

const ACCESSIBILITY_ACTIONS = [{ name: 'increment' as const }, { name: 'decrement' as const }];

type RenderRect = { left: number; top: number; width: number; height: number };

/** Per-corner a11y label (e.g. "Top-left corner"); the body uses `bodyLabel`. */
export type ZoneCornerLabels = Record<Exclude<DragMode, 'move'>, string>;

type ZoneOverlayProps = {
  zoneBox: ZoneBoxInput;
  dims: BoardDimensions;
  renderWidth: number;
  renderHeight: number;
  /** Live zoom scale, so screen-pixel drags convert to unscaled board pixels. */
  zoomScale: SharedValue<number>;
  /** Commit the clamped grid box to JS state — fired once per gesture end. */
  onCommit: (box: ZoneBoxInput) => void;
  /** Compose each handle/body pan with the board's pinch so 2-finger still wins. */
  boardPinch: GestureType;
  brandColor: ColorValue;
  scrimColor: ColorValue;
  bodyLabel: string;
  bodyHint: string;
  cornerLabels: ZoneCornerLabels;
};

// A grid-space zone box → a render-pixel rectangle. gridToSvg already inverts Y
// (grid origin bottom-left, render origin top-left), so edgeTop is the small
// render-y and edgeBottom the large one.
function gridBoxToRenderRect(box: ZoneBoxInput, dims: BoardDimensions, renderWidth: number): RenderRect {
  const renderScale = renderWidth / dims.boardWidth;
  const topLeft = gridToSvg(box.edgeLeft, box.edgeTop, dims);
  const bottomRight = gridToSvg(box.edgeRight, box.edgeBottom, dims);
  return {
    left: topLeft.x * renderScale,
    top: topLeft.y * renderScale,
    width: (bottomRight.x - topLeft.x) * renderScale,
    height: (bottomRight.y - topLeft.y) * renderScale,
  };
}

// Inverse of gridBoxToRenderRect — a render-pixel rect back to a grid box, then
// clamped (board edges + 5% min size) so what we commit always round-trips.
function renderRectToGridBox(rect: RenderRect, dims: BoardDimensions, renderWidth: number): ZoneBoxInput {
  const renderScale = renderWidth / dims.boardWidth;
  const topLeftGrid = svgToGrid(rect.left / renderScale, rect.top / renderScale, dims);
  const bottomRightGrid = svgToGrid(
    (rect.left + rect.width) / renderScale,
    (rect.top + rect.height) / renderScale,
    dims,
  );
  return clampZoneBox(
    {
      edgeLeft: topLeftGrid.x,
      edgeRight: bottomRightGrid.x,
      // grid Y is inverted vs render Y: the rect's top edge is the larger grid Y.
      edgeBottom: bottomRightGrid.y,
      edgeTop: topLeftGrid.y,
    },
    dims,
  );
}

type Corner = { mode: Exclude<DragMode, 'move'>; anchorX: 'left' | 'right'; anchorY: 'top' | 'bottom' };

const CORNERS: ReadonlyArray<Corner> = [
  { mode: 'nw', anchorX: 'left', anchorY: 'top' },
  { mode: 'ne', anchorX: 'right', anchorY: 'top' },
  { mode: 'sw', anchorX: 'left', anchorY: 'bottom' },
  { mode: 'se', anchorX: 'right', anchorY: 'bottom' },
];

/**
 * The draggable rectangle + 4 corner handles for the board-region search
 * filter, rendered INSIDE `InteractiveFilterBoard`'s zoom transform (as its
 * `children`) so it tracks the board at any zoom. The rectangle's edges live on
 * the UI thread as shared values (in render-pixel space); pans mutate them per
 * frame with zero React renders and commit the clamped grid box to JS only on
 * gesture end. A scrim dims the board outside the box.
 *
 * Works in both UI variants: chrome is plain RN Views tinted from `useTheme()`
 * (brand stroke, scrim), so no variant branch is needed here.
 */
export const ZoneOverlay = React.memo(function ZoneOverlay({
  zoneBox,
  dims,
  renderWidth,
  renderHeight,
  zoomScale,
  onCommit,
  boardPinch,
  brandColor,
  scrimColor,
  bodyLabel,
  bodyHint,
  cornerLabels,
}: ZoneOverlayProps) {
  const { systemColors } = useTheme();

  // Live render-pixel rect, the single source of truth the gestures mutate.
  const left = useSharedValue(0);
  const top = useSharedValue(0);
  const width = useSharedValue(0);
  const height = useSharedValue(0);

  // Snapshot at gesture start so per-frame updates apply against a fixed base.
  const startLeft = useSharedValue(0);
  const startTop = useSharedValue(0);
  const startWidth = useSharedValue(0);
  const startHeight = useSharedValue(0);

  // Board-min-size clamp bound in render pixels, mirrored onto the UI thread.
  const minRenderSize = useSharedValue(0);

  // Sync the shared rect whenever the committed grid box (or layout) changes.
  // After a commit the prop updates and we re-seed, so drag handoff is seamless.
  useEffect(() => {
    if (renderWidth <= 0 || renderHeight <= 0) return;
    const rect = gridBoxToRenderRect(zoneBox, dims, renderWidth);
    left.value = rect.left;
    top.value = rect.top;
    width.value = rect.width;
    height.value = rect.height;
    const renderScale = renderWidth / dims.boardWidth;
    const minGrid = Math.max(1, Math.round((dims.edgeRight - dims.edgeLeft) * 0.05));
    const gridToRenderPx = (dims.boardWidth / (dims.edgeRight - dims.edgeLeft)) * renderScale;
    minRenderSize.value = minGrid * gridToRenderPx;
  }, [zoneBox, dims, renderWidth, renderHeight, left, top, width, height, minRenderSize]);

  const commit = useCallback(
    (rect: RenderRect) => {
      hapticSelection();
      onCommit(renderRectToGridBox(rect, dims, renderWidth));
    },
    [dims, renderWidth, onCommit],
  );

  // Clamp a render-pixel rect to the board surface + minimum size on the UI
  // thread. Mirrors clampZoneBox semantics in render-pixel space.
  const clampRectWorklet = useCallback(
    (rect: RenderRect): RenderRect => {
      'worklet';
      const minSize = minRenderSize.value;
      let rectLeft = rect.left;
      let rectTop = rect.top;
      let rectWidth = rect.width;
      let rectHeight = rect.height;
      if (rectWidth < minSize) rectWidth = minSize;
      if (rectHeight < minSize) rectHeight = minSize;
      if (rectWidth > renderWidth) rectWidth = renderWidth;
      if (rectHeight > renderHeight) rectHeight = renderHeight;
      if (rectLeft < 0) rectLeft = 0;
      if (rectTop < 0) rectTop = 0;
      if (rectLeft + rectWidth > renderWidth) rectLeft = renderWidth - rectWidth;
      if (rectTop + rectHeight > renderHeight) rectTop = renderHeight - rectHeight;
      return { left: rectLeft, top: rectTop, width: rectWidth, height: rectHeight };
    },
    [minRenderSize, renderWidth, renderHeight],
  );

  const handleRadius = useMemo(() => {
    const renderScale = renderWidth > 0 ? renderWidth / dims.boardWidth : 1;
    return computeHandleRadius(dims) * renderScale;
  }, [dims, renderWidth]);

  // Body pan (move). maxPointers(1) so a 2-finger pinch never starts a drag;
  // Simultaneous-composed with the board pinch so pinch-to-zoom still wins while
  // a finger is over the overlay.
  const bodyGesture = useMemo(
    () =>
      Gesture.Simultaneous(
        Gesture.Pan()
          .maxPointers(1)
          .onStart(() => {
            'worklet';
            startLeft.value = left.value;
            startTop.value = top.value;
            startWidth.value = width.value;
            startHeight.value = height.value;
          })
          .onUpdate((event) => {
            'worklet';
            const dx = event.translationX / zoomScale.value;
            const dy = event.translationY / zoomScale.value;
            const next = clampRectWorklet({
              left: startLeft.value + dx,
              top: startTop.value + dy,
              width: startWidth.value,
              height: startHeight.value,
            });
            left.value = next.left;
            top.value = next.top;
            width.value = next.width;
            height.value = next.height;
          })
          .onEnd(() => {
            'worklet';
            runOnJS(commit)({ left: left.value, top: top.value, width: width.value, height: height.value });
          }),
        boardPinch,
      ),
    [
      boardPinch,
      clampRectWorklet,
      commit,
      height,
      left,
      startHeight,
      startLeft,
      startTop,
      startWidth,
      top,
      width,
      zoomScale,
    ],
  );

  // VoiceOver move: nudge the whole box without a drag, so it's usable without
  // the gesture. Clamp keeps it on the board.
  const moveByGrid = useCallback(
    (direction: 1 | -1) => {
      const delta = direction * A11Y_STEP;
      onCommit(
        clampZoneBox(
          {
            edgeLeft: zoneBox.edgeLeft + delta,
            edgeRight: zoneBox.edgeRight + delta,
            edgeBottom: zoneBox.edgeBottom + delta,
            edgeTop: zoneBox.edgeTop + delta,
          },
          dims,
        ),
      );
    },
    [dims, onCommit, zoneBox],
  );

  const onBodyAccessibilityAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      if (event.nativeEvent.actionName === 'increment') moveByGrid(1);
      else if (event.nativeEvent.actionName === 'decrement') moveByGrid(-1);
    },
    [moveByGrid],
  );

  const bodyStyle = useAnimatedStyle(() => ({
    left: left.value,
    top: top.value,
    width: width.value,
    height: height.value,
  }));

  // Four scrim panels (top / bottom / left / right of the box) dim the board
  // outside the rectangle, tracking the live box.
  const scrimTopStyle = useAnimatedStyle(() => ({ height: Math.max(0, top.value) }));
  const scrimBottomStyle = useAnimatedStyle(() => ({
    top: top.value + height.value,
    height: Math.max(0, renderHeight - (top.value + height.value)),
  }));
  const scrimLeftStyle = useAnimatedStyle(() => ({
    top: top.value,
    width: Math.max(0, left.value),
    height: height.value,
  }));
  const scrimRightStyle = useAnimatedStyle(() => ({
    left: left.value + width.value,
    top: top.value,
    width: Math.max(0, renderWidth - (left.value + width.value)),
    height: height.value,
  }));

  if (renderWidth <= 0 || renderHeight <= 0) return null;

  const scrimColumn: ViewStyle = { position: 'absolute', left: 0, right: 0, backgroundColor: scrimColor };
  const scrimSide: ViewStyle = { position: 'absolute', left: 0, backgroundColor: scrimColor };

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View pointerEvents="none" style={[scrimColumn, styles.scrimTop, scrimTopStyle]} />
      <Animated.View pointerEvents="none" style={[scrimColumn, scrimBottomStyle]} />
      <Animated.View pointerEvents="none" style={[scrimSide, scrimLeftStyle]} />
      <Animated.View pointerEvents="none" style={[scrimSide, scrimRightStyle]} />

      <GestureDetector gesture={bodyGesture}>
        <Animated.View
          accessibilityRole="adjustable"
          accessible
          accessibilityLabel={bodyLabel}
          accessibilityHint={bodyHint}
          accessibilityActions={ACCESSIBILITY_ACTIONS}
          onAccessibilityAction={onBodyAccessibilityAction}
          style={[styles.rect, { borderColor: brandColor }, bodyStyle]}
        />
      </GestureDetector>

      {CORNERS.map((corner) => (
        <CornerHandle
          key={corner.mode}
          corner={corner}
          left={left}
          top={top}
          width={width}
          height={height}
          startLeft={startLeft}
          startTop={startTop}
          startWidth={startWidth}
          startHeight={startHeight}
          handleRadius={handleRadius}
          zoomScale={zoomScale}
          clampRectWorklet={clampRectWorklet}
          commit={commit}
          boardPinch={boardPinch}
          brandColor={brandColor}
          surfaceColor={systemColors.elevatedSurface}
          dims={dims}
          zoneBox={zoneBox}
          onCommit={onCommit}
          label={cornerLabels[corner.mode]}
        />
      ))}
    </View>
  );
});

type CornerHandleProps = {
  corner: Corner;
  left: SharedValue<number>;
  top: SharedValue<number>;
  width: SharedValue<number>;
  height: SharedValue<number>;
  startLeft: SharedValue<number>;
  startTop: SharedValue<number>;
  startWidth: SharedValue<number>;
  startHeight: SharedValue<number>;
  handleRadius: number;
  zoomScale: SharedValue<number>;
  clampRectWorklet: (rect: RenderRect) => RenderRect;
  commit: (rect: RenderRect) => void;
  boardPinch: GestureType;
  brandColor: ColorValue;
  surfaceColor: ColorValue;
  dims: BoardDimensions;
  zoneBox: ZoneBoxInput;
  onCommit: (box: ZoneBoxInput) => void;
  label: string;
};

const CornerHandle = React.memo(function CornerHandle({
  corner,
  left,
  top,
  width,
  height,
  startLeft,
  startTop,
  startWidth,
  startHeight,
  handleRadius,
  zoomScale,
  clampRectWorklet,
  commit,
  boardPinch,
  brandColor,
  surfaceColor,
  dims,
  zoneBox,
  onCommit,
  label,
}: CornerHandleProps) {
  const { mode, anchorX, anchorY } = corner;

  const gesture = useMemo(
    () =>
      Gesture.Simultaneous(
        Gesture.Pan()
          .maxPointers(1)
          .onStart(() => {
            'worklet';
            startLeft.value = left.value;
            startTop.value = top.value;
            startWidth.value = width.value;
            startHeight.value = height.value;
          })
          .onUpdate((event) => {
            'worklet';
            const dx = event.translationX / zoomScale.value;
            const dy = event.translationY / zoomScale.value;
            let nextLeft = startLeft.value;
            let nextTop = startTop.value;
            let nextWidth = startWidth.value;
            let nextHeight = startHeight.value;
            if (anchorX === 'left') {
              nextLeft = startLeft.value + dx;
              nextWidth = startWidth.value - dx;
            } else {
              nextWidth = startWidth.value + dx;
            }
            if (anchorY === 'top') {
              nextTop = startTop.value + dy;
              nextHeight = startHeight.value - dy;
            } else {
              nextHeight = startHeight.value + dy;
            }
            // A resize that would invert the box: pin the moving edge to the
            // opposite one before clamp re-expands to the minimum size.
            if (nextWidth < 0) {
              nextLeft = anchorX === 'left' ? startLeft.value + startWidth.value : startLeft.value;
              nextWidth = 0;
            }
            if (nextHeight < 0) {
              nextTop = anchorY === 'top' ? startTop.value + startHeight.value : startTop.value;
              nextHeight = 0;
            }
            const next = clampRectWorklet({ left: nextLeft, top: nextTop, width: nextWidth, height: nextHeight });
            left.value = next.left;
            top.value = next.top;
            width.value = next.width;
            height.value = next.height;
          })
          .onEnd(() => {
            'worklet';
            runOnJS(commit)({ left: left.value, top: top.value, width: width.value, height: height.value });
          }),
        boardPinch,
      ),
    [
      anchorX,
      anchorY,
      boardPinch,
      clampRectWorklet,
      commit,
      height,
      left,
      startHeight,
      startLeft,
      startTop,
      startWidth,
      top,
      width,
      zoomScale,
    ],
  );

  // Anchor the hit area centred on its corner of the live rect.
  const handleStyle = useAnimatedStyle(() => {
    const x = anchorX === 'left' ? left.value : left.value + width.value;
    const y = anchorY === 'top' ? top.value : top.value + height.value;
    return { left: x - MIN_HIT / 2, top: y - MIN_HIT / 2 };
  });

  // VoiceOver resize: grow/shrink the box from this corner without a drag.
  const adjust = useCallback(
    (direction: 1 | -1) => {
      const next: ZoneBoxInput = { ...zoneBox };
      const delta = direction * A11Y_STEP;
      if (mode === 'nw' || mode === 'sw') next.edgeLeft = zoneBox.edgeLeft - delta;
      if (mode === 'ne' || mode === 'se') next.edgeRight = zoneBox.edgeRight + delta;
      if (mode === 'nw' || mode === 'ne') next.edgeTop = zoneBox.edgeTop + delta;
      if (mode === 'sw' || mode === 'se') next.edgeBottom = zoneBox.edgeBottom - delta;
      onCommit(clampZoneBox(next, dims));
    },
    [dims, mode, onCommit, zoneBox],
  );

  const onAccessibilityAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      if (event.nativeEvent.actionName === 'increment') adjust(1);
      else if (event.nativeEvent.actionName === 'decrement') adjust(-1);
    },
    [adjust],
  );

  const dotSize = handleRadius * 1.5;

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessibilityRole="adjustable"
        accessible
        accessibilityLabel={label}
        accessibilityActions={ACCESSIBILITY_ACTIONS}
        onAccessibilityAction={onAccessibilityAction}
        style={[styles.handleHit, handleStyle]}
      >
        <View
          pointerEvents="none"
          style={{
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: brandColor,
            borderWidth: 2,
            borderColor: surfaceColor,
          }}
        />
      </Animated.View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  rect: {
    position: 'absolute',
    borderWidth: 2.5,
    borderRadius: 2,
  },
  scrimTop: {
    top: 0,
  },
  handleHit: {
    position: 'absolute',
    width: MIN_HIT,
    height: MIN_HIT,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
