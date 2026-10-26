// The Compose pieces CapsuleRow.android.tsx is built from, lifted from the
// climbs chip row: a plain action chip, a chip that anchors a controlled
// DropdownMenu, and one menu row. Native Jetpack Compose Material 3 via @expo/ui.
//
// Compose specifics:
//   • DropdownMenu is CONTROLLED: each menu chip owns its `expanded` state (cf.
//     MoreForm.android.tsx's SelectRow). The chip's onClick opens it; an explicit
//     close() in an item dismisses it (Compose doesn't auto-dismiss on click).
//   • A FilterChip always wires its own internal click, which eats a long-press
//     before any `combinedClickable` sees it (#3319, #3322). Every chip is
//     tap-only.

import { useState, type ReactNode } from 'react';
import type { ImageSourcePropType } from 'react-native';
import { Text, Icon, Badge, Row, FilterChip, DropdownMenu, DropdownMenuItem } from '@expo/ui/jetpack-compose';
import { semantics } from '@expo/ui/jetpack-compose/modifiers';
import { useTheme } from '../../providers/theme-provider';
import { filterChipBorder, type filterChipBrandColors } from '../../theme/expo-ui-modifiers';
import { CHECK_ICON_SOURCE } from './capsule-icons.android';
import { capsuleBadgeLabel } from './CapsuleRow.logic';
import { spacing } from '../../theme/tokens';

// M3 chip / menu leading-icon size.
const ICON_SIZE = 18;

export type CapsuleChipColors = ReturnType<typeof filterChipBrandColors>;

// A Compose chip draws a custom border in every state, so only an idle chip gets
// the `outline` one; a selected chip keeps M3's borderless brand fill.
function useIdleChipBorder(selected: boolean) {
  const { m3 } = useTheme();
  return selected ? undefined : filterChipBorder(m3);
}

function ChipContent({ label, iconSource }: { label: string; iconSource?: ImageSourcePropType }) {
  return (
    <>
      {iconSource ? (
        <FilterChip.LeadingIcon>
          <Icon source={iconSource} size={ICON_SIZE} />
        </FilterChip.LeadingIcon>
      ) : null}
      <FilterChip.Label>
        <Text>{label}</Text>
      </FilterChip.Label>
    </>
  );
}

/** A chip with no menu (sheet openers, rails, toggles): tap fires `onPress`. */
export function ActionChip({
  label,
  selected,
  colors,
  iconSource,
  iconOnly = false,
  badgeCount,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  selected: boolean;
  colors: CapsuleChipColors;
  iconSource?: ImageSourcePropType;
  iconOnly?: boolean;
  badgeCount?: number;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const { brandColors } = useTheme();
  const border = useIdleChipBorder(selected);
  const badgeLabel = capsuleBadgeLabel(badgeCount);
  // A chip speaks its own label when it has one ("Board angle, 40°" for a chip
  // that shows "40°"); an icon-only chip falls back to its visible label.
  const spokenLabel = accessibilityLabel ?? (iconOnly ? label : undefined);
  return (
    <FilterChip
      selected={selected}
      colors={colors}
      border={border}
      onClick={onPress}
      modifiers={spokenLabel ? [semantics({ contentDescription: spokenLabel })] : undefined}
    >
      {iconOnly ? (
        <FilterChip.Label>
          <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: spacing[1] }}>
            {/* This icon sits in the Label slot, so the chip's `iconColor` never
                reaches it; tint it to match a leading icon in the same state. */}
            {iconSource ? (
              <Icon
                source={iconSource}
                size={ICON_SIZE}
                tint={selected ? colors.selectedLeadingIconColor : colors.iconColor}
              />
            ) : null}
            {badgeLabel ? (
              <Badge
                containerColor={selected ? brandColors.onPrimary : brandColors.primaryFill}
                contentColor={selected ? brandColors.primaryFill : brandColors.onPrimary}
              >
                <Text color={selected ? brandColors.primaryFill : brandColors.onPrimary}>{badgeLabel}</Text>
              </Badge>
            ) : null}
          </Row>
        </FilterChip.Label>
      ) : (
        <ChipContent label={label} iconSource={iconSource} />
      )}
    </FilterChip>
  );
}

/**
 * A chip that anchors a controlled DropdownMenu. `renderItems` gets a `close` so
 * single-choice and destructive items dismiss, while keep-open items simply
 * don't call it.
 */
export function MenuChip({
  label,
  selected,
  colors,
  iconSource,
  renderItems,
}: {
  label: string;
  selected: boolean;
  colors: CapsuleChipColors;
  iconSource?: ImageSourcePropType;
  renderItems: (close: () => void) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const border = useIdleChipBorder(selected);
  // Only the popup (`DropdownMenu.Items` → MenuItem) needs an explicit text
  // colour: the trigger chip renders inside the row's single `colorScheme`-pinned
  // Host, so its label already tracks the in-app theme.
  return (
    <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
      <DropdownMenu.Trigger>
        <FilterChip selected={selected} colors={colors} border={border} onClick={() => setExpanded(true)}>
          <ChipContent label={label} iconSource={iconSource} />
        </FilterChip>
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>{renderItems(() => setExpanded(false))}</DropdownMenu.Items>
    </DropdownMenu>
  );
}

/**
 * One menu row: a leading check when `checked` (else the optional icon), a text
 * label, an optional text colour (the destructive red).
 *
 * The DropdownMenu popup is a separate Compose composition: the Host's
 * `colorScheme` does not reach it, and a custom `Text` in an item slot does NOT
 * inherit `DropdownMenuItem`'s content colour. Without an explicit scheme-aware
 * colour the labels render dark-on-dark when the app runs dark on a light-mode
 * device (same fix as AppMenu.android).
 */
export function MenuItem({
  label,
  checked,
  onClick,
  iconSource,
  textColor,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
  iconSource?: ImageSourcePropType;
  textColor?: string;
}) {
  const { systemColors } = useTheme();
  const itemColor = textColor ?? (systemColors.label as string);
  const leadingIcon = checked ? CHECK_ICON_SOURCE : iconSource;
  return (
    <DropdownMenuItem onClick={onClick} elementColors={{ textColor: itemColor }}>
      {leadingIcon ? (
        <DropdownMenuItem.LeadingIcon>
          <Icon source={leadingIcon} size={ICON_SIZE} />
        </DropdownMenuItem.LeadingIcon>
      ) : null}
      <DropdownMenuItem.Text>
        <Text color={itemColor}>{label}</Text>
      </DropdownMenuItem.Text>
    </DropdownMenuItem>
  );
}
