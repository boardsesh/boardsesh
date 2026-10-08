import { Pressable } from 'react-native';
import { PressableSurface } from '../PressableSurface';
// Reusable logbook filter controls, shared by the LogbookFilterSheet (the full
// bottom sheet) and the inline toolbar rails (LogbookFacetRail, the iOS-glass
// chip row's grade/angle/date facets). Extracted so the angle chip rail and the
// date From/To rows are worded and behave identically in both surfaces — the
// chip-row facet is the same control the sheet shows, never a re-creation.
//
// Plain react-native + @react-native-community/datetimepicker; no @expo/ui, so it
// runs on both platforms (the toolbar rail is iOS-glass-only by where it's
// mounted, but the controls themselves are cross-platform, matching the sheet).

import { memo, useCallback, useState } from 'react';
import { View, StyleSheet, Platform, type ViewStyle } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LOGBOOK_ANGLE_RANGE } from '@boardsesh/logbook';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { springs } from '../../theme/animations';
import { spacing } from '../../theme/tokens';
import { openAndroidDatePicker } from '../logbook/native-date-picker';

// Angle filter granularity — mirrors the web slider (0–70°, step 5).
const ANGLE_STEP = 5;
const ANGLE_VALUES: number[] = (() => {
  const [min, max] = DEFAULT_LOGBOOK_ANGLE_RANGE;
  const values: number[] = [];
  for (let angle = min; angle <= max; angle += ANGLE_STEP) values.push(angle);
  return values;
})();

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function parseIsoDate(iso: string): Date | null {
  if (!iso) return null;
  const parsed = new Date(`${iso}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Filled-pill chip for the logbook angle min/max selectors (a horizontal chip
// rail). Selected fill is the brand tint, like every other selection control.
// memo'd + value-based onPress so the ~30 angle chips (each carrying a Reanimated
// shared value + worklet) don't all re-render when an unrelated filter changes.
// The rails pass a stable handler, not a per-chip arrow.
const Chip = memo(function Chip({
  label,
  selected,
  value,
  onPress,
}: {
  label: string;
  selected: boolean;
  value: number;
  onPress: (value: number) => void;
}) {
  const { systemColors, brandColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // Selected fill is the brand tint with its on-fill label (HIG Color: one tint).
  // Only the fill is dynamic; the static padding/radius live in styles.chip.
  const chipFill: ViewStyle = { backgroundColor: selected ? brandColors.primaryFill : systemColors.fill };
  return (
    <AnimatedPressable
      onPress={() => {
        hapticSelection();
        onPress(value);
      }}
      onPressIn={() => {
        scale.value = withSpring(0.95, springs.snappy);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, springs.snappy);
      }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[animatedStyle, styles.chip, chipFill]}
    >
      <Text variant="footnote" color={selected ? brandColors.onPrimary : undefined} style={styles.chipText}>
        {label}
      </Text>
    </AnimatedPressable>
  );
});

type LogbookAngleRailProps = {
  angleRange: [number, number];
  onChange: (angleRange: [number, number]) => void;
};

/**
 * The angle min/max chip rails (two rows). Selecting a min clamps the max up to
 * it (and vice versa) so the range never inverts — the sheet's behaviour, now
 * shared with the inline toolbar facet.
 */
export const LogbookAngleRail = memo(function LogbookAngleRail({ angleRange, onChange }: LogbookAngleRailProps) {
  const { t } = useTranslation('you');
  const [minAngle, maxAngle] = angleRange;

  const handleMinAngle = useCallback(
    (angle: number) => onChange([angle, Math.max(angle, maxAngle)]),
    [onChange, maxAngle],
  );
  const handleMaxAngle = useCallback(
    (angle: number) => onChange([Math.min(minAngle, angle), angle]),
    [onChange, minAngle],
  );

  return (
    <>
      <Text variant="footnote" style={styles.subsectionLabel}>
        {t('mobile.logbook.angleMin')}
      </Text>
      <View style={styles.chipRow}>
        {ANGLE_VALUES.map((angle) => (
          <Chip
            key={`min-${angle}`}
            label={`${angle}°`}
            value={angle}
            selected={minAngle === angle}
            onPress={handleMinAngle}
          />
        ))}
      </View>
      <View style={styles.subsectionGap} />
      <Text variant="footnote" style={styles.subsectionLabel}>
        {t('mobile.logbook.angleMax')}
      </Text>
      <View style={styles.chipRow}>
        {ANGLE_VALUES.map((angle) => (
          <Chip
            key={`max-${angle}`}
            label={`${angle}°`}
            value={angle}
            selected={maxAngle === angle}
            onPress={handleMaxAngle}
          />
        ))}
      </View>
    </>
  );
});

export type DateRangeRowProps = {
  label: string;
  /** ISO date (YYYY-MM-DD) or '' when unset. */
  value: string;
  onChange: (iso: string) => void;
  clearLabel: string;
  maximumDate?: Date;
};

/**
 * One date bound (from / to). iOS shows the native compact picker inline; Android
 * opens the imperative dialog from a tappable row — mirroring LogbookEditSheet's
 * pattern. A Clear affordance resets the bound to "any" (empty ISO).
 * memo'd (like LogbookAngleRail / Chip): both callers pass a stable onChange
 * (useCallback), string labels, and a stable maximumDate, so an unrelated filter
 * change on the sheet / rail doesn't re-render either date row.
 */
export const DateRangeRow = memo(function DateRangeRow({
  label,
  value,
  onChange,
  clearLabel,
  maximumDate,
}: DateRangeRowProps) {
  const { systemColors, brandColors } = useTheme();
  const selectedDate = parseIsoDate(value);
  // iOS: tapping the empty field reveals the inline picker WITHOUT committing a
  // date, so opening "From" doesn't silently filter to today and empty the list.
  const [revealed, setRevealed] = useState(false);

  const handleChange = useCallback(
    (_event: DateTimePickerEvent, picked?: Date) => {
      if (!picked) return;
      onChange(formatIsoDate(picked));
    },
    [onChange],
  );

  const openAndroid = useCallback(() => {
    openAndroidDatePicker({
      value: selectedDate ?? new Date(),
      mode: 'date',
      maximumDate,
      onPicked: (picked) => onChange(formatIsoDate(picked)),
    });
  }, [selectedDate, maximumDate, onChange]);

  const handleClear = useCallback(() => {
    hapticSelection();
    setRevealed(false);
    onChange('');
  }, [onChange]);

  return (
    <View style={styles.dateRow}>
      <Text variant="body" style={styles.dateRowLabel}>
        {label}
      </Text>
      <View style={styles.dateRowTrailing}>
        {Platform.OS === 'ios' ? (
          selectedDate || revealed ? (
            <DateTimePicker
              value={selectedDate ?? maximumDate ?? new Date()}
              mode="date"
              display="compact"
              maximumDate={maximumDate}
              // Tint the selected day + nav chevrons with the brand tint (the native
              // compact picker otherwise uses the iOS system blue).
              accentColor={brandColors.primary}
              accessibilityLabel={label}
              onChange={handleChange}
            />
          ) : (
            <PressableSurface
              onPress={() => {
                hapticSelection();
                setRevealed(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={label}
              style={({ pressed }) => [
                styles.dateButton,
                { backgroundColor: systemColors.fill },
                pressed && styles.dateButtonPressed,
              ]}
            >
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {clearLabel}
              </Text>
              <Icon name="calendar" size={16} color={systemColors.secondaryLabel} />
            </PressableSurface>
          )
        ) : (
          <PressableSurface
            onPress={openAndroid}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [
              styles.dateButton,
              { backgroundColor: systemColors.fill },
              pressed && styles.dateButtonPressed,
            ]}
          >
            <Text variant="footnote" color={value ? systemColors.label : systemColors.secondaryLabel}>
              {value || clearLabel}
            </Text>
            <Icon name="calendar" size={16} color={systemColors.secondaryLabel} />
          </PressableSurface>
        )}
        {value || revealed ? (
          <PressableSurface
            onPress={handleClear}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={clearLabel}
          >
            <Icon name="close" size={14} color={systemColors.secondaryLabel} />
          </PressableSurface>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  subsectionLabel: {
    opacity: 0.55,
    marginTop: spacing[1],
    marginBottom: spacing[2],
  },
  subsectionGap: {
    height: spacing[4],
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  // Static chip geometry; the amber/fill backgroundColor is applied inline per
  // selected state (see the Chip component).
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 20,
  },
  chipText: {
    fontWeight: '500',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  dateRowLabel: {
    flex: 1,
  },
  dateRowTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 8,
    minHeight: 34,
  },
  dateButtonPressed: {
    opacity: 0.6,
  },
});
