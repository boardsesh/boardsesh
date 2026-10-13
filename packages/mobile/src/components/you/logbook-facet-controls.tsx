// The Logbook filter sheet's custom date rows (From / To). Plain react-native +
// @react-native-community/datetimepicker, no @expo/ui, so one control serves
// both platforms: iOS shows the native compact picker inline, Android opens the
// imperative dialog from a tappable row (LogbookEditSheet's pattern).

import { memo, useCallback, useState } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { localIsoDate, parseLocalIsoDate } from '@boardsesh/logbook';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { openAndroidDatePicker } from '../logbook/native-date-picker';

/** Keeps a date inside the picker's bounds; an unset bound limits nothing. */
function clampDate(date: Date, minimumDate: Date | undefined, maximumDate: Date | undefined): Date {
  if (minimumDate && date < minimumDate) return minimumDate;
  if (maximumDate && date > maximumDate) return maximumDate;
  return date;
}

export type DateRangeRowProps = {
  label: string;
  /** ISO date (YYYY-MM-DD) or '' when unset. */
  value: string;
  onChange: (iso: string) => void;
  clearLabel: string;
  /** The earliest day the picker offers (To can't come before From). */
  minimumDate?: Date;
  /** The latest day the picker offers (From can't pass To; nothing past today). */
  maximumDate?: Date;
};

/**
 * One date bound (from / to), 44pt tall. A Clear affordance resets the bound to
 * "any" (empty ISO). memo'd: the sheet passes a stable onChange and stable
 * dates, so an unrelated filter change doesn't re-render either row.
 */
export const DateRangeRow = memo(function DateRangeRow({
  label,
  value,
  onChange,
  clearLabel,
  minimumDate,
  maximumDate,
}: DateRangeRowProps) {
  const { systemColors, brandColors } = useTheme();
  const selectedDate = parseLocalIsoDate(value);
  // iOS: tapping the empty field reveals the inline picker WITHOUT committing a
  // date, so opening "From" doesn't silently filter to today and empty the list.
  const [revealed, setRevealed] = useState(false);

  const handleChange = useCallback(
    (_event: DateTimePickerEvent, picked?: Date) => {
      if (!picked) return;
      onChange(localIsoDate(clampDate(picked, minimumDate, maximumDate)));
    },
    [onChange, minimumDate, maximumDate],
  );

  const openAndroid = useCallback(() => {
    openAndroidDatePicker({
      value: clampDate(selectedDate ?? maximumDate ?? new Date(), minimumDate, maximumDate),
      mode: 'date',
      minimumDate,
      maximumDate,
      onPicked: (picked) => onChange(localIsoDate(clampDate(picked, minimumDate, maximumDate))),
    });
  }, [selectedDate, minimumDate, maximumDate, onChange]);

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
              value={clampDate(selectedDate ?? maximumDate ?? new Date(), minimumDate, maximumDate)}
              mode="date"
              display="compact"
              minimumDate={minimumDate}
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
