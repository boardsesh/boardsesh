// SwitchRow — web implementation (react-native-web + react-native-paper). Renders
// the shared `ListRow` (label + optional description) with a Material 3 Paper
// `Switch` in its trailing slot — the Material counterpart to the Compose Row +
// Switch in SwitchRow.android.tsx. The toggle guard + selection haptic live in
// SwitchRow.logic.ts, shared with both native files.
//
// The wrapping Pressable owns the tap and switch semantics so the full row is a
// target. The visual Switch is pointer-inert to prevent a double toggle.

import { Pressable, StyleSheet } from 'react-native';
import { Switch } from 'react-native-paper';
import { ListRow } from './ListRow';
import { makeToggleHandler } from './SwitchRow.logic';
import type { SwitchRowProps } from './SwitchRow.types';

export function SwitchRow({ label, description, value, onValueChange, disabled = false, tint }: SwitchRowProps) {
  const handleToggle = makeToggleHandler(onValueChange, disabled);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => handleToggle(!value)}
      style={disabled ? styles.disabled : undefined}
    >
      <ListRow
        title={label}
        subtitle={description}
        showSeparator={false}
        trailing={<Switch value={value} disabled={disabled} pointerEvents="none" color={tint} />}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  disabled: {
    opacity: 0.4,
  },
});
