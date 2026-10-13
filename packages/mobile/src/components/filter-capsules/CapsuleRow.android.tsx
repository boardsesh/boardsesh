// CapsuleRow, Android: native Jetpack Compose Material 3 FilterChips +
// DropdownMenus via @expo/ui, one Host with a horizontally scrolling Row. Mirrors
// the SwiftUI tree (CapsuleRow.ios.tsx) capsule for capsule, with these Compose
// differences:
//   sheet / rail / toggle → an action chip (no menu). The rail has no chevron;
//                           the selected container already says a value is set.
//   menu                  → a menu chip; each option commits and closes, a check
//                           marks the selected one; `actions` after a divider.
//   toggleMenu            → a plain toggle chip. Its `actions` are unreachable:
//                           a Compose FilterChip eats the long-press (#3319, #3322).
// Active chips take the brand fill with on-fill text (filterChipBrandColors).

import { memo, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { Host } from '@expo/ui';
import { Row, HorizontalDivider } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, horizontalScroll, padding } from '@expo/ui/jetpack-compose/modifiers';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { filterChipBrandColors } from '../../theme/expo-ui-modifiers';
import { ActionChip, MenuChip, MenuItem, type CapsuleChipColors } from './CapsuleChips.android';
import { CAPSULE_ICON_SOURCE } from './capsule-icons.android';
import { isCapsuleActive } from './CapsuleRow.logic';
import type { Capsule, CapsuleIcon, CapsuleRowProps, MenuCapsule } from './CapsuleRow.types';

function iconSourceFor(icon: CapsuleIcon | undefined) {
  return icon ? CAPSULE_ICON_SOURCE[icon] : undefined;
}

function MenuCapsuleChip({
  capsule,
  colors,
  errorColor,
}: {
  capsule: MenuCapsule;
  colors: CapsuleChipColors;
  errorColor: string;
}) {
  const { options, selected, onSelect, actions } = capsule;
  return (
    <MenuChip
      label={capsule.label}
      selected={capsule.active}
      colors={colors}
      iconSource={iconSourceFor(capsule.icon)}
      renderItems={(close) => (
        <>
          {options.map((option) => (
            <MenuItem
              key={option.value}
              label={option.label}
              checked={option.value === selected}
              onClick={() => {
                onSelect(option.value);
                close();
              }}
            />
          ))}
          {actions && actions.length > 0 ? (
            <>
              <HorizontalDivider />
              {actions.map((action) => (
                <MenuItem
                  key={action.key}
                  label={action.label}
                  checked={false}
                  iconSource={iconSourceFor(action.icon)}
                  textColor={action.destructive ? errorColor : undefined}
                  onClick={() => {
                    action.onPress();
                    close();
                  }}
                />
              ))}
            </>
          ) : null}
        </>
      )}
    />
  );
}

function CapsuleChip({
  capsule,
  colors,
  errorColor,
}: {
  capsule: Capsule;
  colors: CapsuleChipColors;
  errorColor: string;
}) {
  if (capsule.kind === 'menu') return <MenuCapsuleChip capsule={capsule} colors={colors} errorColor={errorColor} />;
  return (
    <ActionChip
      label={capsule.label}
      selected={isCapsuleActive(capsule)}
      colors={colors}
      iconSource={capsule.kind === 'sheet' || capsule.kind === 'toggleMenu' ? iconSourceFor(capsule.icon) : undefined}
      iconOnly={capsule.kind === 'sheet' && capsule.presentation === 'iconBadge'}
      badgeCount={capsule.kind === 'sheet' ? capsule.count : undefined}
      accessibilityLabel={capsule.kind === 'sheet' ? capsule.accessibilityLabel : undefined}
      onPress={capsule.onPress}
    />
  );
}

function CapsuleRowComponent({ capsules }: CapsuleRowProps) {
  const { brandColors, colorScheme } = useTheme();
  const colors = useMemo(() => filterChipBrandColors(brandColors), [brandColors]);
  return (
    // `colorScheme` keeps the Compose MaterialTheme on our in-app Light/Dark toggle.
    // `matchContents={{ vertical: true }}` (NOT the boolean form) fills the parent
    // width so the Row's `fillMaxWidth()` has a bounded width to scroll within, while
    // height tracks the chip content (mirrors SwitchRow / SegmentedControl).
    <Host matchContents={{ vertical: true }} colorScheme={colorScheme} style={styles.host}>
      <Row
        modifiers={[fillMaxWidth(), horizontalScroll(), padding(spacing[4], spacing[2], spacing[4], spacing[2])]}
        verticalAlignment="center"
        horizontalArrangement={{ spacedBy: spacing[2] }}
      >
        {capsules.map((capsule) => (
          <CapsuleChip key={capsule.key} capsule={capsule} colors={colors} errorColor={brandColors.error} />
        ))}
      </Row>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
    // RN Android installs a background drawable even for a transparent colour, which
    // makes the Host itself an RNGH hit-test target (shouldHandlerlessViewBecomeTouchTarget)
    // if a future refactor reintroduces a box-none ancestor. Zero visual effect.
    backgroundColor: 'transparent',
  },
});

export const CapsuleRow = memo(CapsuleRowComponent);
