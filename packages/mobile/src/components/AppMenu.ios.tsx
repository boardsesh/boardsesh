// AppMenu — iOS implementation, a real native UIMenu via @expo/ui/swift-ui `Menu`.
//
// The text anchor is a neutral Liquid Glass capsule (`buttonStyle('glass')`) whose
// label is the active scope text + a trailing chevron — matching the hand-built
// `clear` glass pill it replaces (neutral, NOT brand-tinted). The icon anchor is a
// bare glyph instead (see `menuModifiers`). Each action is a `Button`; the selected
// row shows a `checkmark` (the native active marker, replacing its scope glyph in the
// single SF Symbol slot), destructive rows take the system destructive role, disabled
// rows take SwiftUI's `.disabled`, and `dividerBefore` draws a SwiftUI `Divider` (a
// UIMenu separator) above its row. SF Symbols come straight from `action.systemIcon`.
//
// The menu popup is always a native UIMenu, so this file is OS-split (iOS), not
// variant-routed — a user who forces the Material variant on iOS still gets it,
// and a `headline` anchor (Material's title-menu) draws as flat title text.

import { Host } from '@expo/ui';
import {
  Menu,
  ContextMenu,
  RNHostView,
  Button,
  ControlGroup,
  Divider,
  HStack,
  VStack,
  Text,
  Image,
} from '@expo/ui/swift-ui';
import {
  buttonStyle,
  clipShape,
  contentShape,
  controlSize,
  backgroundOverlay,
  disabled as disabledModifier,
  frame,
  font,
  foregroundStyle,
  lineLimit,
  shapes,
  truncationMode,
  accessibilityLabel as a11yLabel,
  accessibilityHint as a11yHint,
} from '@expo/ui/swift-ui/modifiers';
import { Fragment, useMemo, type ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';
import { MeasuredMenuAnchor } from './MeasuredMenuAnchor';
import { useTheme } from '../providers/theme-provider';
import { borderRadius, spacing } from '../theme/tokens';
import { topBarByVariant } from '../theme/top-bar';
import { isMenuActionSelectable, paletteRowCount, resolveMenuActions } from './AppMenu.logic';
import type { AppMenuProps } from './AppMenu.types';
import { iconMap } from './icon-map';

// Floor the Host height in RN's layout: the native iOS Host under-reports the glass
// capsule's intrinsic height to React Native, so without a floor the anchor renders
// shorter than the menu button and the pressed glass lens clips. Mirrors the
// SwitchRow caveat. The same 44pt as every top-bar glyph button.
const ANCHOR_MIN_HEIGHT = topBarByVariant.liquidGlass.iconTarget;

// The glyph inside the 44pt circle: the 17pt every top-bar glyph button draws
// (ChromeIconButton), so the overflow "…" matches the close beside it.
const ICON_ANCHOR_GLYPH_SIZE = topBarByVariant.liquidGlass.glyphSize;

export function AppMenu(props: AppMenuProps) {
  const { actions, onSelectIndex, maxWidth, accessibilityLabel, accessibilityHint, style } = props;
  const { systemColors } = useTheme();
  const fillColor = systemColors.fill;
  const resolved = useMemo(() => resolveMenuActions(actions), [actions]);
  const paletteCount = useMemo(() => paletteRowCount(actions), [actions]);
  const iconName = props.iconName;
  const headline = props.iconName == null ? props.headline : undefined;
  const resolvedLabel = accessibilityLabel ?? (headline ? `${headline}, ${props.label}` : undefined);
  const plainIcon = props.iconName != null && props.iconAppearance === 'plain';
  // A glyph anchor in a narrower toolbar slot (UIKit's native bar) takes that
  // slot's frame; everywhere else it keeps the 44pt top-bar target.
  const anchorSize = props.anchorSize ?? ANCHOR_MIN_HEIGHT;

  // Semibold, as iOS 26's own bar glyphs draw. A `font` modifier wins over `size`,
  // so it carries the size too.
  const glyphModifiers = useMemo(
    () => [
      font({ size: ICON_ANCHOR_GLYPH_SIZE, weight: 'semibold' }),
      // Plain menus hit-test their label, so the label must own the full button target.
      frame({ width: anchorSize, height: anchorSize }),
      contentShape(shapes.rectangle()),
    ],
    [anchorSize],
  );

  // The system lifts this trigger as the menu preview. Without an opaque
  // surface, its thumbnail and text float over the dimmed rows underneath.
  const rowPreviewModifiers = useMemo(() => {
    const shape = shapes.roundedRectangle({ cornerRadius: borderRadius.lg, roundedCornerStyle: 'continuous' });
    return [contentShape(shape, 'contextMenuPreview')];
  }, []);

  // Memoised so a re-render with stable inputs doesn't hand the native Menu a fresh
  // modifier array (avoids redundant SwiftUI diffs).
  const menuModifiers = useMemo(
    () =>
      iconName != null
        ? [
            // A glyph anchor deliberately skips `buttonStyle('glass')`: the glass
            // style grows a capsule around its label, which around three dots reads
            // as a stretched pill next to round siblings. Instead it copies the
            // creator header's own buttons — a 44pt `systemFill` circle — so the
            // overflow trigger sits in the same row as the close chevron and the BLE
            // lightbulb without looking like a different control.
            frame({ width: anchorSize, height: anchorSize }),
            ...(!plainIcon ? [backgroundOverlay({ color: fillColor }), clipShape('circle')] : []),
            buttonStyle('plain'),
            ...(accessibilityLabel ? [a11yLabel(accessibilityLabel)] : []),
            ...(accessibilityHint ? [a11yHint(accessibilityHint)] : []),
          ]
        : headline != null
          ? [
              // The Material title-menu (a user who forces Material on iOS): flat
              // text in the app bar, no glass capsule around the title.
              buttonStyle('plain'),
              ...(maxWidth != null ? [frame({ maxWidth, alignment: 'leading' })] : []),
              ...(resolvedLabel ? [a11yLabel(resolvedLabel)] : []),
              ...(accessibilityHint ? [a11yHint(accessibilityHint)] : []),
            ]
          : [
              // Neutral translucent glass capsule (no brand tint) — matches the old
              // `clear` GlassSurface pill. iOS 26 Liquid Glass, degrades gracefully on
              // older iOS.
              buttonStyle('glass'),
              controlSize('large'),
              ...(maxWidth != null ? [frame({ maxWidth })] : []),
              ...(resolvedLabel ? [a11yLabel(resolvedLabel)] : []),
              ...(accessibilityHint ? [a11yHint(accessibilityHint)] : []),
            ],
    [iconName, headline, anchorSize, plainIcon, fillColor, maxWidth, resolvedLabel, accessibilityHint],
  );

  // A long-press anchor stays mounted while its target changes, and an open
  // SwiftUI context menu keeps the items it was drawn with. Keying the items on
  // the target retires those: a stale item belongs to an unmounted Button, so a
  // tap on it runs nothing rather than the new target's row at that index.
  const itemKeyPrefix = props.trigger === 'longPress' && props.menuKey != null ? `${props.menuKey}|` : '';
  const renderButton = (action: (typeof resolved)[number], index: number) => (
    <Button
      key={`${itemKeyPrefix}${index}-${action.label}`}
      label={action.label}
      // `iosSystemImage` is a plain string; the Button's `systemImage` is the
      // SFSymbol literal union. Derive the cast target from Button itself rather
      // than importing `sf-symbols-typescript` (a transitive @expo/ui dep that
      // isn't directly resolvable here).
      systemImage={action.iosSystemImage as ComponentProps<typeof Button>['systemImage']}
      role={action.isDestructive ? 'destructive' : undefined}
      modifiers={action.isDisabled ? [disabledModifier(true)] : undefined}
      onPress={() => {
        if (!isMenuActionSelectable(resolved, index)) return;
        onSelectIndex(index);
      }}
    />
  );

  // Both trigger styles draw the same native actions, including their guarded
  // indices. The custom anchor adds no minimum height, glass, or extra label:
  // the hosted row keeps its existing layout and accessibility nodes.
  const menuItems = (
    <>
      {paletteCount > 0 ? (
        <ControlGroup>
          {resolved.slice(0, paletteCount).map((action, index) => renderButton(action, index))}
        </ControlGroup>
      ) : null}
      {resolved.slice(paletteCount).map((action, offset) => {
        const index = paletteCount + offset;
        return (
          <Fragment key={`${itemKeyPrefix}${index}-${action.label}`}>
            {action.dividerBefore ? <Divider /> : null}
            {renderButton(action, index)}
          </Fragment>
        );
      })}
    </>
  );

  if (props.trigger === 'longPress') {
    // The SwiftUI context menu lifts its trigger, so the row has to live inside
    // the Host. The bridge keeps the width it first measured, so the Host waits
    // for one RN layout pass and then moves the row inside it: one remount per
    // new cell. It is not keyed on the target, so a recycled cell keeps its
    // Host and its row; only a width change (rotation, a fold) remounts again.
    return (
      <MeasuredMenuAnchor style={style}>
        {(width) => {
          if (width === undefined) return props.children;
          const row = (
            <RNHostView matchContents>
              <View
                style={{
                  width,
                  flexDirection: 'row',
                  backgroundColor: props.liftPreview
                    ? (props.previewBackgroundColor ?? systemColors.background)
                    : undefined,
                }}
              >
                {props.liftPreview && props.previewOverlayColor ? (
                  <View
                    pointerEvents="none"
                    style={[StyleSheet.absoluteFill, { backgroundColor: props.previewOverlayColor }]}
                  />
                ) : null}
                {props.children}
              </View>
            </RNHostView>
          );
          return (
            <Host key={width} matchContents={{ vertical: true }} ignoreSafeArea="all" style={{ width }}>
              <ContextMenu>
                <ContextMenu.Trigger>
                  {props.liftPreview ? (
                    <VStack spacing={0} modifiers={rowPreviewModifiers}>
                      {row}
                    </VStack>
                  ) : (
                    row
                  )}
                </ContextMenu.Trigger>
                {/* No items slot with no rows: SwiftUI shows no menu for a
                    hold, and the row stays in the same Host. */}
                {resolved.length > 0 ? <ContextMenu.Items>{menuItems}</ContextMenu.Items> : null}
              </ContextMenu>
            </Host>
          );
        }}
      </MeasuredMenuAnchor>
    );
  }

  // `ignoreSafeArea="all"`: every Host is its own UIHostingController. One that
  // mounts while it is scrolled up under the status bar takes the screen's
  // safe-area inset and keeps it, so once it scrolls back its anchor draws up
  // to a whole button lower than its frame. The player's ⋯ sits in the
  // drawer's scrolling top row and remounts on every climb, and ended up on top
  // of the grade that way. Same fix as Button's `ignoreContainerSafeArea`.
  return (
    <Host
      matchContents
      ignoreSafeArea="all"
      style={[styles.host, props.anchorSize != null && { minHeight: props.anchorSize }, style]}
    >
      <Menu
        modifiers={menuModifiers}
        label={
          props.iconName != null ? (
            <Image
              systemName={iconMap[props.iconName].ios}
              size={ICON_ANCHOR_GLYPH_SIZE}
              color={systemColors.label}
              modifiers={glyphModifiers}
            />
          ) : headline != null ? (
            <VStack spacing={0} alignment="leading">
              <Text
                modifiers={[
                  font({ textStyle: 'title2' }),
                  lineLimit(1),
                  truncationMode('tail'),
                  foregroundStyle(systemColors.label),
                ]}
              >
                {headline}
              </Text>
              <HStack spacing={spacing[1]} alignment="center">
                <Text
                  modifiers={[
                    font({ textStyle: 'subheadline' }),
                    lineLimit(1),
                    truncationMode('tail'),
                    foregroundStyle(systemColors.secondaryLabel),
                  ]}
                >
                  {props.label}
                </Text>
                {props.showCaret !== false ? (
                  <Image systemName="chevron.down" size={11} color={systemColors.secondaryLabel} />
                ) : null}
              </HStack>
            </VStack>
          ) : (
            <HStack spacing={spacing[1]} alignment="center">
              {/* Headline weight + label colour by default — reads like the old pill's
                  bold title; truncates a long scope name within the capped frame. */}
              <Text modifiers={[font({ textStyle: 'headline' }), lineLimit(1), truncationMode('tail')]}>
                {props.label}
              </Text>
              {props.showCaret !== false ? (
                <Image systemName="chevron.down" size={13} color={systemColors.secondaryLabel} />
              ) : null}
            </HStack>
          )
        }
      >
        {menuItems}
      </Menu>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    minHeight: ANCHOR_MIN_HEIGHT,
  },
});
