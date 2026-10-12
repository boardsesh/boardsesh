import { useCallback, useMemo } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { findGradeStop, isAnyGrade, type GradeBound } from '@boardsesh/climb-filters';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { RangeRail, type RangeRailChange, type RangeRailStop, type RangeRailStopState } from '../grade/RangeRail';

/** An angle filter: lowest and highest wall angle in degrees, ends included. */
export type AngleRange = readonly [number, number];

const ANGLE_STEP = 5;
const MIN_FILTER_ANGLE = -5;
const MAX_FILTER_ANGLE = 70;

/** −5° to 70° in 5° steps: every angle the supported boards tilt to. */
export const DEFAULT_FILTER_ANGLES: readonly number[] = Array.from(
  { length: (MAX_FILTER_ANGLE - MIN_FILTER_ANGLE) / ANGLE_STEP + 1 },
  (_, index) => MIN_FILTER_ANGLE + index * ANGLE_STEP,
);

/** "40°", and "−5°" with a true minus sign rather than a hyphen. */
export function formatAngleLabel(angle: number): string {
  return `${angle < 0 ? '−' : ''}${Math.abs(angle)}°`;
}

type AngleRangeRailProps = {
  /** The selected range, or null for Any. */
  value: AngleRange | null;
  onChange: (next: [number, number] | null, change: RangeRailChange) => void;
  /** The angles offered, in degrees. Keep the array stable across renders. */
  angles?: readonly number[];
  /** The angle to open centred on while nothing is selected (e.g. the board's own). */
  centerAngle?: number;
  /** Bump to centre the rail on the selection again; see `RangeRail`. */
  recenterKey?: number;
  contentInsetLeft?: number;
  contentInsetRight?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * The angle filter as a range rail: the same strip and gestures as the grade
 * rail. A tap picks one angle, a quick second tap or a touch and hold on another
 * makes a range, and the leading Any chip clears it. Every stop paints with the
 * brand fill, since angles have no colour ramp of their own.
 */
export function AngleRangeRail({
  value,
  onChange,
  angles = DEFAULT_FILTER_ANGLES,
  centerAngle,
  recenterKey,
  contentInsetLeft = spacing[4],
  contentInsetRight = spacing[4],
  style,
}: AngleRangeRailProps) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const brandFill = brandColors.primaryFill;

  const stops = useMemo<RangeRailStop[]>(
    () =>
      [...new Set(angles)]
        .sort((firstAngle, secondAngle) => firstAngle - secondAngle)
        .map((angle) => ({ minGradeId: angle, maxGradeId: angle, label: formatAngleLabel(angle), color: brandFill })),
    [angles, brandFill],
  );

  const minAngle = value?.[0];
  const maxAngle = value?.[1];
  const bound = useMemo<GradeBound>(() => ({ minGradeId: minAngle, maxGradeId: maxAngle }), [minAngle, maxAngle]);

  const centerStopId = useMemo(() => {
    const focusAngle = isAnyGrade(bound) ? centerAngle : (bound.minGradeId ?? bound.maxGradeId);
    return focusAngle == null ? undefined : findGradeStop(stops, focusAngle)?.minGradeId;
  }, [bound, centerAngle, stops]);

  const handleChange = useCallback(
    (next: GradeBound, change: RangeRailChange) => {
      const { minGradeId, maxGradeId } = next;
      // The rail's gestures always set both ends or neither; an open end would
      // only come from a caller's own bound, and reads as Any here.
      onChange(minGradeId !== undefined && maxGradeId !== undefined ? [minGradeId, maxGradeId] : null, change);
    },
    [onChange],
  );

  const stopAccessibilityLabel = useCallback(
    (stop: RangeRailStop, state: RangeRailStopState) => {
      // The plain number: a screen reader says "minus 5 degrees" for "-5".
      const angle = String(stop.minGradeId);
      return state === 'end'
        ? t('mobile.angleRail.selectedFilterAria', { angle })
        : state === 'inRange'
          ? t('mobile.angleRail.rangeFilterAria', { angle })
          : t('mobile.angleRail.setFilterAria', { angle });
    },
    [t],
  );

  return (
    <RangeRail
      stops={stops}
      bound={bound}
      centerStopId={centerStopId}
      onChange={handleChange}
      recenterKey={recenterKey}
      anyLabel={t('mobile.angleRail.any')}
      anySelectedAccessibilityLabel={t('mobile.angleRail.anyAngleAria')}
      clearAccessibilityLabel={t('mobile.angleRail.clearFilterAria')}
      stopAccessibilityLabel={stopAccessibilityLabel}
      rangeHoldHint={t('mobile.angleRail.rangeHoldHint')}
      contentInsetLeft={contentInsetLeft}
      contentInsetRight={contentInsetRight}
      style={style}
    />
  );
}
