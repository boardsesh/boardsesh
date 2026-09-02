// SwitchRow — iOS implementation, real SwiftUI via @expo/ui/swift-ui.
//
// A single SwiftUI `Toggle` (the native iOS switch) inside its own `Host`. The
// Toggle's two `Text` children are its title + subtitle — SwiftUI renders the
// second as secondary automatically, so the label/description styling, ≥44pt tap
// target, switch accessibility trait, and on/off announcement all come from the
// platform for free. We only bridge the brand on-track tint and the disabled
// state via modifiers.
//
// One Host per row is intentional for PR-1 (SwitchRow is used one-per-card
// today). PR-2 consolidates whole settings screens into a single SwiftUI Form.

import { Toggle, Text } from '@expo/ui/swift-ui';
import { tint, disabled as disabledModifier, padding } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { ThemedHost } from './ThemedHost';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { makeToggleHandler } from './SwitchRow.logic';
import type { SwitchRowProps } from './SwitchRow.types';

// Floor the host height in RN's layout. The native iOS Host (matchContents
// vertical) under-reports the Toggle's intrinsic height to React Native, so a row
// renders shorter than its content — adjacent rows with no separator (e.g. the
// filter sheet's progress toggles) overlap. A minHeight reserves the row in Yoga;
// the Toggle still grows taller via matchContents for an unusually long
// description. A row with a subtitle needs more than a single-line row.
const ROW_MIN_HEIGHT = 48;
const ROW_MIN_HEIGHT_WITH_SUBTITLE = 64;

export function SwitchRow({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
  tint: tintColor,
}: SwitchRowProps) {
  const { brandColors } = useTheme();
  const handleToggle = makeToggleHandler(onValueChange, disabled);
  // On-track colour: brand accent (purple) by default; the logbook passes amber.
  const onTrack = tintColor ?? brandAccentColor(brandColors);

  return (
    <ThemedHost
      matchContents={{ vertical: true }}
      style={[styles.host, { minHeight: description ? ROW_MIN_HEIGHT_WITH_SUBTITLE : ROW_MIN_HEIGHT }]}
    >
      <Toggle
        isOn={value}
        onIsOnChange={handleToggle}
        modifiers={[
          // Inset the row so the trailing switch isn't flush with (and clipped by)
          // the container's right edge — matches the old row's paddingHorizontal
          // and the Android impl's padding.
          padding({ horizontal: spacing[4], vertical: spacing[2] }),
          // On-track colour (brand accent by default; amber for the logbook).
          tint(onTrack),
          // SwiftUI greys the control and blocks interaction natively.
          disabledModifier(disabled),
          // No explicit accessibilityLabel: SwiftUI derives the label from BOTH
          // Text children (title + subtitle), so VoiceOver announces the
          // description too — the standard iOS Settings behaviour, and parity with
          // Android (which reads label + description). The switch trait + on/off
          // value are added by the native Toggle.
        ]}
      >
        <Text>{label}</Text>
        {description ? <Text>{description}</Text> : null}
      </Toggle>
    </ThemedHost>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});
