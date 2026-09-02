// FeatureFlagsForm — iOS implementation, a real SwiftUI `Form` via @expo/ui/swift-ui.
//
// The whole tester-only Feature Flags screen is ONE `Host` containing a single
// SwiftUI `Form` (the grouped, inset-rounded settings look you get in iOS
// Settings — for free, including the scrolling, section insets, and separators).
// This is the PR-2 consolidation the PR-1 primitives anticipated: instead of one
// `Host` per control, the entire form lives under one `Host`.
//
// HOST SIZING IS DIFFERENT FROM A STANDALONE CONTROL. A `Form` is a scrolling
// container that wants to fill its space, not size to its content. So this Host
// uses `style={{ flex: 1 }}` + `useViewportSizeMeasurement` (HostProps: "the host
// will use the viewport size as the proposed size for SwiftUI layout … useful for
// SwiftUI views that need to fill their available space, such as `Form`"). The
// per-row controls (SwitchRow/SegmentedControl) use `matchContents` because they
// must report their intrinsic height back to RN's layout; a Form is the opposite
// case — it takes all the height it's given.
//
// All copy is hardcoded English with `i18n-ignore` — tester-only, matching the
// rest of the screen. The screen precomputes every derived string; this tree only
// renders props.

import { Form, Section, Picker, Text, Button, VStack } from '@expo/ui/swift-ui';
import {
  pickerStyle,
  tint,
  tag,
  font,
  foregroundStyle,
  disabled as disabledModifier,
  accessibilityLabel,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { ThemedHost } from './ThemedHost';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { isKnownFeatureFlagChoice } from './FeatureFlagsForm.logic';
import type { FeatureFlagsFormProps } from './FeatureFlagsForm.types';

export function FeatureFlagsForm({ rows, onSelect, onReset, canReset, noticeText, title }: FeatureFlagsFormProps) {
  const { brandColors } = useTheme();
  const accent = brandAccentColor(brandColors);

  return (
    // `colorScheme` forces the native appearance to follow the in-app Light/Dark
    // toggle (`themeOverride`) instead of the OS scheme.
    <ThemedHost style={styles.host} useViewportSizeMeasurement>
      <Form>
        {/* `title` is the section header; `footer` carries the notice. A footer is a
            view slot, so it's a `<Text>` child, not a raw string. */}
        <Section title={title} footer={<Text>{noticeText}</Text>}>
          {rows.map((row) => (
            <VStack key={row.key} alignment="leading" spacing={spacing[1]}>
              <Text>{row.label}</Text>
              <Text
                modifiers={[
                  font({ textStyle: 'footnote' }),
                  foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                ]}
              >
                {row.description}
              </Text>
              {/* Native iOS segmented control; brand-tinted selected fill. The tag
                  on each option maps SwiftUI's selection to the choice key. */}
              <Picker
                selection={row.choice}
                onSelectionChange={(value) => {
                  // @expo/ui types the selection as the untyped Picker tag; narrow
                  // it to one of this row's own option keys before forwarding
                  // (drops anything unexpected rather than blind-casting).
                  if (isKnownFeatureFlagChoice(value, row.options)) onSelect(row.key, value);
                }}
                // Name the segmented group for VoiceOver (the visible label sits
                // above; this gives the control itself an accessible name).
                modifiers={[pickerStyle('segmented'), tint(accent), accessibilityLabel(row.label)]}
              >
                {row.options.map((option) => (
                  <Text key={option.key} modifiers={[tag(option.key)]}>
                    {option.label}
                  </Text>
                ))}
              </Picker>
              <Text
                modifiers={[
                  font({ textStyle: 'caption' }),
                  foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                ]}
              >
                {row.effectiveLabel}
              </Text>
            </VStack>
          ))}
        </Section>
        {/* Reset lives in its own section so it reads as a standalone destructive
            row (the standard iOS Settings idiom). `destructive` colours it red;
            `disabled` greys it out and blocks the tap when there's nothing to reset. */}
        <Section>
          {/* i18n-ignore-next-line — tester-only screen */}
          <Button
            role="destructive"
            label="Reset all overrides"
            onPress={onReset}
            modifiers={[disabledModifier(!canReset)]}
          />
        </Section>
      </Form>
    </ThemedHost>
  );
}

const styles = StyleSheet.create({
  // A Form fills the screen; flex + useViewportSizeMeasurement give SwiftUI the
  // viewport as its proposed size so the Form scrolls within it.
  host: {
    flex: 1,
  },
});
