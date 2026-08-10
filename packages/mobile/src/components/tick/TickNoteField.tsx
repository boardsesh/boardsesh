// One note field for both tick sheets.
//
// Replaces the create sheet's borderless 14/19/36 input — which read as a dimmed
// caption and ended the form in a hole — and the edit sheet's 72pt 15pt box.
// Neither size exists in either type scale; this one reads `subheadline` from
// the theme, so Material gets the M3 scale rather than an Apple number.
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
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
    <View
      style={[
        styles.box,
        {
          borderRadius: borderRadius.lg,
          paddingHorizontal: spacing[3],
          paddingVertical: spacing[2],
          backgroundColor: systemColors.fill,
          // Transparent at rest rather than absent, so gaining focus does not
          // resize the box by a point.
          borderColor: focused ? brandColors.primary : 'transparent',
        },
      ]}
    >
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
        style={[textStyles.subheadline, styles.input, { color: systemColors.label }]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    flex: 1,
    minHeight: 44,
    // Grows with the note up to three-ish lines, then scrolls — the sheet's
    // detent is sized for the resting height, not the longest possible note.
    maxHeight: 96,
    borderWidth: 1,
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    textAlignVertical: 'top',
  },
});
