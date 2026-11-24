import { Text } from './Text';
import { useTypographyStyles, type TypographyScale } from '../hooks/use-typography-styles';
import { PressableSurface } from './PressableSurface';
// AppMenu — web implementation (react-native-web + react-native-paper). A Paper
// `Menu` anchored to a flat text + caret trigger (or a bare glyph trigger in icon
// mode) — the Material counterpart to the Compose `DropdownMenu` in
// AppMenu.android.tsx. The active row shows a leading ✓ (Paper's `check` glyph, no
// SF Symbols on web), destructive rows take the `m3.error` text colour, disabled
// rows use Paper's own `disabled` and `dividerBefore` draws a Paper `Divider`. Controlled `visible` state, closed on each select.
// The per-platform action resolution (which glyph, when to check) lives in
// AppMenu.logic.ts, shared with the iOS file.
//
// `systemIcon` (an iOS SF Symbol name) is ignored here — it isn't a Material glyph
// name, matching Android, which also drops it.

import {
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type PointerEvent, type ViewInstance } from 'react-native';
import { Divider, Menu } from 'react-native-paper';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { anchorGlyphForIcon, isMenuActionSelectable, resolveMenuActions } from './AppMenu.logic';
import type { AppMenuProps } from './AppMenu.types';
import type { WindowAnchorPoint } from './navigation/AnchoredPopover.types';

// Down-caret glyph — Paper's Menu anchor is arbitrary content, so a muted glyph
// stands in (mirrors the Compose `▾` in AppMenu.android.tsx). The icon anchor's
// glyph comes from `anchorGlyphForIcon`, which Android shares.
const CARET = '▾';

// Matches the 44pt circle the iOS glyph anchor draws, so the overflow trigger keeps
// its touch target and its round silhouette in the browser build. A caller in a
// narrower toolbar slot passes `anchorSize`, as on iOS.
const ICON_ANCHOR_SIZE = 44;
const MENU_SCREEN_INSET = 8;

const longPressStyles = StyleSheet.create({
  host: { minWidth: 0 },
  anchor: { flex: 1, minWidth: 0 },
  popup: { position: 'absolute', top: 0, left: 0 },
});

function LongPressMenuAnchor({
  children,
  enabled,
  onOpen,
  anchorRef,
}: {
  children: ReactElement;
  enabled: boolean;
  onOpen: (anchor?: WindowAnchorPoint) => void;
  anchorRef: RefObject<ViewInstance | null>;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const consumedHoldRef = useRef(false);
  const cancelLongPress = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pointerStartRef.current = null;
  }, []);
  useEffect(() => cancelLongPress, [cancelLongPress]);

  const startLongPress = (event: PointerEvent) => {
    cancelLongPress();
    consumedHoldRef.current = false;
    if (!enabled || event.nativeEvent.button !== 0) return;
    const pointer = { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY };
    pointerStartRef.current = pointer;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pointerStartRef.current = null;
      consumedHoldRef.current = true;
      onOpen(pointer);
    }, 400);
  };
  const movePointer = (event: PointerEvent) => {
    const start = pointerStartRef.current;
    if (start && Math.hypot(event.nativeEvent.clientX - start.x, event.nativeEvent.clientY - start.y) > 15) {
      cancelLongPress();
    }
  };
  // React Native Web forwards this DOM handler, although the native View type
  // intentionally omits the browser-only contextmenu event.
  const browserHandlers = {
    onContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      if (!enabled) return;
      event.preventDefault();
      cancelLongPress();
      consumedHoldRef.current = true;
      // Keyboard context-menu events have no pointer location. Measure the
      // row for those; pointer menus use viewport coordinates, even after scroll.
      onOpen(event.clientX === 0 && event.clientY === 0 ? undefined : { x: event.clientX, y: event.clientY });
    },
    onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      if (!consumedHoldRef.current) return;
      consumedHoldRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  return (
    <View
      {...browserHandlers}
      ref={anchorRef}
      style={longPressStyles.anchor}
      accessible={false}
      onPointerDown={startLongPress}
      onPointerMove={movePointer}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
    >
      {children}
    </View>
  );
}

