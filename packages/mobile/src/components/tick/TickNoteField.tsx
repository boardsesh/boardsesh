// One note field for both tick sheets.
//
// Replaces the create sheet's borderless 14/19/36 input — which read as a dimmed
// caption and ended the form in a hole — and the edit sheet's 72pt 15pt box.
// Neither size exists in either type scale; this one reads `subheadline` from
// the theme, so Material gets the M3 scale rather than an Apple number.
//
// A SINGLE styled `TextInput`, not a bordered wrapper `View` around a `flex: 1`
// input: that two-layer shape (box `justifyContent: 'center'` + column main
// axis, input `flex: 1` growing to fill it) is what `EndSessionSheet`'s
// `notesInput` deliberately avoids, and for good reason — on Android the
// multiline text rendered visibly cut in half vertically inside it (#4231).
// Matching `EndSessionSheet`'s flat shape (min/max height, padding and
// `textAlignVertical: 'top'` all on the input itself) removes the nested-flex
// vertical centering that produced the clip. The focus ring still costs no
// resize: the border is 1pt always, only its colour swaps.
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
