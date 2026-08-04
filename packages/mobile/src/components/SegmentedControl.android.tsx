// SegmentedControl — Android implementation, react-native-paper `SegmentedButtons`
// (the same component the web fallback uses; see SegmentedControl.web.tsx).
//
// This control used to be a native Jetpack Compose `SingleChoiceSegmentedButtonRow`
// via @expo/ui, but taps on it (and on every other @expo/ui `SegmentedButton` in the
// app, e.g. Climb Bias) silently did nothing on real Android devices — confirmed via
// a live OTA preview build, not just an emulator. The failure lives in @expo/ui's
// Jetpack Compose `SingleChoiceSegmentedButtonRow`/`SegmentedButton` pairing
// specifically: `Button.android.tsx` uses the same `<Host>`-wrapped @expo/ui Compose
// pattern for a plain button and works fine, so this isn't the broader
// Host/RNGH-touch-dispatch problem a previous fix here assumed (that fix shipped and
// still didn't resolve it). Falling back to Paper sidesteps whatever is wrong with
// that specific Compose row/button combo entirely — Paper is still a live dependency
// for other native Android controls (Button.android.tsx's own doc comment; see the
// paper-removal endgame in #3273), so this isn't introducing a new pattern.
//
// `tint` (the logbook's amber) recolours the selected segment via a scoped Paper
// theme override — `secondaryContainer` is the fill, `onSecondaryContainer` the
// on-fill label/check, derived to stay readable on the given fill. The default
// (purple) needs no override — it's already the brand `secondaryContainer` from
// buildPaperTheme (mirrors SegmentedControl.web.tsx's reasoning exactly).
//
// `accessibilityLabel` (the group name, e.g. "Warm-up") IS forwarded here — unlike
// the retired Compose version, Paper's `SegmentedButtons` exposes no group-label
// semantics of its own, so it's carried by a wrapping `radiogroup` View (mirrors the
// pre-@expo/ui Material implementation this restores).

import { StyleSheet, View } from 'react-native';
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
      onValueChange={(next) => handleSelect(next as K)}
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
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {control}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    width: '100%',
  },
});
