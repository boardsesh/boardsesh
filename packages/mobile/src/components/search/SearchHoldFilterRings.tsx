import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import type { BoardName, HoldFilterEntry, HoldFilterMode, HoldFilterType, HoldsFilter } from '@boardsesh/shared-schema';
import { ANY_HOLD_COLOR, buildHoldFilterOptions } from '@boardsesh/climb-filters';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { useHoldColorOverrides, type HoldMarkerShape } from '../../lib/hold-color-overrides';
import { holdGeometry } from '../create-climb/holdLayout';
import { HoldMarkerShapeSvg } from '../board-renderer/HoldMarkerShape';
import { getHoldFilterTypeShape } from './hold-filter-visuals';

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
  const {
    overrides: holdColorOverrides,
    shapes: holdShapeOverrides,
    brushThickness,
    shapeSize,
  } = useHoldColorOverrides();
  const colorByType = useMemo(() => {
    const map = new Map<HoldFilterType, string>();
    for (const option of buildHoldFilterOptions(boardName, holdColorOverrides)) map.set(option.type, option.color);
    return map;
  }, [boardName, holdColorOverrides]);
  const shapeByType = useMemo(() => {
    const map = new Map<HoldFilterType, HoldMarkerShape>();
    for (const option of buildHoldFilterOptions(boardName, holdColorOverrides)) {
      map.set(option.type, getHoldFilterTypeShape(option.type, holdShapeOverrides));
    }
    return map;
  }, [boardName, holdColorOverrides, holdShapeOverrides]);

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
          shapeByType={shapeByType}
          brushThickness={brushThickness}
          shapeSize={shapeSize}
        />,
      );
    }
    return out;
  }, [
    holdsFilter,
    holdById,
    boardWidth,
    boardHeight,
    measuredWidth,
    mirrored,
    colorByType,
    shapeByType,
    brushThickness,
    shapeSize,
  ]);

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
  shapeByType: Map<HoldFilterType, HoldMarkerShape>;
  brushThickness: number;
  shapeSize: number;
};

const HoldFilterMarker = React.memo(function HoldFilterMarker({
  leftPct,
  topPct,
  baseDiameter,
  filters,
  colorByType,
  shapeByType,
  brushThickness,
  shapeSize,
}: HoldFilterMarkerProps) {
  const baseRadius = (baseDiameter * shapeSize) / 2;
  const activeRingCount = Math.max(1, filters.length);
  const minRingRadius = Math.max(1, baseRadius * 0.35);
  const ringStep = activeRingCount > 1 ? Math.max(1, (baseRadius - minRingRadius) / (activeRingCount - 1)) : 0;
  const requestedBorderWidth = Math.max(1, (baseDiameter / 2) * 0.32 * brushThickness);
  const maxBorderWidth = activeRingCount > 1 ? Math.max(1, ringStep * 0.6) : Math.max(1, baseRadius * 0.6);
  const borderWidth = Math.min(requestedBorderWidth, maxBorderWidth, Math.max(1, baseRadius * 0.45));
  const hasExclude = filters.some((filter) => filter.mode === 'exclude');
  const outerShape = filters[0] ? (shapeByType.get(filters[0].type) ?? 'circle') : 'circle';
  const outerDiameter = baseRadius * 2;

  return (
    <>
      {hasExclude ? (
        outerShape === 'circle' ? (
          <View
            pointerEvents="none"
            style={[
              styles.absolute,
              {
                left: `${leftPct}%`,
                top: `${topPct}%`,
                width: outerDiameter,
                height: outerDiameter,
                borderRadius: baseRadius,
                marginLeft: -baseRadius,
                marginTop: -baseRadius,
                backgroundColor: 'rgba(0, 0, 0, 0.55)',
              },
            ]}
          />
        ) : (
          <HoldMarkerShapeSvg
            pointerEvents="none"
            shape={outerShape}
            color="#000000"
            diameter={outerDiameter}
            strokeWidth={0}
            fillOpacity={0.55}
            style={[
              styles.absolute,
              {
                left: `${leftPct}%`,
                top: `${topPct}%`,
                marginLeft: -baseRadius,
                marginTop: -baseRadius,
              },
            ]}
          />
        )
      ) : null}
      {filters.map((filter, index) => {
        const ringRadius = Math.max(1, baseRadius - index * ringStep);
        const ringDiameter = ringRadius * 2;
        const color = colorByType.get(filter.type) ?? ANY_HOLD_COLOR;
        const shape = shapeByType.get(filter.type) ?? 'circle';
        if (shape === 'circle') {
          return (
            // Key on type only: each type appears at most once per hold, so an
            // include/exclude flip reuses the same ring View instead of
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
                  borderRadius: ringRadius,
                  marginLeft: -ringRadius,
                  marginTop: -ringRadius,
                  borderWidth,
                  borderColor: color,
                },
              ]}
            />
          );
        }
        return (
          // Key on type only: each type appears at most once per hold, so an
          // include/exclude flip reuses the same marker instead of
          // unmounting and recreating it.
          <HoldMarkerShapeSvg
            key={filter.type}
            pointerEvents="none"
            shape={shape}
            color={color}
            diameter={ringDiameter}
            strokeWidth={borderWidth}
            style={[
              styles.absolute,
              {
                left: `${leftPct}%`,
                top: `${topPct}%`,
                marginLeft: -ringRadius,
                marginTop: -ringRadius,
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
