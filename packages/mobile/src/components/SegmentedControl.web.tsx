// SegmentedControl — web implementation (react-native-web + react-native-paper). A
// Material 3 Paper `SegmentedButtons` row — the counterpart to the Compose
// `SingleChoiceSegmentedButtonRow` in SegmentedControl.android.tsx. The selection
// haptic + per-key disabled guard live in SegmentedControl.logic.ts, shared with
// both native files.
//
// `tint` (the logbook's amber) recolours the selected segment via a scoped Paper
// theme override — `secondaryContainer` is the fill, `onSecondaryContainer` the
// on-fill label/check, derived to stay readable on the given fill. The default
// (purple) needs no override — it's already the brand `secondaryContainer` from
// buildPaperTheme. The `accessibilityLabel` group name is intentionally not applied
// (mirrors Android: the visible section heading names the group).

import { createElement } from 'react';
import { StyleSheet } from 'react-native';
import { SegmentedButtons } from 'react-native-paper';
import { readableTextColor } from './grade/grade-chip-colors';
import { makeSelectHandler } from './SegmentedControl.logic';
import type { SegmentedControlProps } from './SegmentedControl.types';

export function SegmentedControl<K extends string = string>({
  options,
  selectedKey,
  onSelect,
  disabledKeys,
  tint,
  accessibilityLabel,
}: SegmentedControlProps<K>) {
  const handleSelect = makeSelectHandler(onSelect, disabledKeys);

  const control = (
    <SegmentedButtons
      value={selectedKey}
      onValueChange={(next) => handleSelect(next)}
      style={styles.row}
      // A scoped colour override so the selected segment fills with `tint` and its
      // label/check stay readable on that fill. Omitted (undefined) for the default
      // purple — already the brand `secondaryContainer` from buildPaperTheme.
      theme={tint ? { colors: { secondaryContainer: tint, onSecondaryContainer: readableTextColor(tint) } } : undefined}
      buttons={options.map((option) => ({
        value: option.key,
        label: option.label,
        accessibilityLabel: option.label,
        disabled: disabledKeys?.has(option.key),
      }))}
    />
  );

  if (!accessibilityLabel) return control;
  return createElement('div', { role: 'radiogroup', 'aria-label': accessibilityLabel }, control);
}

const styles = StyleSheet.create({
  row: {
    width: '100%',
  },
});
