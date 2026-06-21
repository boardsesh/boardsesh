import React from 'react';
import { StyleSheet, View } from 'react-native';
import { HoldMarkerShapeSvg } from '../board-renderer/HoldMarkerShape';
import type { HoldMarkerShape } from '../../lib/hold-color-overrides';
import { hexWithAlpha } from './holdLayout';

type PaintedRingProps = {
  leftPct: number;
  topPct: number;
  diameter: number;
  /** Display color of the hold's role (from HOLD_STATE_MAP displayColor). */
  color: string;
  shape: HoldMarkerShape;
  brushThickness: number;
  shapeSize: number;
};

/**
 * A single painted-hold indicator: a translucent filled ring centred on the
 * hold. Circles stay on a plain RN View path; custom shapes use SVG only when
 * needed. `React.memo` with primitive props keeps the painted layer cheap.
 */
export const PaintedRing = React.memo(function PaintedRing({
  leftPct,
  topPct,
  diameter,
  color,
  shape,
  brushThickness,
  shapeSize,
}: PaintedRingProps) {
  const markerDiameter = diameter * shapeSize;
  const strokeWidth = Math.max(2, diameter * 0.15 * brushThickness);
  if (shape === 'circle') {
    return (
      <View
        pointerEvents="none"
        style={[
          styles.ring,
          {
            left: `${leftPct}%`,
            top: `${topPct}%`,
            width: markerDiameter,
            height: markerDiameter,
            borderRadius: markerDiameter / 2,
            marginLeft: -markerDiameter / 2,
            marginTop: -markerDiameter / 2,
            borderWidth: strokeWidth,
            borderColor: color,
            backgroundColor: hexWithAlpha(color, 0.28),
          },
        ]}
      />
    );
  }

  return (
    <HoldMarkerShapeSvg
      pointerEvents="none"
      shape={shape}
      color={color}
      diameter={markerDiameter}
      strokeWidth={strokeWidth}
      fillOpacity={0.28}
      style={[
        styles.ring,
        {
          left: `${leftPct}%`,
          top: `${topPct}%`,
          marginLeft: -markerDiameter / 2,
          marginTop: -markerDiameter / 2,
        },
      ]}
    />
  );
});

const styles = StyleSheet.create({
  ring: {
    position: 'absolute',
  },
});
