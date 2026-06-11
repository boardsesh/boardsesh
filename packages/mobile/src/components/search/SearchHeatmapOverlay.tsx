import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import type { HoldHeatmapPoint } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { holdGeometry } from '../create-climb/holdLayout';

export type SearchHeatmapMode = 'total' | 'start' | 'handsFeet' | 'finish';

type SearchHeatmapOverlayProps = {
  heatmapData: HoldHeatmapPoint[];
  mode: SearchHeatmapMode;
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  measuredWidth: number;
  mirrored: boolean;
};

type HeatmapMarker = {
  holdId: number;
  leftPct: number;
  topPct: number;
  diameter: number;
  innerDiameter: number;
  color: string;
  opacity: number;
};

const HEATMAP_COLORS = ['#2DD4BF', '#A3E635', '#FACC15', '#FB923C', '#EF4444'] as const;

export const SearchHeatmapOverlay = React.memo(function SearchHeatmapOverlay({
  heatmapData,
  mode,
  holdTargets,
  boardWidth,
  boardHeight,
  measuredWidth,
  mirrored,
}: SearchHeatmapOverlayProps) {
  const markers = useMemo(() => {
    if (measuredWidth <= 0 || heatmapData.length === 0) return [];
    const statsByHold = new Map(heatmapData.map((point) => [point.holdId, point]));
    const rawMarkers = holdTargets
      .map((hold) => {
        const point = statsByHold.get(hold.id);
        const value = point ? valueForMode(point, mode) : 0;
        if (value <= 0) return null;
        const geometry = holdGeometry(hold, boardWidth, boardHeight, measuredWidth, mirrored, 1.2);
        return { holdId: hold.id, value, geometry };
      })
      .filter((marker): marker is NonNullable<typeof marker> => marker != null);

    const maxValue = Math.max(1, ...rawMarkers.map((marker) => marker.value));
    const logMax = Math.log1p(maxValue);

    return rawMarkers.map<HeatmapMarker>(({ holdId, value, geometry }) => {
      const ratio = Math.max(0, Math.min(1, Math.log1p(value) / logMax));
      const diameter = Math.max(geometry.ringDiameter * (2.1 + ratio * 1.4), 12);
      const innerDiameter = Math.max(geometry.ringDiameter * (0.8 + ratio * 0.35), 5);
      return {
        holdId,
        leftPct: geometry.leftPct,
        topPct: geometry.topPct,
        diameter,
        innerDiameter,
        color: colorForRatio(ratio),
        opacity: 0.24 + ratio * 0.46,
      };
    });
  }, [heatmapData, mode, holdTargets, boardWidth, boardHeight, measuredWidth, mirrored]);

  if (markers.length === 0) return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {markers.map((marker) => {
        const radius = marker.diameter / 2;
        const innerRadius = marker.innerDiameter / 2;
        return (
          <React.Fragment key={marker.holdId}>
            <View
              pointerEvents="none"
              style={[
                styles.absolute,
                {
                  left: `${marker.leftPct}%`,
                  top: `${marker.topPct}%`,
                  width: marker.diameter,
                  height: marker.diameter,
                  marginLeft: -radius,
                  marginTop: -radius,
                  borderRadius: radius,
                  backgroundColor: marker.color,
                  opacity: marker.opacity,
                },
              ]}
            />
            <View
              pointerEvents="none"
              style={[
                styles.absolute,
                {
                  left: `${marker.leftPct}%`,
                  top: `${marker.topPct}%`,
                  width: marker.innerDiameter,
                  height: marker.innerDiameter,
                  marginLeft: -innerRadius,
                  marginTop: -innerRadius,
                  borderRadius: innerRadius,
                  backgroundColor: marker.color,
                  opacity: Math.min(0.95, marker.opacity + 0.2),
                },
              ]}
            />
          </React.Fragment>
        );
      })}
    </View>
  );
});

function valueForMode(point: HoldHeatmapPoint, mode: SearchHeatmapMode): number {
  switch (mode) {
    case 'start':
      return point.startingUses;
    case 'handsFeet':
      return point.handUses + point.footUses;
    case 'finish':
      return point.finishUses;
    case 'total':
    default:
      return point.totalUses;
  }
}

function colorForRatio(ratio: number): string {
  const index = Math.min(HEATMAP_COLORS.length - 1, Math.floor(ratio * HEATMAP_COLORS.length));
  return HEATMAP_COLORS[index];
}

const styles = StyleSheet.create({
  absolute: {
    position: 'absolute',
  },
});
