// AppMenu — Android implementation, a native Jetpack Compose DropdownMenu via
// @expo/ui/jetpack-compose. Replaces the react-native-paper `Menu` (a JS M3
// re-creation) with the real Compose dropdown — M3 ripple, elevation, open/close
// motion for free. The anchor is a flat `Text` + caret trigger (the M3 app-bar
// title-menu) or, in icon mode, an M3 IconButton (a 24dp more_vert in a 48dp
// target) for the overflow family and a bare glyph for the rest; the active row shows a leading ✓
// (no SF Symbols on Android), destructive rows take the `m3.error` text colour,
// disabled rows are `enabled={false}` and `dividerBefore` draws an M3
// `HorizontalDivider` above its row. Controlled `expanded` state, closed on each
// select.

import { Fragment, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ComposeHost } from './ComposeHost.android';
import {
  Box,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  HorizontalDivider,
  Icon,
  IconButton,
  Row,
  Text,
} from '@expo/ui/jetpack-compose';
import { clickable, defaultMinSize, fillMaxSize, padding, selectable } from '@expo/ui/jetpack-compose/modifiers';
import { useTheme } from '../providers/theme-provider';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { topBarByVariant } from '../theme/top-bar';
import { anchorGlyphForIcon, isMenuActionSelectable, isOverflowAnchor, resolveMenuActions } from './AppMenu.logic';
import type { AppMenuProps } from './AppMenu.types';
import { MORE_VERT_ICON } from './AppMenu.icons.android';

// Down-caret glyph: the Compose `Icon` needs a vector-drawable source and @expo/ui
// bundles none for a chevron, so a muted glyph stands in (mirrors MoreForm's `›`).
// The icon anchor's glyph comes from `anchorGlyphForIcon` for the same reason.
const CARET = '▾';

