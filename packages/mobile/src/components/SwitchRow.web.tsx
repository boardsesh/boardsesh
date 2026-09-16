// SwitchRow — web implementation (react-native-web + react-native-paper). Renders
// the shared `ListRow` (label + optional description) with a Material 3 Paper
// `Switch` in its trailing slot — the Material counterpart to the Compose Row +
// Switch in SwitchRow.android.tsx. The toggle guard + selection haptic live in
// SwitchRow.logic.ts, shared with both native files.
//
// The wrapping Pressable owns the tap and switch semantics so the full row is a
// target. The visual Switch is pointer-inert to prevent a double toggle.
//
// Semantics use the aria props: react-native-web 0.21 drops `accessibilityState`,
// so `{ checked }` never reached the DOM and screen readers heard a switch with
// no on/off state.

import { Pressable, StyleSheet } from 'react-native';
import { Switch } from 'react-native-paper';
import { ListRow } from './ListRow';
import { makeToggleHandler } from './SwitchRow.logic';
import type { SwitchRowProps } from './SwitchRow.types';

export function SwitchRow({
  label,
  description,
  wrapDescription = false,
  value,
  onValueChange,
  disabled = false,
  tint,
}: SwitchRowProps) {
  const handleToggle = makeToggleHandler(onValueChange, disabled);

  return (
    <Pressable
      role="switch"
      aria-label={label}
      aria-checked={value}
      aria-disabled={disabled}
      accessibilityHint={description}
      disabled={disabled}
      onPress={() => handleToggle(!value)}
      style={disabled ? styles.disabled : undefined}
    >
      <ListRow
        title={label}
        subtitle={description}
        wrapSubtitle={wrapDescription}
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
