// AppMenu — web implementation (react-native-web + react-native-paper). A Paper
// `Menu` anchored to a flat text + caret trigger — the Material counterpart to the
// Compose `DropdownMenu` in AppMenu.android.tsx. The active row shows a leading ✓
// (Paper's `check` glyph, no SF Symbols on web) and destructive rows take the
// `m3.error` text colour. Controlled `visible` state, closed on each select. The
// per-platform action resolution (which glyph, when to check) lives in
// AppMenu.logic.ts, shared with the iOS file.
//
// `systemIcon` (an iOS SF Symbol name) is ignored here — it isn't a Material glyph
// name, matching Android, which also drops it.

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Menu } from 'react-native-paper';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { resolveMenuActions } from './AppMenu.logic';
import type { AppMenuProps } from './AppMenu.types';

// Down-caret glyph — Paper's Menu anchor is arbitrary content, so a muted glyph
// stands in (mirrors the Compose `▾` in AppMenu.android.tsx).
const CARET = '▾';

export function AppMenu({
  label,
  actions,
  onSelectIndex,
  showCaret = true,
  maxWidth,
  accessibilityLabel,
  accessibilityHint,
  style,
}: AppMenuProps) {
  const { m3, systemColors } = useTheme();
  const [visible, setVisible] = useState(false);
  const resolved = useMemo(() => resolveMenuActions(actions), [actions]);

  const labelColor = systemColors.label as string;
  const caretColor = systemColors.secondaryLabel as string;

  const anchor = (
    <Pressable
      onPress={() => setVisible(true)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      style={[styles.anchor, maxWidth != null ? { maxWidth } : null, style]}
    >
      <Text numberOfLines={1} style={[styles.anchorLabel, { color: labelColor }]}>
        {label}
      </Text>
      {showCaret ? <Text style={[styles.caret, { color: caretColor }]}>{` ${CARET}`}</Text> : null}
    </Pressable>
  );

  return (
    <Menu visible={visible} onDismiss={() => setVisible(false)} anchor={anchor}>
      {resolved.map((action, index) => (
        <Menu.Item
          // Composite key: scope entries can share a display name (two gyms named
          // the same), so the label alone isn't unique — pair it with the position.
          key={`${index}-${action.label}`}
          title={action.label}
          leadingIcon={action.showCheck ? 'check' : undefined}
          titleStyle={{ color: action.isDestructive ? (m3.error as string) : labelColor }}
          onPress={() => {
            setVisible(false);
            onSelectIndex(index);
          }}
        />
      ))}
    </Menu>
  );
}

const styles = StyleSheet.create({
  anchor: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[1],
    paddingVertical: spacing[2],
  },
  anchorLabel: {
    fontSize: 17,
    fontWeight: '600',
    flexShrink: 1,
  },
  caret: {
    fontSize: 17,
    fontWeight: '600',
  },
});
