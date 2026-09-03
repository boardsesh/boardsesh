// SegmentedControl — iOS implementation, real SwiftUI via @expo/ui/swift-ui.
//
// A single SwiftUI `Picker` in the `segmented` style (the native iOS segmented
// control) inside its own `Host`. Each option is a `Text` child carrying a `tag`
// modifier so SwiftUI maps selection to the option key; the segment styling, tap
// targets, and selection animation come from the platform. We only bridge the
// brand tint and the group accessibility label via modifiers.
//
// iOS limitation: a SwiftUI segmented Picker has no per-segment disable. So a
// `disabledKeys` entry can't be greyed out individually here — instead the shared
// select handler ignores a tap on a disabled key (Android's SegmentedButton DOES
// disable per-segment via `enabled`). `disabledKeys` is effectively unused on the
// remaining call sites, so this is a graceful degrade, not a regression.
//
// One Host per control is intentional for now (SegmentedControl is used
// one-per-card). A later pass consolidates whole settings screens under one Host.

import { Picker, Text } from '@expo/ui/swift-ui';
import { pickerStyle, tint, tag, accessibilityLabel as accessibilityLabelModifier } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { ThemedHost } from './ThemedHost';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { makeSelectHandler } from './SegmentedControl.logic';
import type { SegmentedControlProps } from './SegmentedControl.types';

export function SegmentedControl<K extends string = string>({
  options,
  selectedKey,
  onSelect,
  disabledKeys,
  accessibilityLabel,
  tint: tintColor,
}: SegmentedControlProps<K>) {
  const { brandColors } = useTheme();
  const handleSelect = makeSelectHandler(onSelect, disabledKeys);
  // The selected-pill fill: brand accent (purple) by default; the logbook passes
  // amber. SwiftUI's segmented Picker derives the selected label's contrast colour
  // from the tint, so no separate on-fill text colour is needed here.
  const selectedFill = tintColor ?? brandAccentColor(brandColors);

  return (
    // Explicit height, NOT matchContents: the native iOS Host under-reported the
    // segmented Picker's height to RN (~26pt for a ~35pt control) AND the style
    // minHeight floor wasn't applied, so the control was squished and a parent
    // with `overflow: 'hidden'` (the profile chrome's rounded glass track) clipped
    // the bottom of the selected pill. A fixed frame sizes the control
    // deterministically across every container.
    <ThemedHost style={styles.host}>
      <Picker
        selection={selectedKey}
        onSelectionChange={(value) => {
          // @expo/ui types the selection as the untyped Picker tag; our tags are
          // always the string option keys, so guard rather than blind-cast (a
          // non-string would otherwise slip through).
          if (typeof value !== 'string') return;
          handleSelect(value as K);
        }}
        modifiers={[
          pickerStyle('segmented'),
          // Selected-fill tint (brand accent by default; amber for the logbook).
          tint(selectedFill),
          // Name the group for VoiceOver (the per-segment Text children stay the
          // individual labels). Skipped when no label is provided.
          ...(accessibilityLabel ? [accessibilityLabelModifier(accessibilityLabel)] : []),
        ]}
      >
        {options.map((option) => (
          <Text key={option.key} modifiers={[tag(option.key)]}>
            {option.label}
          </Text>
        ))}
      </Picker>
    </ThemedHost>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
    // The native segmented control sits ~35pt; 40 contains it with minimal slack.
    // (matchContents under-reported it to ~26pt, clipping the pill.)
    height: 40,
  },
});
