import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { HoldStat } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../lib/create-board-holds';

type HeatmapOverlayProps = {
  /** Aggregate usage per hold id (community totals). */
  statsByHoldId: Map<number, HoldStat>;
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  mirrored?: boolean;
  /** Hold ids the user has already painted — skip them so the overlay never
   *  covers the working climb. */
  paintedHoldIds: Set<number>;
};

// Green → red ramp, low usage (cool) to high usage (hot). Five fixed stops so
// the colour is deterministic across renders without any HSL math at draw time.
const RAMP = ['#22c55e', '#a3e635', '#facc15', '#fb923c', '#ef4444'] as const;

const DISC_OPACITY = 0.7;
// Disc diameter as a multiple of the hold radius — a touch larger than the
// painted ring so the heat reads as a soft blob rather than a precise marker.
const DISC_RADIUS_MULTIPLIER = 1.4;

/** Map a normalised intensity (0..1) to a ramp colour. */
function rampColor(intensity: number): string {
  const clamped = Math.max(0, Math.min(1, intensity));
  const index = Math.min(RAMP.length - 1, Math.round(clamped * (RAMP.length - 1)));
  return RAMP[index];
}

/**
 * Non-SVG hold-usage heatmap: one opacity-scaled translucent disc per hold.
 * Both position and diameter are expressed as percentages of the board box, so
 * the overlay is fully self-contained — it doesn't need the measured device
 * width and the discs track the holds at any zoom (the parent applies the zoom
 * transform). Intensity is `log(1 + uses) / log(1 + maxUses)` so a handful of
 * mega-popular holds don't flatten the rest of the board to a single colour.
 * Painted holds are skipped so the overlay never covers the working climb.
 */
export const HeatmapOverlay = React.memo(function HeatmapOverlay({
  statsByHoldId,
  holdTargets,
  boardWidth,
  boardHeight,
  mirrored = false,
  paintedHoldIds,
}: HeatmapOverlayProps) {
  const discs = useMemo(() => {
    if (statsByHoldId.size === 0) return [];

    let maxUses = 0;
    for (const stat of statsByHoldId.values()) {
      if (stat.totalUses > maxUses) maxUses = stat.totalUses;
    }
    if (maxUses <= 0) return [];
    const logMax = Math.log(1 + maxUses);

    return holdTargets
      .map((target) => {
        if (paintedHoldIds.has(target.id)) return null;
        const stat = statsByHoldId.get(target.id);
        if (!stat || stat.totalUses <= 0) return null;

        const intensity = logMax > 0 ? Math.log(1 + stat.totalUses) / logMax : 0;

        // Percentage geometry (resolution independent). The container already
        // carries the board aspect ratio, so width-% and height-% map to the
        // same on-screen pixels and the disc stays round.
        const cxPct = (target.cx / boardWidth) * 100;
        const leftPct = mirrored ? 100 - cxPct : cxPct;
        const topPct = (target.cy / boardHeight) * 100;
        const diameterPct = ((target.r * 2 * DISC_RADIUS_MULTIPLIER) / boardWidth) * 100;

        return (
          <View
            key={target.id}
            pointerEvents="none"
            style={[
              styles.disc,
              {
                left: `${leftPct - diameterPct / 2}%`,
                top: `${topPct}%`,
                width: `${diameterPct}%`,
                aspectRatio: 1,
                marginTop: `${-diameterPct / 2}%`,
                borderRadius: 9999,
                backgroundColor: rampColor(intensity),
                opacity: DISC_OPACITY,
              },
            ]}
          />
        );
      })
      .filter(Boolean);
  }, [statsByHoldId, holdTargets, boardWidth, boardHeight, mirrored, paintedHoldIds]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {discs}
    </View>
  );
});

const styles = StyleSheet.create({
  disc: {
    position: 'absolute',
  },
});
