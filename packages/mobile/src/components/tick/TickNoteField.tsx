// One note field for both tick sheets. A single styled `TextInput`, never a
// bordered wrapper `View` around a `flex: 1` input.
//
// The vertical padding below is load-bearing on Android — do not remove it.
// What is established: on 2.3.1 the note rendered as a ~5pt band of glyph
// bottoms and a stub caret inside its 44pt box, the first ink sat ~9.7pt below
// the input's top edge despite `textAlignVertical: 'top'`, and declaring
// padding on the input (#4684) fixed it. The leading explanation is Fabric's:
// `AndroidTextInputComponentDescriptor` writes the theme's default EditText
// padding (~10pt top + ~10pt bottom) into the Yoga style of any TextInput that
// declares none, and declaring padding here sets `hasPaddingVertical` and
// replaces it. Treat that as the best hypothesis rather than proven — the
// competing "the flex child collapsed to zero height" story does NOT hold
// (vendored Yoga clamps `availableInnerMainDim` to the min constraint before
// `resolveFlexibleLength`, so the old child resolved to ~26pt, and a 20pt line
// fits in 26pt). Either way the padding is what changed the rendering, so the
// test next door pins it (#4642).
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
          // A real edge at rest, not `transparent` — an unfocused field with no
          // visible boundary reads as decoration rather than somewhere to
          // type. `borderWidth` is unchanged either way, so focus recolours the
          // edge instead of resizing the box. `separator` is the only border
          // role the design system has here, and it clears WCAG 1.4.11's 3:1 in
          // neither scheme: ~1.9:1 in dark, ~1.6:1 in light, so dark is the
          // BETTER of the two rather than the worst case — tracked in #4722.
          borderColor: focused ? brandColors.primary : systemColors.separator,
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
    // Two lines at rest, matching `EndSessionSheet`'s recap box: 2 x 20pt
    // subheadline + 16pt padding + 2pt border = 58, on the 4pt grid. One line
    // was half the complaint in #4642 still shipping — a beta note opens with
    // room for a sentence, not a word.
    minHeight: 64,
    // Past this the note scrolls INSIDE the field, and an Android multiline
    // TextInput draws no scrollbar — so whatever is above the ceiling is gone
    // with nothing on screen to say so. At the old 96pt (4 lines) that bit
    // early: on a 405x900pt Pixel emulator a six-line note opened mid-sentence
    // ("before the dyn beta is solid now and I wan...") while ~300pt of the
    // sheet sat empty below this row (#4642). 160pt is seven lines
    // (7 x 20 + 16 padding + 2 border = 158, 2pt spare) — +67% on the old
    // ceiling, so a long note stays one glance rather than a blind scroll.
    //
    // iOS is the tighter of the two and the real bound on this number: its
    // keyboard-up visible body is 162pt. Derived, not measured, on the
    // reference device the detent test pins (`log-ascent-sheet.test.tsx`:
    // window 844 - top inset 44 - iOS-26 card gap 24 = base 776). The '92%'
    // keyboard detent gives a 694pt column; KAV `behavior="padding"` takes 336
    // for the keyboard, leaving 358; less the 56pt header and the 140pt
    // footer = 162. The footer is 140 and NOT 106 because
    // `useWindowBottomInset()` keeps returning the published 34pt window inset
    // while the keyboard is up — nothing in the app zeroes it on keyboard show
    // (`hooks/use-window-bottom-inset.ts`). An earlier draft assumed that inset
    // collapsed, read the body as ~196pt, and set 180 — which overflows the
    // real body by 18pt. A field taller than the visible body can never scroll
    // fully into view, so anyone raising this ceiling has to re-check that
    // inset first, not just the detent.
    //
    // Anything longer scrolls the sheet body, which at least moves visibly.
    // Detent VALUES are unchanged: the body is scrollable under a pinned
    // footer, so the extra height costs the Attempt/Send bar nothing (the
    // derivations in `tick-sheet-metrics.ts` do carry the taller note row).
    maxHeight: 160,
    textAlignVertical: 'top',
  },
});
