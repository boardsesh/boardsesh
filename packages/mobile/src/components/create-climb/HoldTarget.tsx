import React from 'react';
import { View } from 'react-native';

type HoldTargetProps = {
  leftPct: number;
  topPct: number;
  /** Diameter of the faint discoverability dot, in device px. */
  dotDiameter: number;
  dotColor: string;
};

/**
 * One hold's discoverability dot. Purely visual — `pointerEvents="none"`, no
 * gesture of its own.
 *
 * It used to own a transparent tap target inflated to
 * `max(ringDiameter * 1.6, 44)` px with its own `GestureDetector`. Those squares
 * overlap heavily at fit-to-screen and overlapping sibling Views are arbitrated
 * by z-order, so the last hold in the list won every touch inside its square
 * however far off-centre the finger landed (#4496). Boards now resolve a tap
 * through one full-bleed overlay — `useRestHoldTapGesture` at rest,
 * `useZoomedHoldTapGesture` while zoomed — which picks the nearest hold centre.
 * Don't re-add a per-hold detector here: it would sit above the overlay and
 * start winning touches by z-order again.
 *
 * `React.memo` leaf with primitive props — the marker layer never re-renders
 * when holds are painted.
 */
export const HoldTarget = React.memo(function HoldTarget({ leftPct, topPct, dotDiameter, dotColor }: HoldTargetProps) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: `${leftPct}%`,
        top: `${topPct}%`,
        width: dotDiameter,
        height: dotDiameter,
        marginLeft: -dotDiameter / 2,
        marginTop: -dotDiameter / 2,
        borderRadius: dotDiameter / 2,
        backgroundColor: dotColor,
      }}
    />
  );
});
