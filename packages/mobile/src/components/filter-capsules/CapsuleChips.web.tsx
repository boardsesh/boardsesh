// The web pieces CapsuleRow.web.tsx is built from (react-native-web +
// react-native-paper), lifted from the climbs chip row: one Paper chip, and a
// chip that anchors a controlled Paper Menu.
//
// An active chip is filled with `primaryFill` and labelled in `onPrimary`, the
// same pair the iOS and Compose capsules use. Paper's own selected outlined chip
// would draw `secondaryContainer` (a pale brand wash) instead.

import { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Badge, Chip, Icon, Menu } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { capsuleBadgeLabel } from './CapsuleRow.logic';

type CapsuleChipProps = {
  label: string;
  selected: boolean;
  /** A Paper (MaterialCommunityIcons) icon name. */
  icon?: string;
  accessibilityLabel?: string;
  iconOnly?: boolean;
  badgeCount?: number;
  onPress: () => void;
};

/** One Paper chip in the capsule style. */
export function CapsuleChip({
  label,
  selected,
  icon,
  accessibilityLabel,
  iconOnly = false,
  badgeCount,
  onPress,
}: CapsuleChipProps) {
  const { brandColors, systemColors } = useTheme();
  const badgeLabel = capsuleBadgeLabel(badgeCount);
  const activeStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.chip, { backgroundColor: brandColors.primaryFill, borderColor: brandColors.primaryFill }],
    [brandColors.primaryFill],
  );
  return (
    <Chip
      mode="outlined"
      selected={selected}
      icon={
        iconOnly && icon
          ? () => (
              <View style={styles.iconBadge} accessible={false}>
                <Icon
                  source={icon}
                  size={18}
                  color={selected ? brandColors.onPrimary : (systemColors.secondaryLabel as string)}
                />
                {badgeLabel ? (
                  <Badge
                    size={18}
                    accessible={false}
                    style={{
                      backgroundColor: selected ? brandColors.onPrimary : brandColors.primaryFill,
                      color: selected ? brandColors.primaryFill : brandColors.onPrimary,
                    }}
                  >
                    {badgeLabel}
                  </Badge>
                ) : null}
              </View>
            )
          : icon
      }
      onPress={onPress}
      accessibilityLabel={iconOnly ? (accessibilityLabel ?? label) : accessibilityLabel}
      showSelectedCheck={iconOnly ? false : undefined}
      textStyle={iconOnly ? styles.hiddenLabel : undefined}
      // Paper uses `selectedColor` for the label whenever it is set, selected or
      // not, so it is only passed while the chip is active.
      selectedColor={selected ? brandColors.onPrimary : undefined}
      style={selected ? activeStyle : styles.chip}
    >
      {iconOnly ? '' : label}
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
  iconBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  // Keep only the native icon slot's trailing gutter, without a blank text label.
  hiddenLabel: { width: 0, minHeight: 0, lineHeight: 0, marginLeft: 0, marginRight: spacing[2] },
});
