// The web pieces CapsuleRow.web.tsx is built from (react-native-web +
// react-native-paper), lifted from the climbs chip row: one Paper chip, and a
// chip that anchors a controlled Paper Menu.
//
// An active chip is filled with `primaryFill` and labelled in `onPrimary`, the
// same pair the iOS and Compose capsules use. Paper's own selected outlined chip
// would draw `secondaryContainer` (a pale brand wash) instead.

import { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Chip, Menu } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';

type CapsuleChipProps = {
  label: string;
  selected: boolean;
  /** A Paper (MaterialCommunityIcons) icon name. */
  icon?: string;
  accessibilityLabel?: string;
  onPress: () => void;
};

/** One Paper chip in the capsule style. */
export function CapsuleChip({ label, selected, icon, accessibilityLabel, onPress }: CapsuleChipProps) {
  const { brandColors } = useTheme();
  const activeStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.chip, { backgroundColor: brandColors.primaryFill, borderColor: brandColors.primaryFill }],
    [brandColors.primaryFill],
  );
  return (
    <Chip
      mode="outlined"
      selected={selected}
      icon={icon}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      // Paper uses `selectedColor` for the label whenever it is set, selected or
      // not, so it is only passed while the chip is active.
      selectedColor={selected ? brandColors.onPrimary : undefined}
      style={selected ? activeStyle : styles.chip}
    >
      {label}
    </Chip>
  );
}

/**
 * A capsule chip that anchors a controlled Paper Menu. The `children` render-prop
 * receives a `close` so single-choice items can dismiss (keep-open items simply
 * don't call it).
 */
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
      anchor={<CapsuleChip label={label} selected={selected} icon={icon} onPress={() => setVisible(true)} />}
    >
      {children(() => setVisible(false))}
    </Menu>
  );
}

const styles = StyleSheet.create({
  // The row's `gap` does the spacing, so no chip adds a trailing margin of its own.
  chip: {
    marginEnd: 0,
  },
});
