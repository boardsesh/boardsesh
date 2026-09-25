import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import type { HoldStat } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { holdGeometry } from '../create-climb/holdLayout';

/**
 * What a disc's colour says about its hold:
 * - `uses` — how many of the matched climbs use it (log scale);
 * - `ascents` — how many ascents those climbs have between them (log scale);
 * - `difficulty` — the average grade of those climbs, easiest to hardest
 *   within the grades on screen.
 */
export type HeatmapMode = 'uses' | 'ascents' | 'difficulty';

export const HEATMAP_MODES: readonly HeatmapMode[] = ['uses', 'ascents', 'difficulty'];

/**
 * Cool → hot. A data-visualisation ramp local to this overlay, not a theme
 * token: it has to read the same over any board photo in either colour scheme,
 * and nothing else in the app draws with it. The legend reads the same array.
 */
export const HEAT_RAMP = ['#22C55E', '#A3E635', '#FACC15', '#FB923C', '#EF4444'] as const;
const DISC_OPACITY = 0.7;
const DISC_RADIUS_MULTIPLIER = 1.4;

export type HeatmapDisc = {
  id: number;
  leftPct: number;
  topPct: number;
  diameter: number;
  color: string;
};

export type BuildHeatmapDiscsParams = {
  statsByHoldId: ReadonlyMap<number, HoldStat>;
  holdTargets: readonly BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  measuredWidth: number;
  mode?: HeatmapMode;
  mirrored?: boolean;
  /** Holds already painted on the create board; they keep their own marker. */
  paintedHoldIds?: ReadonlySet<number>;
};

export function heatmapRampColor(intensity: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0));
  const index = Math.min(HEAT_RAMP.length - 1, Math.round(clamped * (HEAT_RAMP.length - 1)));
  return HEAT_RAMP[index];
}

/** The number a mode colours by, or null when the hold has nothing to show in it. */
function modeValue(holdStat: HoldStat, mode: HeatmapMode): number | null {
  if (holdStat.totalUses <= 0) return null;
  switch (mode) {
    case 'uses':
      return holdStat.totalUses;
    case 'ascents':
      return holdStat.totalAscents > 0 ? holdStat.totalAscents : null;
    case 'difficulty':
      return holdStat.averageDifficulty ?? null;
  }
}

/**
 * Turns a value into a 0–1 position on the ramp. Counts are spread on a log
 * scale, so a board whose top hold is used 4,000 times still separates the 5s
 * from the 50s; difficulty is linear between the easiest and hardest average on
 * screen, so the ramp always spans the grades the filter left.
 */
function intensityScale(values: readonly number[], mode: HeatmapMode): ((value: number) => number) | null {
  if (values.length === 0) return null;
  if (mode === 'difficulty') {
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const span = max - min;
    return span > 0 ? (value) => (value - min) / span : () => 0.5;
  }
  let max = 0;
  for (const value of values) if (value > max) max = value;
  if (max <= 0) return null;
  const logMax = Math.log1p(max);
  return (value) => Math.log1p(value) / logMax;
}

/** Pure: one coloured disc per hold with something to show, positioned on the renderer's targets. */
export function buildHeatmapDiscs({
  statsByHoldId,
  holdTargets,
  boardWidth,
  boardHeight,
  measuredWidth,
  mode = 'uses',
  mirrored = false,
  paintedHoldIds,
}: BuildHeatmapDiscsParams): HeatmapDisc[] {
  if (measuredWidth <= 0 || boardWidth <= 0 || boardHeight <= 0) return [];

  const shown: { target: BoardHoldTarget; value: number }[] = [];
  for (const target of holdTargets) {
    if (paintedHoldIds?.has(target.id)) continue;
    const holdStat = statsByHoldId.get(target.id);
    if (!holdStat) continue;
    const value = modeValue(holdStat, mode);
    if (value !== null) shown.push({ target, value });
  }
  const scale = intensityScale(
    shown.map((entry) => entry.value),
    mode,
  );
  if (!scale) return [];

  return shown.map(({ target, value }) => {
    const geometry = holdGeometry(target, boardWidth, boardHeight, measuredWidth, mirrored, DISC_RADIUS_MULTIPLIER);
    return {
      id: target.id,
      leftPct: geometry.leftPct,
      topPct: geometry.topPct,
      diameter: geometry.ringDiameter,
      color: heatmapRampColor(scale(value)),
    };
  });
}

type HeatmapOverlayProps = Omit<BuildHeatmapDiscsParams, 'measuredWidth'>;

/**
 * Heat discs over a board, one per hold, positioned from the same targets the
 * create board's tap layer uses (`getCreateBoardHolds`). Fills its parent and
 * measures it once per layout change, so it drops into both the play drawer's
 * `underOverlay` slot (under the lit holds, inside the mirrored stack — so it
 * never mirrors itself there) and the create board's `overlay` slot.
 *
 * Static: no animation and no per-frame state, only the discs `useMemo` builds
 * when the stats, mode or size change.
 */
export const HeatmapOverlay = memo(function HeatmapOverlay({
  statsByHoldId,
  holdTargets,
  boardWidth,
  boardHeight,
  mode = 'uses',
  mirrored = false,
  paintedHoldIds,
}: HeatmapOverlayProps) {
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setMeasuredWidth((previous) => (previous === width ? previous : width));
  }, []);

  const discs = useMemo(
    () =>
      buildHeatmapDiscs({
        statsByHoldId,
        holdTargets,
        boardWidth,
        boardHeight,
        measuredWidth,
        mode,
        mirrored,
        paintedHoldIds,
      }),
    [statsByHoldId, holdTargets, boardWidth, boardHeight, measuredWidth, mode, mirrored, paintedHoldIds],
  );

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={handleLayout}>
      {discs.map((disc) => (
        <View
          key={disc.id}
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