export function AppMenu(props: AppMenuProps) {
  const { actions, onSelectIndex, maxWidth, accessibilityLabel, accessibilityHint, style } = props;
  const { brandColors, m3, systemColors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  // A long-press menu mounts its Compose host on the first hold and keeps it:
  // a row that is never held costs no host at all.
  const [hostMounted, setHostMounted] = useState(false);
  const resolved = useMemo(() => resolveMenuActions(actions), [actions]);
  const open = () => {
    setHostMounted(true);
    setExpanded(true);
  };
  const longPressMenuKey = props.trigger === 'longPress' ? props.menuKey : undefined;
  const hasRows = resolved.length > 0;
  useImperativeHandle(
    props.trigger === 'longPress' ? props.menuRef : undefined,
    () => ({
      open: () => {
        if (!hasRows) return;
        setHostMounted(true);
        setExpanded(true);
      },
    }),
    [hasRows],
  );
  // The rows now act on something else (a recycled cell, a crew edit): close the
  // open menu rather than let a tap land on a row drawn for the old target.
  useEffect(() => {
    setExpanded(false);
  }, [longPressMenuKey]);

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
  const headline = props.iconName == null ? props.headline : undefined;
  // A text anchor over a ticked choice is a value picker (a settings row, the
  // board sheet's Keep lighting): TalkBack says "drop-down list" for it, as it
  // does for a Spinner. An action menu ("Review") stays a button.
  const isValuePicker = props.iconName == null && headline == null && resolved.some((action) => action.showCheck);

  const menuItems = (
    <DropdownMenu.Items>
      {resolved.map((action, index) => {
        const itemColor = action.isDisabled ? disabledColor : action.isDestructive ? (m3.error as string) : labelColor;
        // One pick per tap: the ticked row's `selectable` and its own click
        // run the same pick, and a tap that reaches both reports it once.
        let picked = false;
        const pick = () => {
          if (picked || !isMenuActionSelectable(resolved, index)) return;
          picked = true;
          setExpanded(false);
          onSelectIndex(index);
        };
        return (
          // Composite key: scope entries can share a display name (two gyms named
          // the same), so the label alone isn't unique — pair it with the position.
          <Fragment key={`${index}-${action.label}`}>
            {/* An M3 menu group divider. Not an item, so it takes no index. */}
            {action.dividerBefore ? <HorizontalDivider /> : null}
            <DropdownMenuItem
              enabled={!action.isDisabled}
              elementColors={{ textColor: itemColor, disabledTextColor: disabledColor }}
              modifiers={action.showCheck ? [selectable(true, pick)] : undefined}
              onClick={pick}
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
          </Fragment>
        );
      })}
    </DropdownMenu.Items>
  );

  const renderMenu = () => (
    // `matchContents` (content width AND height): the title-menu hugs its label so it
    // sits leading in the app bar (the find-climbers action is held trailing by a flex
    // spacer). `maxWidth` caps the RN Host (the anchor) only — the `DropdownMenu.Items`
    // popup is a separate Compose overlay that measures independently, so a very long
    // gym name isn't clipped in the open list (symmetric with the iOS Menu, which caps
    // the anchor, not the popup).
    //
    // The anchor's name and role ride the RN Host boundary: the Host forwards
    // these props to its native view, so the trigger reads as a labelled button
    // (a drop-down list for a value picker) to TalkBack, matching the iOS `Menu`
    // a11y modifiers. The open menu's rows are Compose nodes: the ticked one
    // carries `selectable`, so TalkBack says "Selected" as well as the ✓.
    <ComposeHost
      matchContents
      accessibilityRole={isValuePicker ? 'dropdownlist' : 'button'}
      accessibilityLabel={accessibilityLabel ?? (headline ? `${headline}, ${props.label}` : props.label)}
      accessibilityHint={accessibilityHint}
      style={[maxWidth != null ? { maxWidth } : null, style]}
    >
      <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
        <DropdownMenu.Trigger>
          {props.iconName != null && isOverflowAnchor(props.iconName) ? (
            // The M3 overflow button: an IconButton (a 48dp touch target) holding
            // the 24dp more_vert icon in onSurfaceVariant, not a "⋯" set in
            // titleLarge text. Its spoken name rides the Host's label above.
            // `anchorSize` is not read: M3 keeps the 48dp target.
            <IconButton onClick={open}>
              <Icon source={MORE_VERT_ICON} size={topBarByVariant.material.glyphSize} tint={caretColor} />
            </IconButton>
          ) : headline != null ? (
            // The M3 title-menu: titleLarge headline over a bodyMedium scope line,
            // one click target. No start padding, so the headline lands on the same
            // 56dp title inset as `MaterialAppBarTitle` on the other tabs.
            <Column modifiers={[clickable(open), padding(0, spacing[2], spacing[2], spacing[2])]}>
              <Text style={{ typography: 'titleLarge' }} color={labelColor} maxLines={1} overflow="ellipsis">
                {headline}
              </Text>
              <Row verticalAlignment="center">
                <Text style={{ typography: 'bodyMedium' }} color={caretColor} maxLines={1} overflow="ellipsis">
                  {props.label}
                </Text>
                {showCaret ? (
                  <Text style={{ typography: 'bodyMedium' }} color={caretColor}>
                    {` ${CARET}`}
                  </Text>
                ) : null}
              </Row>
            </Column>
          ) : (
            <Row
              modifiers={[
                clickable(open),
                // A text anchor (a settings value, the board sheet's Keep
                // lighting) is a control in its own right: Material's 48dp
                // minimum touch height. The bare glyph keeps its own size.
                ...(props.iconName == null ? [defaultMinSize({ minHeight: 48 })] : []),
                padding(spacing[2], spacing[1], spacing[2], spacing[1]),
              ]}
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
          )}
        </DropdownMenu.Trigger>
        {menuItems}
      </DropdownMenu>
    </ComposeHost>
  );
  if (props.trigger === 'longPress') {
    // The row stays a plain React Native view, never hosted inside Compose:
    // Compose RNHostView content reports its height but can draw blank
    // (#6500, #6585, #6546), and the row's own taps, swipes and TalkBack focus
    // keep their usual RN path. The dropdown hangs off an invisible strip along
    // the row's bottom edge, so it opens under the row as an anchored menu does.
    return (
      <View style={[styles.longPressAnchor, maxWidth != null ? { maxWidth } : null, style]}>
        <Pressable
          style={styles.longPressBody}
          onLongPress={resolved.length > 0 ? open : undefined}
          delayLongPress={400}
          accessible={false}
          focusable={false}
          android_disableSound
        >
          {props.children}
        </Pressable>
        {hostMounted ? (
          <ComposeHost
            pointerEvents="none"
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            style={styles.longPressMenuStrip}
          >
            <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
              <DropdownMenu.Trigger>
                <Box modifiers={[fillMaxSize()]} />
              </DropdownMenu.Trigger>
              {menuItems}
            </DropdownMenu>
          </ComposeHost>
        ) : null}
      </View>
    );
  }
  return renderMenu();
}

const styles = StyleSheet.create({
  longPressAnchor: { minWidth: 0 },
  longPressBody: { width: '100%', flexDirection: 'row' },
  longPressMenuStrip: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 1 },
});
