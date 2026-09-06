// AppMenu — Android implementation, a native Jetpack Compose DropdownMenu via
// @expo/ui/jetpack-compose. Replaces the react-native-paper `Menu` (a JS M3
// re-creation) with the real Compose dropdown — M3 ripple, elevation, open/close
// motion for free. The anchor is a flat `Text` + caret trigger (the M3 app-bar
// title-menu) or a bare glyph trigger in icon mode; the active row shows a leading ✓
// (no SF Symbols on Android), destructive rows take the `m3.error` text colour and
// disabled rows are `enabled={false}`. Controlled `expanded` state, closed on each
// select.

import { useMemo, useState } from 'react';
import { Host } from '@expo/ui';
import { DropdownMenu, DropdownMenuItem, Row, Text } from '@expo/ui/jetpack-compose';
import { clickable, padding } from '@expo/ui/jetpack-compose/modifiers';
import { useTheme } from '../providers/theme-provider';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { anchorGlyphForIcon, isMenuActionSelectable, resolveMenuActions } from './AppMenu.logic';
import type { AppMenuProps } from './AppMenu.types';

// Down-caret glyph: the Compose `Icon` needs a vector-drawable source and @expo/ui
// bundles none for a chevron, so a muted glyph stands in (mirrors MoreForm's `›`).
// The icon anchor's glyph comes from `anchorGlyphForIcon` for the same reason.
const CARET = '▾';

export function AppMenu(props: AppMenuProps) {
  const { actions, onSelectIndex, maxWidth, accessibilityLabel, accessibilityHint, style } = props;
  const { brandColors, m3, systemColors, colorScheme } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const resolved = useMemo(() => resolveMenuActions(actions), [actions]);

  // Every `Text` carries an explicit, scheme-aware colour. The trigger and the menu
  // popup are separate Compose compositions, and a custom `Text` in a slot does NOT
  // inherit the DropdownMenuItem's content colour — so without this the labels fall
  // back to a default that's dark-on-dark when the in-app theme differs from the OS
  // scheme (the bug this fixes). Sourced from `useTheme()`, which is scheme-aware.
  const labelColor = systemColors.label as string;
  const caretColor = systemColors.secondaryLabel as string;
  // Same reason a disabled row needs its own colour here: `disabledTextColor` only
  // reaches the item's default content, not the `Text` we hand to its slot.
  const disabledColor = systemColors.tertiaryLabel as string;

  const showCaret = props.iconName == null && props.showCaret !== false;

  return (
    // `matchContents` (content width AND height): the title-menu hugs its label so it
    // sits leading in the app bar (the find-climbers action is held trailing by a flex
    // spacer). `maxWidth` caps the RN Host (the anchor) only — the `DropdownMenu.Items`
    // popup is a separate Compose overlay that measures independently, so a very long
    // gym name isn't clipped in the open list (symmetric with the iOS Menu, which caps
    // the anchor, not the popup).
    //
    // `colorScheme` forces the Compose MaterialTheme (the menu surface + default
    // content colours) to follow our in-app Light/Dark toggle (`themeOverride`)
    // instead of the OS scheme — same fix MoreForm uses; without it the menu surface
    // and text track the device scheme and clash with the app.
    //
    // Accessibility rides the RN Host boundary: @expo/ui/jetpack-compose has no
    // content-description modifier, and the Host forwards these props to its native
    // view — so the trigger reads as a labelled button to TalkBack, matching the iOS
    // `Menu` a11y modifiers and the old Paper Pressable anchor.
    <Host
      matchContents
      colorScheme={colorScheme}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? props.label}
      accessibilityHint={accessibilityHint}
      style={[maxWidth != null ? { maxWidth } : null, style]}
    >
      <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
        <DropdownMenu.Trigger>
          <Row
            modifiers={[clickable(() => setExpanded(true)), padding(spacing[2], spacing[1], spacing[2], spacing[1])]}
            verticalAlignment="center"
          >
            {props.iconName != null ? (
              <Text style={{ typography: 'titleLarge' }} color={labelColor}>
                {anchorGlyphForIcon(props.iconName)}
              </Text>
            ) : (
              <Text style={{ typography: 'titleMedium' }} color={labelColor} maxLines={1} overflow="ellipsis">
                {props.label}
              </Text>
            )}
            {showCaret ? (
              <Text style={{ typography: 'titleMedium' }} color={caretColor}>
                {` ${CARET}`}
              </Text>
            ) : null}
          </Row>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {resolved.map((action, index) => {
            const itemColor = action.isDisabled
              ? disabledColor
              : action.isDestructive
                ? (m3.error as string)
                : labelColor;
            return (
              <DropdownMenuItem
                // Composite key: scope entries can share a display name (two gyms named
                // the same), so the label alone isn't unique — pair it with the position.
                key={`${index}-${action.label}`}
                enabled={!action.isDisabled}
                elementColors={{ textColor: itemColor, disabledTextColor: disabledColor }}
                onClick={() => {
                  if (!isMenuActionSelectable(resolved, index)) return;
                  setExpanded(false);
                  onSelectIndex(index);
                }}
              >
                {action.showCheck ? (
                  <DropdownMenuItem.LeadingIcon>
                    <Text color={brandAccentColor(brandColors)}>✓</Text>
                  </DropdownMenuItem.LeadingIcon>
                ) : null}
                <DropdownMenuItem.Text>
                  <Text color={itemColor}>{action.label}</Text>
                </DropdownMenuItem.Text>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  );
}