export function AppMenu(props: AppMenuProps) {
  const styles = useTypographyStyles(createStyles);
  const { actions, onSelectIndex, maxWidth, accessibilityLabel, accessibilityHint, style } = props;
  const { m3, systemColors } = useTheme();
  const [visible, setVisible] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<WindowAnchorPoint>({ x: 0, y: 0 });
  const [menuWidth, setMenuWidth] = useState(0);
  const [menuEpoch, setMenuEpoch] = useState(0);
  const anchorRef = useRef<ViewInstance | null>(null);
  const openingFocusRef = useRef<HTMLElement | null>(null);
  const openRequestRef = useRef(0);
  const resolved = useMemo(() => resolveMenuActions(actions), [actions]);
  const longPressMenuKey = props.trigger === 'longPress' ? props.menuKey : undefined;
  const hasRows = resolved.length > 0;
  const currentMenuRef = useRef({ key: longPressMenuKey, hasRows });
  currentMenuRef.current = { key: longPressMenuKey, hasRows };
  const openedMenuRef = useRef<{ key: string | undefined; anchor: WindowAnchorPoint } | null>(null);
  const openMenu = useCallback(
    (point?: WindowAnchorPoint) => {
      if (!hasRows) return;
      const request = ++openRequestRef.current;
      const menuKey = currentMenuRef.current.key;
      const focusedElement = typeof document === 'undefined' ? null : document.activeElement;
      const showMenu = (anchor: WindowAnchorPoint) => {
        if (
          request !== openRequestRef.current ||
          menuKey !== currentMenuRef.current.key ||
          !currentMenuRef.current.hasRows
        )
          return;
        const openedMenu = openedMenuRef.current;
        if (
          openedMenu &&
          openedMenu.key === menuKey &&
          openedMenu.anchor.x === anchor.x &&
          openedMenu.anchor.y === anchor.y
        )
          return;
        openedMenuRef.current = { key: menuKey, anchor };
        openingFocusRef.current = focusedElement instanceof HTMLElement ? focusedElement : null;
        // Only the detached popup resets. Paper otherwise retains its scale
        // across opens, which can stretch a narrower menu outside the viewport.
        setMenuEpoch((epoch) => epoch + 1);
        setMenuWidth(0);
        setMenuAnchor(anchor);
        setVisible(true);
      };
      if (point) showMenu(point);
      else anchorRef.current?.measureInWindow((left, top, _width, height) => showMenu({ x: left, y: top + height }));
    },
    [hasRows],
  );
  const closeMenu = useCallback(() => {
    openRequestRef.current++;
    openedMenuRef.current = null;
    setVisible(false);
    if (openingFocusRef.current?.isConnected) openingFocusRef.current.focus({ preventScroll: true });
    openingFocusRef.current = null;
  }, []);
  const onMenuLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (props.trigger === 'longPress') setMenuWidth(event.nativeEvent.layout.width);
      props.onPresented?.();
    },
    [props.trigger, props.onPresented],
  );
  useImperativeHandle(
    props.trigger === 'longPress' ? props.menuRef : undefined,
    () => ({
      open: openMenu,
    }),
    [openMenu],
  );
  // The rows now act on something else: close the open menu rather than let a
  // click land on a row drawn for the old target.
  useEffect(() => {
    openRequestRef.current++;
    openedMenuRef.current = null;
    openingFocusRef.current = null;
    setVisible(false);
  }, [longPressMenuKey]);
  useEffect(
    () => () => {
      openRequestRef.current++;
    },
    [],
  );

  const labelColor = systemColors.label as string;
  const caretColor = systemColors.secondaryLabel as string;
  // Paper greys a disabled row itself, but `titleStyle` would override that colour,
  // so the disabled tint is picked here rather than left to the theme.
  const disabledColor = systemColors.tertiaryLabel as string;
  const headline = props.iconName == null ? props.headline : undefined;

  const anchor =
    props.trigger === 'longPress' ? (
      <LongPressMenuAnchor enabled={hasRows} onOpen={openMenu} anchorRef={anchorRef}>
        {props.children}
      </LongPressMenuAnchor>
    ) : (
      <PressableSurface
        onPress={() => setVisible(true)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? (headline ? `${headline}, ${props.label}` : props.label)}
        accessibilityHint={accessibilityHint}
        style={[
          styles.anchor,
          props.iconName != null
            ? [
                styles.iconAnchor,
                props.anchorSize != null
                  ? { width: props.anchorSize, height: props.anchorSize, borderRadius: props.anchorSize / 2 }
                  : null,
                props.iconAppearance !== 'plain' ? { backgroundColor: systemColors.fill as string } : null,
              ]
            : null,
          headline != null ? styles.headlineAnchor : null,
          maxWidth != null ? { maxWidth } : null,
          style,
        ]}
      >
        {headline != null ? (
          // The Material title-menu: the app bar's title over the active scope.
          <>
            <Text numberOfLines={1} variant="title2" color={labelColor}>
              {headline}
            </Text>
            <Text numberOfLines={1} variant="subheadline" color={caretColor}>
              {props.label}
              {props.showCaret !== false ? ` ${CARET}` : ''}
            </Text>
          </>
        ) : props.iconName != null ? (
          <Text emphasized style={[styles.anchorLabel, { color: labelColor }]}>
            {anchorGlyphForIcon(props.iconName)}
          </Text>
        ) : (
          <Text emphasized numberOfLines={1} style={[styles.anchorLabel, { color: labelColor }]}>
            {props.label}
          </Text>
        )}
        {props.iconName == null && headline == null && props.showCaret !== false ? (
          <Text emphasized style={[styles.caret, { color: caretColor }]}>{` ${CARET}`}</Text>
        ) : null}
      </PressableSurface>
    );

  // React Native Web supports dataSet; the native View type omits it.
  const menuBrowserProps = { dataSet: visible ? { boardseshPlayerShortcutBlock: 'true' } : undefined };
  const viewportWidth =
    typeof window === 'undefined' ? 0 : window.document.documentElement.clientWidth || window.innerWidth;
  // Paper flips a coordinate menu left when it cannot fit on the right, but
  // does not clamp that branch's left edge. A wide menu near a phone's centre
  // can otherwise hide actions outside the viewport.
  const menuLeft =
    props.trigger === 'longPress' && menuWidth > 0
      ? Math.max(
          MENU_SCREEN_INSET,
          Math.min(
            viewportWidth - menuWidth - MENU_SCREEN_INSET,
            menuAnchor.x + menuWidth <= viewportWidth - MENU_SCREEN_INSET ? menuAnchor.x : menuAnchor.x - menuWidth,
          ),
        )
      : undefined;

  const menu = (
    <Menu
      key={props.trigger === 'longPress' ? menuEpoch : undefined}
      visible={visible}
      onDismiss={closeMenu}
      anchor={props.trigger === 'longPress' ? menuAnchor : anchor}
      style={menuLeft === undefined ? undefined : { left: menuLeft }}
    >
      <View onLayout={visible ? onMenuLayout : undefined} {...menuBrowserProps}>
        {resolved.map((action, index) => (
          // Composite key: scope entries can share a display name (two gyms named
          // the same), so the label alone isn't unique — pair it with the position.
          <Fragment key={`${index}-${action.label}`}>
            {/* A menu group divider. Not an item, so it takes no index. */}
            {action.dividerBefore ? <Divider /> : null}
            <Menu.Item
              title={action.label}
              leadingIcon={action.showCheck ? 'check' : undefined}
              disabled={action.isDisabled}
              titleStyle={{
                color: action.isDisabled ? disabledColor : action.isDestructive ? (m3.error as string) : labelColor,
              }}
              onPress={() => {
                if (!isMenuActionSelectable(resolved, index)) return;
                closeMenu();
                onSelectIndex(index);
              }}
            />
          </Fragment>
        ))}
      </View>
    </Menu>
  );

  // Keep the row mounted independently of Paper's coordinate anchor. Its empty
  // holder is out of flow, so opening a menu cannot change the row's flex width.
  if (props.trigger === 'longPress') {
    return (
      <View style={[longPressStyles.host, maxWidth != null ? { maxWidth } : null, style]}>
        {anchor}
        <View style={longPressStyles.popup} pointerEvents="box-none">
          {menu}
        </View>
      </View>
    );
  }

  return menu;
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
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
    // Headline over the scope line, flush with the 56dp title inset the other
    // tabs' `MaterialAppBarTitle` uses.
    headlineAnchor: {
      flexDirection: 'column',
      alignItems: 'flex-start',
      paddingHorizontal: 0,
      paddingRight: spacing[1],
    },
    anchorLabel: {
      fontSize: textStyles.body.fontSize,
      flexShrink: 1,
    },
    caret: {
      fontSize: textStyles.body.fontSize,
    },
  });
