// CapsuleRow, web (react-native-web + react-native-paper): a horizontally
// scrolling row of Paper Material 3 Chips + Menus, the Material counterpart to
// the Compose chips in CapsuleRow.android.tsx, which it mirrors capsule for
// capsule. `toggleMenu` draws a plain toggle chip here too (no long-press menu),
// and the rail has no chevron. Active chips take the brand fill with on-fill
// text (CapsuleChips.web.tsx).

import { memo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Divider, Menu } from 'react-native-paper';
import { spacing } from '../../theme/tokens';
import { CapsuleChip, CapsuleMenuChip } from './CapsuleChips.web';
import { isCapsuleActive } from './CapsuleRow.logic';
import type { Capsule, CapsuleIcon, CapsuleRowProps, MenuCapsule } from './CapsuleRow.types';

// Semantic capsule icon → Paper (MaterialCommunityIcons) icon name. No lock
// glyphs: the Tall / Wide lock is iOS-only, so the web never draws one.
const PAPER_ICON: Partial<Record<CapsuleIcon, string>> = {
  filters: 'tune',
  recent: 'history',
};

function paperIconFor(icon: CapsuleIcon | undefined): string | undefined {
  return icon ? PAPER_ICON[icon] : undefined;
}

function MenuCapsuleChip({ capsule }: { capsule: MenuCapsule }) {
  const { options, selected, onSelect, actions } = capsule;
  return (
    <CapsuleMenuChip label={capsule.label} selected={capsule.active} icon={paperIconFor(capsule.icon)}>
      {(close) => (
        <>
          {options.map((option) => (
            <Menu.Item
              key={option.value}
              title={option.label}
              leadingIcon={option.value === selected ? 'check' : undefined}
              onPress={() => {
                onSelect(option.value);
                close();
              }}
            />
          ))}
          {actions && actions.length > 0 ? (
            <>
              <Divider />
              {actions.map((action) => (
                <Menu.Item
                  key={action.key}
                  title={action.label}
                  leadingIcon={paperIconFor(action.icon)}
                  onPress={() => {
                    action.onPress();
                    close();
                  }}
                />
              ))}
            </>
          ) : null}
        </>
      )}
    </CapsuleMenuChip>
  );
}

function CapsuleRowChip({ capsule }: { capsule: Capsule }) {
  if (capsule.kind === 'menu') return <MenuCapsuleChip capsule={capsule} />;
  return (
    <CapsuleChip
      label={capsule.label}
      selected={isCapsuleActive(capsule)}
      icon={capsule.kind === 'sheet' || capsule.kind === 'toggleMenu' ? paperIconFor(capsule.icon) : undefined}
      accessibilityLabel={capsule.kind === 'sheet' ? capsule.accessibilityLabel : undefined}
      onPress={capsule.onPress}
    />
  );
}

function CapsuleRowComponent({ capsules }: CapsuleRowProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
    >
      {capsules.map((capsule) => (
        <CapsuleRowChip key={capsule.key} capsule={capsule} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
});

export const CapsuleRow = memo(CapsuleRowComponent);
