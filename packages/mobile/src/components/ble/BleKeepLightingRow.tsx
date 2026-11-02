import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppMenu } from '../AppMenu';
import { Text } from '../Text';
import type { KeepLightingChoice } from '../../lib/keep-lighting';
import { spacing } from '../../theme/tokens';

/** What the board sheet's keep-lighting row shows and changes. */
export type BleKeepLightingRowModel = {
  /** Stop driving after's label, the same on every board. */
  label: string;
  choice: KeepLightingChoice;
  /** Every choice, in order, with its words. */
  options: readonly { key: KeepLightingChoice; label: string }[];
  onChange: (choice: KeepLightingChoice) => void;
};

/** A row's height (44 pt). The menu's anchor is the touch target: 44 pt on iOS, 48 dp on Android (`AppMenu`). */
const ROW_MIN_HEIGHT = 44;

/**
 * The board sheet's keep-lighting row (2.7, spec B4): at the wall, hold the
 * button and pick here to change the timer or turn it off, without a trip to
 * Settings › Board (WCAG 2.2.1). A native menu (SwiftUI Menu / Compose
 * DropdownMenu) with the current choice ticked. The label and the menu sit
 * side by side and wrap under each other at large text.
 */
export function BleKeepLightingRow({ model }: { model: BleKeepLightingRowModel }) {
  const current = model.options.find((option) => option.key === model.choice)?.label ?? '';
  // A native menu can deliver a tap queued before this render: read the latest choices then.
  const modelRef = useRef(model);
  modelRef.current = model;
  const handleSelect = useCallback((index: number) => {
    const option = modelRef.current.options[index];
    if (option) modelRef.current.onChange(option.key);
  }, []);
  const actions = useMemo(
    () => model.options.map((option) => ({ label: option.label, selected: option.key === model.choice })),
    [model.options, model.choice],
  );
  return (
    <View style={styles.row} testID="ble-control-keep-lighting">
      <Text
        variant="body"
        style={styles.label}
        // The menu's own name starts with it: a screen reader reads the row once, on the control.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {model.label}
      </Text>
      <AppMenu
        label={current}
        accessibilityLabel={`${model.label}, ${current}`}
        actions={actions}
        onSelectIndex={handleSelect}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing[2],
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  label: {
    flexShrink: 1,
  },
});
