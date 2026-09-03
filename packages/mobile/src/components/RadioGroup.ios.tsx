// RadioGroup — iOS implementation, real SwiftUI via @expo/ui/swift-ui.
//
// A single SwiftUI `Picker` in the `inline` style (a vertical list of options
// with a checkmark on the selected row) inside its own `Host`. Each option is a
// `Text` child carrying a `tag` modifier so SwiftUI maps selection to the option
// value; the row styling, tap targets, single-choice picker a11y (announced as a
// picker, not a pile of hand-rolled `radio` Pressables), and selection animation
// come from the platform. We bridge the brand checkmark tint and wrap the Host in
// the grouped-inset card the old hand-rolled control had.
//
// iOS limitation: the inline Picker can't express a per-option `disabled` or a
// per-option `description` — both are dropped here (honoured on Android). The one
// call site that used them (the status filter's signed-out "drafts" gating) now
// handles that at the call site, so this is a graceful degrade, not a regression.

import { useMemo } from 'react';
import { Picker, Text } from '@expo/ui/swift-ui';
import { pickerStyle, tint, tag } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { ThemedHost } from './ThemedHost';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { makeRadioSelectHandler } from './RadioGroup.logic';
import type { RadioGroupProps } from './RadioGroup.types';

// `matchContents={{ vertical: true }}` lets the Host track the inline Picker's
// real height, so the rows grow with Dynamic Type instead of being clipped by a
// hard frame (the proven AngleSlider / SwitchRow pattern for a content-sized
// control — unlike SegmentedControl, whose intrinsic height is fixed). The
// `minHeight` floor at row-count × ROW_HEIGHT only guards against the native Host
// under-reporting at the default text size, so the card can't collapse. Each row
// is ~44pt at the default size; under-report risk under very large Dynamic Type
// is a known limitation to confirm on device.
const ROW_HEIGHT = 44;

export function RadioGroup<T extends string>({ options, value, onChange }: RadioGroupProps<T>) {
  const { systemColors, brandColors } = useTheme();
  // Memoize so a stable `onChange` doesn't push a new handler into the native Host
  // (and re-render the SwiftUI tree) on every parent render.
  const handleSelect = useMemo(() => makeRadioSelectHandler(onChange), [onChange]);

  return (
    <ThemedHost
      matchContents={{ vertical: true }}
      style={[
        styles.host,
        { backgroundColor: systemColors.secondaryBackground, minHeight: options.length * ROW_HEIGHT },
      ]}
    >
      <Picker
        selection={value}
        onSelectionChange={(selected) => {
          // @expo/ui types the selection as the untyped Picker tag; our tags are
          // always the string option values, so guard rather than blind-cast.
          if (typeof selected !== 'string') return;
          const option = options.find((candidate) => candidate.value === selected);
          if (option) handleSelect(option);
        }}
        modifiers={[
          pickerStyle('inline'),
          // Brand checkmark on the selected row, sourced once via the theming bridge.
          tint(brandAccentColor(brandColors)),
        ]}
      >
        {options.map((option) => (
          <Text key={option.value} modifiers={[tag(option.value)]}>
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
    // Mirror the old grouped-inset card so the control still reads as a single
    // rounded section inside the filter sheet's scroll view.
    borderRadius: 10,
    overflow: 'hidden',
  },
});
