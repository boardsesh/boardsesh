// MoreForm — iOS implementation, a real SwiftUI `Form` via @expo/ui/swift-ui.
//
// The entire "More" settings screen is ONE `Host` containing a single SwiftUI
// `Form` (the grouped, inset-rounded iOS Settings look — section insets,
// separators, and scrolling all for free). This mirrors the FeatureFlagsForm
// pilot: instead of one `Host` per control, the whole form lives under one `Host`.
//
// HOST SIZING: a `Form` is a scrolling container that fills its space, so the Host
// uses `style={{ flex: 1 }}` + `useViewportSizeMeasurement` (gives SwiftUI the
// viewport as its proposed size). Per-row controls elsewhere use `matchContents`;
// a Form is the opposite case — it takes all the height it's given.
//
// The screen (more.tsx) precomputes every string + handler (incl. haptics), so
// this tree only renders props. The rows come from settings-rows.ios, shared with
// the iOS Filters sheet (ClimbFilterForm.ios).

import { Host } from '@expo/ui';
import { Form, Section, Text } from '@expo/ui/swift-ui';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { brandAccentColor, brandControlTint } from '../theme/expo-ui-modifiers';
import { renderSettingsRow, type SettingsRowTints } from './settings-rows.ios';
import type { MoreFormProps } from './MoreForm.types';

export function MoreForm({ model }: MoreFormProps) {
  const { brandColors, colorScheme } = useTheme();
  const tints: SettingsRowTints = { control: brandControlTint(brandColors), fill: brandAccentColor(brandColors) };

  return (
    // `colorScheme` forces the native appearance to follow our in-app Light/Dark
    // toggle (`themeOverride`) instead of the OS scheme — harmless on iOS but the
    // way the SwiftUI tree honours a non-system choice.
    <Host style={styles.host} useViewportSizeMeasurement colorScheme={colorScheme}>
      <Form>
        {model.sections.map((section) => (
          <Section
            key={section.key}
            title={section.title}
            footer={section.footer ? <Text>{section.footer}</Text> : undefined}
          >
            {section.rows.map((row) => renderSettingsRow(row, tints))}
          </Section>
        ))}
      </Form>
    </Host>
  );
}

const styles = StyleSheet.create({
  // A Form fills the screen; flex + useViewportSizeMeasurement give SwiftUI the
  // viewport as its proposed size so the Form scrolls within it.
  host: {
    flex: 1,
  },
});
