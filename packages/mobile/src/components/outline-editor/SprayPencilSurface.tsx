import React, { type MutableRefObject } from 'react';
import type { GestureType } from 'react-native-gesture-handler';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { DrawStrokeOverlay } from './DrawStrokeOverlay';

type SprayPencilSurfaceProps = {
  /** The live stroke, in board px. The screen's draft, which the ring layer draws. */
  pointsSV: SharedValue<number[]>;
  /** The selected hold as `[id, cx, cy, r]`: a Pencil touch inside it is a move, not a stroke. */
  selectedHoldSV: SharedValue<number[]>;
  scaleSV: SharedValue<number>;
  translateXSV: SharedValue<number>;
  translateYSV: SharedValue<number>;
  containerWidthSV: SharedValue<number>;
  containerHeightSV: SharedValue<number>;
  boardScale: number;
  pinchRef: MutableRefObject<GestureType | undefined>;
  onStrokeStart: () => void;
  /** A whole stroke or a stationary tap, in board px. The screen decides which it was. */
  onStrokeEnd: (boardPoints: number[]) => void;
  onStrokeCancel: () => void;
  onStylusSeen: () => void;
};

/**
 * The iPad editor's resting Pencil surface: the Add tool's draw overlay, Pencil
 * only, nested inside `SprayEditGestureOverlay` so the Pencil always marks
 * without a mode.
 *
 * Every finger fails at touch-down (finger draw is off), and so does a Pencil
 * touch on the selected hold (`declineOnSelectionSV`); both fall through to the
 * edit overlay around it, where a finger picks and a Pencil on the selection
 * moves it. Everything else the Pencil does — a tap or a stroke — comes back
 * through `onStrokeEnd` for the screen to sort out.
 */
export const SprayPencilSurface = React.memo(function SprayPencilSurface({
  pointsSV,
  selectedHoldSV,
  scaleSV,
  translateXSV,
  translateYSV,
  containerWidthSV,
  containerHeightSV,
  boardScale,
  pinchRef,
  onStrokeStart,
  onStrokeEnd,
  onStrokeCancel,
  onStylusSeen,
}: SprayPencilSurfaceProps) {
  const fingersNeverDrawSV = useSharedValue(false);
  return (
    <DrawStrokeOverlay
      pointsSV={pointsSV}
      acceptStationaryTaps
      fingerDrawSV={fingersNeverDrawSV}
      declineOnSelectionSV={selectedHoldSV}
      onStylusSeen={onStylusSeen}
      scaleSV={scaleSV}
      translateXSV={translateXSV}
      translateYSV={translateYSV}
      containerWidthSV={containerWidthSV}
      containerHeightSV={containerHeightSV}
      boardScale={boardScale}
      pinchRef={pinchRef}
      onStrokeStart={onStrokeStart}
      onStrokeEnd={onStrokeEnd}
      onStrokeCancel={onStrokeCancel}
    />
  );
});
