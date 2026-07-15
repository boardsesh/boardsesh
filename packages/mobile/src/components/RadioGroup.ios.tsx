// RadioGroup — iOS implementation, real SwiftUI via @expo/ui/swift-ui.
//
// `variant='inline'` (default): a single SwiftUI `Picker` in `inline` style — a
// vertical list of options with a checkmark on the selected row (every option
// visible), wrapped in the grouped-inset card the old hand-rolled control had.
//
// `variant='menu'`: a SwiftUI `Menu` whose trigger is a full-width row (the current
// value on the left, a chevron on the right, matching the sheet's other tappable
// rows) that opens the options in a native dropdown on a single tap — an inline
// `Picker` inside the menu renders the checkmarked option list. This keeps the
// control collapsed to one row until pressed, instead of the tall always-open list.
//
// Both share `makeRadioSelectHandler` for selection. iOS limitation: the Picker
// can't express a per-option `disabled`/`description` — dropped here (honoured on
// Android). The one call site that used them (the status filter's signed-out
// "drafts" gating) handles that at the call site, so this is a graceful degrade.

import { useMemo } from 'react';
import { Host } from '@expo/ui';
import { Picker, Text, Menu, HStack, Spacer, Image } from '@expo/ui/swift-ui';
import { pickerStyle, tint, tag, padding } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { makeRadioSelectHandler } from './RadioGroup.logic';
import type { RadioGroupProps } from './RadioGroup.types';

// `matchContents={{ vertical: true }}` lets the Host track the Picker's real height,
// so the rows grow with Dynamic Type instead of being clipped by a hard frame (the
// proven AngleSlider / SwitchRow pattern for a content-sized control). The
// `minHeight` floor only guards against the native Host under-reporting at the
// default text size, so the card can't collapse. Each inline row is ~44pt at the
// default size; under-report risk under very large Dynamic Type is a known limit to
// confirm on device.
const ROW_HEIGHT = 44;

export function RadioGroup<T extends string>({ options, value, onChange, variant = 'inline' }: RadioGroupProps<T>) {
  const { systemColors, brandColors } = useTheme();
  // Memoize so a stable `onChange` doesn't push a new handler into the native Host
  // (and re-render the SwiftUI tree) on every parent render.
  const handleSelect = useMemo(() => makeRadioSelectHandler(onChange), [onChange]);

  const onSelectionChange = (selected: string | number | null) => {
    // @expo/ui types the selection as the untyped Picker tag; our tags are always
    // the string option values, so guard rather than blind-cast.
    if (typeof selected !== 'string') return;
    const option = options.find((candidate) => candidate.value === selected);
    if (option) handleSelect(option);
  };

  const optionItems = options.map((option) => (
    <Text key={option.value} modifiers={[tag(option.value)]}>
      {option.label}
    </Text>
  ));

  if (variant === 'menu') {
    const selectedLabel = options.find((option) => option.value === value)?.label ?? '';
    return (
      <Host
        matchContents={{ vertical: true }}
        style={[styles.host, { backgroundColor: systemColors.tertiaryBackground }]}
      >
        <Menu
          label={
            // A full-width row (value left, chevron right) matching the sheet's
            // other tappable rows — the Spacer stretches the HStack to fill. No tint
            // here so the value/chevron read neutral like the sibling "None" rows;
            // the brand tint lives on the inner Picker's selected checkmark.
            <HStack alignment="center" modifiers={[padding({ horizontal: spacing[4], vertical: spacing[3] })]}>
              <Text>{selectedLabel}</Text>
              <Spacer />
              <Image systemName="chevron.up.chevron.down" size={13} color={systemColors.secondaryLabel as string} />
            </HStack>
          }
        >
          <Picker
            selection={value}
            onSelectionChange={onSelectionChange}
            modifiers={[pickerStyle('inline'), tint(brandAccentColor(brandColors))]}
          >
            {optionItems}
          </Picker>
        </Menu>
      </Host>
    );
  }

  return (
    <Host
      matchContents={{ vertical: true }}
      style={[
        styles.host,
        { backgroundColor: systemColors.secondaryBackground, minHeight: options.length * ROW_HEIGHT },
      ]}
    >
      <Picker
        selection={value}
        onSelectionChange={onSelectionChange}
        modifiers={[
          pickerStyle('inline'),
          // Brand checkmark on the selected row, sourced once via the theming bridge.
          tint(brandAccentColor(brandColors)),
        ]}
      >
        {optionItems}
      </Picker>
    </Host>
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
