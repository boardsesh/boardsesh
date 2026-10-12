// The web capsule menu chip (react-native-web + react-native-paper), lifted from
// the climbs chip row: a Paper Chip that anchors a controlled Paper Menu. The
// `children` render-prop receives a `close` so single-choice items can dismiss
// (keep-open items simply don't call it).

import { useState, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Chip, Menu } from 'react-native-paper';

export function CapsuleMenuChip({
  label,
  selected,
  icon,
  children,
}: {
  label: string;
  selected: boolean;
  icon?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Menu
      visible={visible}
      onDismiss={() => setVisible(false)}
      anchor={
        <Chip
          mode="outlined"
          selected={selected}
          icon={icon}
          onPress={() => setVisible(true)}
          style={capsuleChipStyles.chip}
        >
          {label}
        </Chip>
      }
    >
      {children(() => setVisible(false))}
    </Menu>
  );
}

/** Shared by every web capsule chip. */
export const capsuleChipStyles = StyleSheet.create({
  // The row's `gap` does the spacing, so no chip adds a trailing margin of its own.
  chip: {
    marginEnd: 0,
  },
});
