import React, { type MutableRefObject } from 'react';
import type { GestureType } from 'react-native-gesture-handler';
import { useSharedValue, type DerivedValue, type SharedValue } from 'react-native-reanimated';
import { DrawStrokeOverlay } from './DrawStrokeOverlay';

type SprayPencilSurfaceProps = {
  /** The live stroke, in board px. The screen's draft, which the ring layer draws. */
  pointsSV: SharedValue<number[]>;
  /** The selected hold as `[id, cx, cy, r]`: a Pencil touch inside it is a move, not a stroke. */
  selectedHoldSV: SharedValue<number[]>;
  /**
   * The wall's flat hit list, the one the edit overlay's move reads, so a
   * Pencil touch is declined exactly when that move claims it.
   */
  hitHoldsSV: SharedValue<number[]>;
  scaleSV: SharedValue<number>;
  translateXSV: DerivedValue<number>;
  translateYSV: DerivedValue<number>;
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
 * touch the selected hold's move claims (`declineOnSelectionSV`, by the move's
 * own `selectedDragIdAt` rule); both fall through to the
 * edit overlay around it, where a finger picks and a Pencil on the selection
 * moves it. Everything else the Pencil does — a tap or a stroke — comes back
 * through `onStrokeEnd` for the screen to sort out. A Pencil touch past the
 * photo's edge never starts a stroke (`startsOnPhotoOnly`): it falls through
 * too, where its tap only puts the picked hold down.
 */
export const SprayPencilSurface = React.memo(function SprayPencilSurface({
  pointsSV,
  selectedHoldSV,
  hitHoldsSV,
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
      declineHitHoldsSV={hitHoldsSV}
      onStylusSeen={onStylusSeen}
      startsOnPhotoOnly
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
