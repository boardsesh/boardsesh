// AppMenu — web implementation (react-native-web + react-native-paper). A Paper
// `Menu` anchored to a flat text + caret trigger (or a bare glyph trigger in icon
// mode) — the Material counterpart to the Compose `DropdownMenu` in
// AppMenu.android.tsx. The active row shows a leading ✓ (Paper's `check` glyph, no
// SF Symbols on web), destructive rows take the `m3.error` text colour and disabled
// rows use Paper's own `disabled`. Controlled `visible` state, closed on each select.
// The per-platform action resolution (which glyph, when to check) lives in
// AppMenu.logic.ts, shared with the iOS file.
//
// `systemIcon` (an iOS SF Symbol name) is ignored here — it isn't a Material glyph
// name, matching Android, which also drops it.

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Menu } from 'react-native-paper';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { anchorGlyphForIcon, isMenuActionSelectable, resolveMenuActions } from './AppMenu.logic';
import type { AppMenuProps } from './AppMenu.types';

// Down-caret glyph — Paper's Menu anchor is arbitrary content, so a muted glyph
// stands in (mirrors the Compose `▾` in AppMenu.android.tsx). The icon anchor's
// glyph comes from `anchorGlyphForIcon`, which Android shares.
const CARET = '▾';

// Matches the 44pt circle the iOS glyph anchor draws, so the overflow trigger keeps
// its touch target and its round silhouette in the browser build.
const ICON_ANCHOR_SIZE = 44;

export function AppMenu(props: AppMenuProps) {
  const { actions, onSelectIndex, maxWidth, accessibilityLabel, accessibilityHint, style } = props;
  const { m3, systemColors } = useTheme();
  const [visible, setVisible] = useState(false);
  const resolved = useMemo(() => resolveMenuActions(actions), [actions]);

  const labelColor = systemColors.label as string;
  const caretColor = systemColors.secondaryLabel as string;
  // Paper greys a disabled row itself, but `titleStyle` would override that colour,
  // so the disabled tint is picked here rather than left to the theme.
  const disabledColor = systemColors.tertiaryLabel as string;

  const anchor = (
    <Pressable
      onPress={() => setVisible(true)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? props.label}
      accessibilityHint={accessibilityHint}
      style={[
        styles.anchor,
        props.iconName != null ? [styles.iconAnchor, { backgroundColor: systemColors.fill as string }] : null,
        maxWidth != null ? { maxWidth } : null,
        style,
      ]}
    >
      {props.iconName != null ? (
        <Text style={[styles.anchorLabel, { color: labelColor }]}>{anchorGlyphForIcon(props.iconName)}</Text>
      ) : (
        <Text numberOfLines={1} style={[styles.anchorLabel, { color: labelColor }]}>
          {props.label}
        </Text>
      )}
      {props.iconName == null && props.showCaret !== false ? (
        <Text style={[styles.caret, { color: caretColor }]}>{` ${CARET}`}</Text>
      ) : null}
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
          disabled={action.isDisabled}
          titleStyle={{
            color: action.isDisabled ? disabledColor : action.isDestructive ? (m3.error as string) : labelColor,
          }}
          onPress={() => {
            if (!isMenuActionSelectable(resolved, index)) return;
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
  iconAnchor: {
    width: ICON_ANCHOR_SIZE,
    height: ICON_ANCHOR_SIZE,
    borderRadius: ICON_ANCHOR_SIZE / 2,
    justifyContent: 'center',
    paddingHorizontal: 0,
    paddingVertical: 0,
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
