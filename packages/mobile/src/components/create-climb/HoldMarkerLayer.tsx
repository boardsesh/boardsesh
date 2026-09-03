import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { holdGeometry, holdMarkerAppearance } from './holdLayout';

type HoldMarkerLayerProps = {
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  measuredWidth: number;
  mirrored: boolean;
  /** When true, every hold gets a brighter, larger discoverability dot. */
  showAllHolds: boolean;
};

/**
 * The discoverability dots on their own, drawn UNDER the board's holds overlay.
 *
 * They are split out from the tap targets purely for depth. A dot marks an
 * UNLIT hold you might want to tap; once a hold is lit, the renderer's fill and
 * role glyph are the thing to read, and a dot painted over the middle of them
 * is noise. The targets have to stay on top — they catch the touch — so the
 * marks come down here instead, into the layer between the board photo and the
 * holds (see `LayeredClimbImage`'s `underOverlay`).
 *
 * Like the target layer, this is independent of painted state: neither
 * re-renders when a hold is painted.
 */
export const HoldMarkerLayer = React.memo(function HoldMarkerLayer({
  holdTargets,
  boardWidth,
  boardHeight,
  measuredWidth,
  mirrored,
  showAllHolds,
}: HoldMarkerLayerProps) {
  const markers = useMemo(() => {
    if (measuredWidth <= 0) return null;
    return holdTargets.map((hold) => {
      const geometry = holdGeometry(hold, boardWidth, boardHeight, measuredWidth, mirrored);
      const { diameter, color } = holdMarkerAppearance(geometry, showAllHolds);
      return (
        <View
          key={hold.id}
          style={{
            position: 'absolute',
            left: `${geometry.leftPct}%`,
            top: `${geometry.topPct}%`,
            width: diameter,
            height: diameter,
            marginLeft: -diameter / 2,
            marginTop: -diameter / 2,
            borderRadius: diameter / 2,
            backgroundColor: color,
          }}
        />
      );
    });
  }, [holdTargets, boardWidth, boardHeight, measuredWidth, mirrored, showAllHolds]);

  if (!markers) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {markers}
    </View>
  );
});
