import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import {
  getEffectiveHoldStateColor,
  getEffectiveHoldStateShape,
  useHoldColorOverrides,
} from '../../lib/hold-color-overrides';
import { holdGeometry } from './holdLayout';
import { PaintedRing } from './PaintedRing';

type PaintedHoldsLayerProps = {
  litUpHoldsMap: LitUpHoldsMap;
  holdById: Map<number, BoardHoldTarget>;
  boardWidth: number;
  boardHeight: number;
  measuredWidth: number;
  mirrored: boolean;
};

/**
 * Absolute overlay drawing one PaintedRing per painted hold. This is the only
 * layer that re-renders on a brush tap, and it maps over `litUpHoldsMap` (a
 * handful of holds) rather than every hold on the board.
 */
export const PaintedHoldsLayer = React.memo(function PaintedHoldsLayer({
  litUpHoldsMap,
  holdById,
  boardWidth,
  boardHeight,
  measuredWidth,
  mirrored,
}: PaintedHoldsLayerProps) {
  const {
    overrides: holdColorOverrides,
    shapes: holdShapeOverrides,
    brushThickness,
    shapeSize,
  } = useHoldColorOverrides();

  const rings = useMemo(() => {
    if (measuredWidth <= 0) return [];
    return Object.entries(litUpHoldsMap)
      .map(([holdIdStr, hold]) => {
        const holdId = Number(holdIdStr);
        const target = holdById.get(holdId);
        if (!target) return null;
        const geometry = holdGeometry(target, boardWidth, boardHeight, measuredWidth, mirrored);
        return (
          <PaintedRing
            key={holdId}
            leftPct={geometry.leftPct}
            topPct={geometry.topPct}
            diameter={geometry.ringDiameter}
            color={getEffectiveHoldStateColor(hold.state, hold.displayColor || hold.color, holdColorOverrides)}
            shape={getEffectiveHoldStateShape(hold.state, holdShapeOverrides)}
            brushThickness={brushThickness}
            shapeSize={shapeSize}
          />
        );
      })
      .filter(Boolean);
  }, [
    litUpHoldsMap,
    holdById,
    boardWidth,
    boardHeight,
    measuredWidth,
    mirrored,
    holdColorOverrides,
    holdShapeOverrides,
    brushThickness,
    shapeSize,
  ]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {rings}
    </View>
  );
});
