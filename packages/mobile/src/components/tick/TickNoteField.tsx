// One note field for both tick sheets. A single styled `TextInput`, not a
// bordered wrapper `View` around a `flex: 1` input — that two-layer shape
// clipped multiline text on Android (#4231); matches `EndSessionSheet`'s flat
// shape instead.
import React, { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTheme } from '../../providers/theme-provider';

type TickNoteFieldProps = {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  accessibilityLabel: string;
};

export const TickNoteField = React.memo(function TickNoteField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
}: TickNoteFieldProps) {
  const { systemColors, brandColors, borderRadius, spacing, textStyles } = useTheme();
  const [focused, setFocused] = useState(false);

  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);

  return (
    <BottomSheetTextInput
      multiline
      value={value}
      onChangeText={onChangeText}
      onFocus={handleFocus}
      onBlur={handleBlur}
      placeholder={placeholder}
      // `secondaryLabel`, not `tertiaryLabel`: on iOS the tertiary label is a
      // ~30%-alpha PlatformColor, which composites to 1.73:1 against the opaque
      // sheet ground these rows now sit on — under the 3:1 floor. It was fine
      // over the old glass.
      placeholderTextColor={systemColors.secondaryLabel}
      accessibilityLabel={accessibilityLabel}
      style={[
        textStyles.subheadline,
        styles.input,
        {
          borderRadius: borderRadius.lg,
          paddingHorizontal: spacing[3],
          paddingVertical: spacing[2],
          backgroundColor: systemColors.fill,
          // Transparent at rest rather than absent, so gaining focus does not
          // resize the field by a point.
          borderColor: focused ? brandColors.primary : 'transparent',
          color: systemColors.label,
        },
      ]}
    />
  );
});

const styles = StyleSheet.create({
  input: {
    flex: 1,
    borderWidth: 1,
    minHeight: 44,
    // Grows with the note up to three-ish lines, then scrolls — the sheet's
    // detent is sized for the resting height, not the longest possible note.
    maxHeight: 96,
    textAlignVertical: 'top',
  },
});
