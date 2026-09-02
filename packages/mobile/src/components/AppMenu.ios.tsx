// AppMenu — iOS implementation, a real native UIMenu via @expo/ui/swift-ui `Menu`.
//
// The anchor is a neutral Liquid Glass capsule (`buttonStyle('glass')`) whose label
// is the active scope text + a trailing chevron — matching the hand-built `clear`
// glass pill it replaces (neutral, NOT brand-tinted). Each action is a `Button`; the
// selected row shows a `checkmark` (the native active marker, replacing its scope
// glyph in the single SF Symbol slot), destructive rows take the system destructive
// role. SF Symbols come straight from `action.systemIcon`.
//
// The menu popup is always a native UIMenu, so this file is OS-split (iOS), not
// variant-routed — a user who forces the Material variant on iOS still gets it.

import { Menu, Button, HStack, Text, Image } from '@expo/ui/swift-ui';
import {
  buttonStyle,
  controlSize,
  frame,
  font,
  lineLimit,
  truncationMode,
  accessibilityLabel as a11yLabel,
  accessibilityHint as a11yHint,
} from '@expo/ui/swift-ui/modifiers';
import { useMemo, type ComponentProps } from 'react';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { ThemedHost } from './ThemedHost';
import { spacing } from '../theme/tokens';
import { resolveMenuActions } from './AppMenu.logic';
import type { AppMenuProps } from './AppMenu.types';

// Floor the Host height in RN's layout: the native iOS Host under-reports the glass
// capsule's intrinsic height to React Native, so without a floor the anchor renders
// shorter than the menu button and the pressed glass lens clips. Mirrors the
// SwitchRow caveat; ~44pt ≈ the old pill's `glassSize.capsule`.
const ANCHOR_MIN_HEIGHT = 44;

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
  const { systemColors } = useTheme();
  const resolved = useMemo(() => resolveMenuActions(actions), [actions]);

  // Memoised so a re-render with stable inputs doesn't hand the native Menu a fresh
  // modifier array (avoids redundant SwiftUI diffs).
  const menuModifiers = useMemo(
    () => [
      // Neutral translucent glass capsule (no brand tint) — matches the old `clear`
      // GlassSurface pill. iOS 26 Liquid Glass, degrades gracefully on older iOS.
      buttonStyle('glass'),
      controlSize('large'),
      ...(maxWidth != null ? [frame({ maxWidth })] : []),
      ...(accessibilityLabel ? [a11yLabel(accessibilityLabel)] : []),
      ...(accessibilityHint ? [a11yHint(accessibilityHint)] : []),
    ],
    [maxWidth, accessibilityLabel, accessibilityHint],
  );

  return (
    <ThemedHost matchContents style={[styles.host, style]}>
      <Menu
        modifiers={menuModifiers}
        label={
          <HStack spacing={spacing[1]} alignment="center">
            {/* Headline weight + label colour by default — reads like the old pill's
                bold title; truncates a long scope name within the capped frame. */}
            <Text modifiers={[font({ textStyle: 'headline' }), lineLimit(1), truncationMode('tail')]}>{label}</Text>
            {showCaret ? <Image systemName="chevron.down" size={13} color={systemColors.secondaryLabel} /> : null}
          </HStack>
        }
      >
        {resolved.map((action, index) => (
          <Button
            // Composite key: scope entries can share a display name (two gyms named
            // the same), so the label alone isn't unique — pair it with the position.
            key={`${index}-${action.label}`}
            label={action.label}
            // `iosSystemImage` is a plain string; the Button's `systemImage` is the
            // SFSymbol literal union. Derive the cast target from Button itself rather
            // than importing `sf-symbols-typescript` (a transitive @expo/ui dep that
            // isn't directly resolvable here).
            systemImage={action.iosSystemImage as ComponentProps<typeof Button>['systemImage']}
            role={action.isDestructive ? 'destructive' : undefined}
            onPress={() => onSelectIndex(index)}
          />
        ))}
      </Menu>
    </ThemedHost>
  );
}

const styles = StyleSheet.create({
  host: {
    minHeight: ANCHOR_MIN_HEIGHT,
  },
});
