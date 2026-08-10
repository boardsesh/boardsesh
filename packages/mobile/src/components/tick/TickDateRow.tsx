// Date and time on ONE row, in both sheets. The edit sheet used to spend two
// full sections (~190pt) on what is one timestamp; this is 56pt.
//
// The '@' between the two pickers is deliberate — issue #4163 asked for
// `Date  d Mon YYYY  @  HH:MM`. It is punctuation, not copy: the same glyph in
// every locale, so it is a literal rather than a catalog key.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { ClimbedAtField } from '../logbook/ClimbedAtField';
import { useTheme } from '../../providers/theme-provider';

const TIMESTAMP_SEPARATOR = '@';

type TickDateRowProps = {
  value: Date;
  maximumDate: Date;
  onChange: (next: Date) => void;
  /** Fired when the clamp pulled a future selection back to now. */
  onFutureAdjusted: () => void;
  dateAccessibilityLabel: string;
  timeAccessibilityLabel: string;
};

export const TickDateRow = React.memo(function TickDateRow({
  value,
  maximumDate,
  onChange,
  onFutureAdjusted,
  dateAccessibilityLabel,
  timeAccessibilityLabel,
}: TickDateRowProps) {
  const { systemColors, spacing } = useTheme();

  return (
    <View style={[styles.row, { gap: spacing[2] }]}>
      <View style={styles.field}>
        <ClimbedAtField
          value={value}
          mode="date"
          maximumDate={maximumDate}
          onChange={onChange}
          onFutureAdjusted={onFutureAdjusted}
          accessibilityLabel={dateAccessibilityLabel}
        />
      </View>
      {/* Punctuation between two pickers, not content: hidden from the
          accessibility tree so VoiceOver doesn't stop on a meaningless "at"
          between the date and time fields. `secondaryLabel` rather than
          `tertiaryLabel` because the iOS tertiary label composites to 1.73:1
          (light) / 2.46:1 (dark) on the sheet ground — below the 3:1 floor;
          secondary reads 3.44:1 / 6.14:1. */}
      <Text
        variant="body"
        color={systemColors.secondaryLabel}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {TIMESTAMP_SEPARATOR}
      </Text>
      <View style={styles.field}>
        <ClimbedAtField
          value={value}
          mode="time"
          maximumDate={maximumDate}
          onChange={onChange}
          onFutureAdjusted={onFutureAdjusted}
          accessibilityLabel={timeAccessibilityLabel}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // Wraps rather than squeezes the two native pickers when a long locale
    // format or a large text size runs the pair past the control seam.
    flexWrap: 'wrap',
  },
  field: {
    flexShrink: 1,
    minWidth: 0,
  },
});
