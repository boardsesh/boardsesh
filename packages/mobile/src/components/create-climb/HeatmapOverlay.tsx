import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { HoldStat } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { holdGeometry } from './holdLayout';

type HeatmapOverlayProps = {
  statsByHoldId: Map<number, HoldStat>;
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  measuredWidth: number;
  mirrored?: boolean;
  paintedHoldIds: Set<number>;
};

const HEAT_RAMP = ['#22C55E', '#A3E635', '#FACC15', '#FB923C', '#EF4444'] as const;
const DISC_OPACITY = 0.7;
const DISC_RADIUS_MULTIPLIER = 1.4;

export type HeatmapDisc = {
  id: number;
  leftPct: number;
  topPct: number;
  diameter: number;
  color: string;
};

export function heatmapRampColor(intensity: number): string {
  const clamped = Math.max(0, Math.min(1, intensity));
  const index = Math.min(HEAT_RAMP.length - 1, Math.round(clamped * (HEAT_RAMP.length - 1)));
  return HEAT_RAMP[index];
}

export function buildHeatmapDiscs({
  statsByHoldId,
  holdTargets,
  boardWidth,
  boardHeight,
  measuredWidth,
  mirrored,
  paintedHoldIds,
}: HeatmapOverlayProps): HeatmapDisc[] {
  let maxUses = 0;
  for (const holdStat of statsByHoldId.values()) maxUses = Math.max(maxUses, holdStat.totalUses);
  if (maxUses <= 0) return [];

  const logMaxUses = Math.log1p(maxUses);
  return holdTargets.flatMap((target) => {
    if (paintedHoldIds.has(target.id)) return [];
    const holdStat = statsByHoldId.get(target.id);
    if (!holdStat || holdStat.totalUses <= 0) return [];

    const intensity = Math.log1p(holdStat.totalUses) / logMaxUses;
    const geometry = holdGeometry(
      target,
      boardWidth,
      boardHeight,
      measuredWidth,
      mirrored ?? false,
      DISC_RADIUS_MULTIPLIER,
    );
    return [
      {
        id: target.id,
        leftPct: geometry.leftPct,
        topPct: geometry.topPct,
        diameter: geometry.ringDiameter,
        color: heatmapRampColor(intensity),
      },
    ];
  });
}

/** Usage discs positioned from the exact renderer targets inside the board zoom transform. */
export const HeatmapOverlay = memo(function HeatmapOverlay({
  statsByHoldId,
  holdTargets,
  boardWidth,
  boardHeight,
  measuredWidth,
  mirrored = false,
  paintedHoldIds,
}: HeatmapOverlayProps) {
  const discs = useMemo(
    () =>
      buildHeatmapDiscs({
        statsByHoldId,
        holdTargets,
        boardWidth,
        boardHeight,
        measuredWidth,
        mirrored,
        paintedHoldIds,
      }),
    [statsByHoldId, holdTargets, boardWidth, boardHeight, measuredWidth, mirrored, paintedHoldIds],
  );

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {discs.map((disc) => (
        <View
          key={disc.id}
          pointerEvents="none"
          style={[
            styles.disc,
            {
              left: `${disc.leftPct}%`,
              top: `${disc.topPct}%`,
              width: disc.diameter,
              height: disc.diameter,
              marginLeft: -disc.diameter / 2,
              marginTop: -disc.diameter / 2,
              borderRadius: disc.diameter / 2,
              backgroundColor: disc.color,
            },
          ]}
        />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  disc: {
    position: 'absolute',
    opacity: DISC_OPACITY,
  },
});
