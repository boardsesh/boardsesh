// One note field for both tick sheets. A single styled `TextInput`, never a
// bordered wrapper `View` around a `flex: 1` input.
//
// The vertical padding below is load-bearing on Android — do not remove it. On
// Fabric a TextInput that declares no vertical padding has the theme's default
// EditText padding (~10pt top + ~10pt bottom) written into its Yoga style by
// `AndroidTextInputComponentDescriptor`, so declaring padding here replaces that
// default rather than adding to it. In the old two-layer shape the outer box's
// `justifyContent: 'center'` pinned the `flex: 1` input to a 26pt content box,
// the inherited ~20pt of theme padding ate almost all of it, and the note
// rendered as a ~5pt sliver of glyph bottoms and a stub caret (#4642, fixed in
// #4684). `EndSessionSheet` uses the same flat shape.
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
    // Past this the note scrolls INSIDE the field, and an Android multiline
    // TextInput draws no scrollbar — so whatever is above the ceiling is gone
    // with nothing on screen to say so. At the old 96pt (4 lines) that bit
    // early: on a 405x900pt Pixel emulator a six-line note opened mid-sentence
    // ("before the dyn beta is solid now and I wan...") while ~300pt of the
    // sheet sat empty below this row (#4642). 180pt is eight
    // lines (8 x 20 + 16 padding + 2 border), and it still fits whole inside
    // the ~293pt that sheet body keeps above the keyboard, so a long note stays
    // one glance rather than a blind scroll. Anything longer scrolls the sheet
    // body, which at least moves visibly. Detents are unchanged: the body is
    // scrollable under a pinned footer, so the extra height costs the
    // Attempt/Send bar nothing.
    maxHeight: 180,
    textAlignVertical: 'top',
  },
});
