// A single date-or-time field for a tick's `climbedAt`, shared by the create
// flow (QuickTickBar) and the edit flow (LogbookEditSheet). One instance edits
// one part (`mode="date"` or `mode="time"`); render two side by side for a full
// timestamp. Controlled + stateless: it merges the picked part onto `value`,
// clamps to now (a tick can't be in the future), and reports the clamp via
// `onFutureAdjusted` so the parent can surface a toast in its own namespace —
// the field itself stays free of provider/i18n coupling.
import React, { useCallback } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { applyDatePart, applyTimePart, clampToNow, formatDateForDisplay, formatTimeForDisplay } from './climbed-at';
import { openAndroidDatePicker } from './native-date-picker';

type ClimbedAtFieldProps = {
  value: Date;
  mode: 'date' | 'time';
  maximumDate: Date;
  /** Receives the fully-merged, clamped `Date`. */
  onChange: (next: Date) => void;
  /** Fired when the clamp pulled a future selection back to now. */
  onFutureAdjusted?: () => void;
  accessibilityLabel: string;
};

export const ClimbedAtField = React.memo(function ClimbedAtField({
  value,
  mode,
  maximumDate,
  onChange,
  onFutureAdjusted,
  accessibilityLabel,
}: ClimbedAtFieldProps) {
  const { systemColors, brandColors, colorScheme } = useTheme();

  const commitPicked = useCallback(
    (picked: Date) => {
      const requested =
        mode === 'date'
          ? applyDatePart(value, picked, { clampToPresent: false })
          : applyTimePart(value, picked, { clampToPresent: false });
      const clamped = clampToNow(requested);
      if (clamped.getTime() !== requested.getTime()) onFutureAdjusted?.();
      onChange(clamped);
    },
    [mode, value, onChange, onFutureAdjusted],
  );

  const handleIosChange = useCallback(
    (_event: DateTimePickerEvent, picked?: Date) => {
      if (!picked) return;
      commitPicked(picked);
    },
    [commitPicked],
  );

  const openAndroid = useCallback(() => {
    openAndroidDatePicker({ value, mode, maximumDate, onPicked: commitPicked });
  }, [value, mode, maximumDate, commitPicked]);

  if (Platform.OS === 'ios') {
    // The compact UIKit picker keeps its own fill and ~8pt corner — these two
    // props are the only levers we have on it. `accentColor` takes a plain hex
    // (which brandColors.primary is) and pulls the picker's selection off Apple
    // blue onto the sheet's violet; `themeVariant` stops it resolving light
    // chrome when the app is running its own dark theme on a light-mode phone.
    return (
      <DateTimePicker
        value={value}
        mode={mode}
        display="compact"
        maximumDate={maximumDate}
        accentColor={brandColors.primary}
        themeVariant={colorScheme}
        accessibilityLabel={accessibilityLabel}
        onChange={handleIosChange}
      />
    );
  }

  return (
    <Pressable
      onPress={openAndroid}
      style={[styles.trigger, { backgroundColor: systemColors.fill }]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text variant="body" color={systemColors.label}>
        {mode === 'date' ? formatDateForDisplay(value) : formatTimeForDisplay(value)}
      </Text>
      <Icon name={mode === 'date' ? 'calendar' : 'clock'} size={18} color={systemColors.secondaryLabel} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // A pill that hugs its content, so the Android trigger reads as the same kind
  // of object as the chips on the rows above and below it, instead of a full-
  // width box with its label and glyph pushed to opposite edges.
  trigger: {
    minHeight: 44,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing[3],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    gap: spacing[2],
  },
});
