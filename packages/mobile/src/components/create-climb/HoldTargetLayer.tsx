import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { holdGeometry, holdMarkerAppearance } from './holdLayout';
import { HoldTarget } from './HoldTarget';

type HoldTargetLayerProps = {
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  measuredWidth: number;
  mirrored: boolean;
  /** When true, every hold gets a brighter, larger discoverability dot. */
  showAllHolds: boolean;
  /** When false the layer draws nothing: the dots are all it renders. */
  showHoldMarkers?: boolean;
};

/**
 * Static, memoized layer of one discoverability dot per hold, drawn ABOVE the
 * board — right on a surface that renders no holds of its own (the search filter
 * board) and wrong on one that does, so the create board draws its dots with
 * `HoldMarkerLayer` underneath the rendered overlay instead. Independent of the
 * painted state, so it never re-renders when a hold is painted.
 *
 * Markers only: `pointerEvents="none"` throughout, no gestures. Taps are
 * arbitrated by the board's single full-bleed overlay (`useRestHoldTapGesture`
 * at rest, `useZoomedHoldTapGesture` while zoomed), which resolves a point to
 * the *nearest* hold centre. Per-hold detectors used to live here and were
 * arbitrated by view z-order over tap squares inflated to
 * `max(ringDiameter * 1.6, 44)` px so small holds stayed reachable; at
 * fit-to-screen those overlap so heavily that the last-rendered hold won every
 * touch inside its square, however far off-centre the finger landed (#4496).
 */
export const HoldTargetLayer = React.memo(function HoldTargetLayer({
  holdTargets,
  boardWidth,
  boardHeight,
  measuredWidth,
  mirrored,
  showAllHolds,
  showHoldMarkers = true,
}: HoldTargetLayerProps) {
  const targets = useMemo(() => {
    if (measuredWidth <= 0) return null;
    // Nothing to draw — skip the per-hold Views entirely rather than mounting
    // hundreds of invisible boxes.
    if (!showHoldMarkers) return null;
    return holdTargets.map((hold) => {
      const geometry = holdGeometry(hold, boardWidth, boardHeight, measuredWidth, mirrored);
      const marker = holdMarkerAppearance(geometry, showAllHolds);
      return (
        <HoldTarget
          key={hold.id}
          leftPct={geometry.leftPct}
          topPct={geometry.topPct}
          dotDiameter={marker.diameter}
          dotColor={marker.color}
        />
      );
    });
  }, [holdTargets, boardWidth, boardHeight, measuredWidth, mirrored, showAllHolds, showHoldMarkers]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {targets}
    </View>
  );
});
