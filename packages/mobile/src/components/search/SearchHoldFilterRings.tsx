import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import type { BoardName, HoldFilterEntry, HoldFilterMode, HoldFilterType, HoldsFilter } from '@boardsesh/shared-schema';
import { ANY_HOLD_COLOR, buildHoldFilterOptions } from '@boardsesh/climb-filters';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { holdGeometry } from '../create-climb/holdLayout';

type SearchHoldFilterRingsProps = {
  boardName: BoardName;
  holdsFilter: HoldsFilter;
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  measuredWidth: number;
  mirrored: boolean;
};

// Outer rings first, so the most-typical roles draw outward and the ANY
// wildcard nests inside — same draw order as the web overlay.
const TYPE_DRAW_ORDER: readonly HoldFilterType[] = ['STARTING', 'HAND', 'FINISH', 'FOOT', 'ANY'];

type ActiveFilter = { type: HoldFilterType; mode: HoldFilterMode };

function collectActiveFilters(entry: HoldFilterEntry): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  for (const type of TYPE_DRAW_ORDER) {
    const mode = entry[type];
    if (mode === 'include' || mode === 'exclude') out.push({ type, mode });
  }
  return out;
}

/**
 * Renders concentric rings (one per active type filter) on each filtered hold,
 * plus a dim scrim on holds with any "exclude" filter — the RN-View port of the
 * web `SearchHoldFilterOverlay`. Lives INSIDE the zoom-transformed board view so
 * the rings track the holds at any zoom level (percentage anchors), matching how
 * the create-climb painted layer works. `pointerEvents="none"` so taps fall
 * through to the hold targets underneath.
 */
export const SearchHoldFilterRings = React.memo(function SearchHoldFilterRings({
  boardName,
  holdsFilter,
  holdTargets,
  boardWidth,
  boardHeight,
  measuredWidth,
  mirrored,
}: SearchHoldFilterRingsProps) {
  const colorByType = useMemo(() => {
    const map = new Map<HoldFilterType, string>();
    for (const option of buildHoldFilterOptions(boardName)) map.set(option.type, option.color);
    return map;
  }, [boardName]);

  const holdById = useMemo(() => {
    const map = new Map<number, BoardHoldTarget>();
    for (const hold of holdTargets) map.set(hold.id, hold);
    return map;
  }, [holdTargets]);

  const markers = useMemo(() => {
    if (measuredWidth <= 0) return null;
    const out: React.ReactNode[] = [];
    for (const [holdIdRaw, entry] of Object.entries(holdsFilter)) {
      if (!entry) continue;
      const filters = collectActiveFilters(entry);
      if (filters.length === 0) continue;
      const hold = holdById.get(Number(holdIdRaw));
      if (!hold) continue;
      const geometry = holdGeometry(hold, boardWidth, boardHeight, measuredWidth, mirrored);
      out.push(
        <HoldFilterMarker
          key={holdIdRaw}
          leftPct={geometry.leftPct}
          topPct={geometry.topPct}
          baseDiameter={geometry.ringDiameter}
          filters={filters}
          colorByType={colorByType}
        />,
      );
    }
    return out;
  }, [holdsFilter, holdById, boardWidth, boardHeight, measuredWidth, mirrored, colorByType]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {markers}
    </View>
  );
});

type HoldFilterMarkerProps = {
  leftPct: number;
  topPct: number;
  baseDiameter: number;
  filters: ActiveFilter[];
  colorByType: Map<HoldFilterType, string>;
};

const HoldFilterMarker = React.memo(function HoldFilterMarker({
  leftPct,
  topPct,
  baseDiameter,
  filters,
  colorByType,
}: HoldFilterMarkerProps) {
  const baseRadius = baseDiameter / 2;
  const borderWidth = Math.min(3.5, Math.max(2, baseRadius * 0.32));
  // Nest each subsequent ring inward by ~22% of the base radius, mirroring the
  // web overlay so dense boards stay readable.
  const ringStep = baseRadius * 0.22;
  const hasExclude = filters.some((filter) => filter.mode === 'exclude');

  return (
    <>
      {hasExclude ? (
        <View
          pointerEvents="none"
          style={[
            styles.absolute,
            {
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: baseDiameter,
              height: baseDiameter,
              marginLeft: -baseRadius,
              marginTop: -baseRadius,
              borderRadius: baseRadius,
              backgroundColor: 'rgba(0,0,0,0.55)',
            },
          ]}
        />
      ) : null}
      {filters.map((filter, index) => {
        const ringRadius = Math.max(borderWidth, baseRadius - index * ringStep);
        const ringDiameter = ringRadius * 2;
        const color = colorByType.get(filter.type) ?? ANY_HOLD_COLOR;
        return (
          // Key on type only: each type appears at most once per hold, so an
          // include↔exclude flip reuses the same ring View instead of
          // unmounting and recreating it.
          <View
            key={filter.type}
            pointerEvents="none"
            style={[
              styles.absolute,
              {
                left: `${leftPct}%`,
                top: `${topPct}%`,
                width: ringDiameter,
                height: ringDiameter,
                marginLeft: -ringRadius,
                marginTop: -ringRadius,
                borderRadius: ringRadius,
                borderWidth,
                borderColor: color,
              },
            ]}
          />
        );
      })}
    </>
  );
});

const styles = StyleSheet.create({
  absolute: {
    position: 'absolute',
  },
});
