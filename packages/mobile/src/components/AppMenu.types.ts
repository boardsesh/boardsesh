import type { ReactElement, RefObject } from 'react';
import type { ColorValue, StyleProp, ViewStyle } from 'react-native';
import type { IconName } from './icon-map';

/** A single menu row, neutral across the native iOS `Menu` / Android `DropdownMenu` impls. */
export type AppMenuAction = {
  label: string;
  /** Marks the active row — a `checkmark` on iOS, a leading ✓ on Android. */
  selected?: boolean;
  /** Tints the row as destructive — the system destructive role on iOS, `m3.error` text on Android. */
  destructive?: boolean;
  /**
   * Greys the row out and blocks selection. A disabled row still occupies its slot:
   * it stays visible (so the menu explains what's unavailable rather than hiding it)
   * and, critically, keeps its position — `onSelectIndex` is an index into `actions`,
   * so dropping a row would silently shift every action after it.
   */
  disabled?: boolean;
  /**
   * SF Symbol name shown on the native iOS dropdown row (e.g. `person.2.fill`).
   * iOS-only: the Android Compose menu has no SF Symbols, so it's ignored there.
   */
  systemIcon?: string;
  /**
   * Draws a separator above this row, opening a new group. A divider is not an
   * action: it takes no index, so `onSelectIndex` still counts rows only. Ignored
   * on the first row, where there is nothing above it to separate from.
   */
  dividerBefore?: boolean;
  /**
   * iOS only: up to 3 consecutive leading `palette` rows draw as one icon-over-label
   * row (a SwiftUI `ControlGroup`, UIKit's "medium" element size), as Music's ⋯ does
   * for Download / Favourite / Share. Needs 2 or more such rows at the very top; a
   * lone one, or one after a plain row, is drawn as a normal row. It never changes
   * `onSelectIndex`: indices still count rows in `actions` order. Android and web
   * draw a normal row.
   */
  palette?: true;
};

type AppMenuSharedProps = {
  actions: AppMenuAction[];
  /** Called with the index of the tapped action, matching `actions` order. Never fires for a disabled row. */
  onSelectIndex: (index: number) => void;
  /** Caps the anchor's width (iOS: SwiftUI `frame`; Android: best-effort RN clip). */
  maxWidth?: number;
  accessibilityHint?: string;
  /** Positions the menu's `Host` in its parent; not the menu popup. */
  style?: StyleProp<ViewStyle>;
};

/** Text anchor: the active scope's name, with an optional trailing caret. */
type AppMenuTextAnchorProps = AppMenuSharedProps & {
  /** The anchor button's text (the active scope). The native trigger renders this — there's no RN `children` anchor anymore. */
  label: string;
  iconName?: never;
  /** Falls back to `label` — the anchor already reads its scope aloud. */
  accessibilityLabel?: string;
  /** Trailing down-caret on the anchor. Default `true`. */
  showCaret?: boolean;
  /**
   * Material title-menu: a headline drawn above `label`, so the anchor is the
   * app bar's title ("Home") with the active scope under it and the whole block
   * opens the menu. Read aloud as "Home, My crew" unless `accessibilityLabel` is set.
   */
  headline?: string;
  anchorSize?: never;
  children?: never;
  trigger?: never;
};

/** Icon anchor: a bare glyph trigger (the "⋯" overflow button), with no visible text. */
type AppMenuIconAnchorProps = AppMenuSharedProps & {
  label?: never;
  iconName: IconName;
  /** Shared toolbar supplies the surface; retain the full icon touch target. */
  iconAppearance?: 'filled' | 'plain';
  /** Required here: a glyph-only anchor has no visible text for a screen reader to fall back on. */
  accessibilityLabel: string;
  /** A glyph anchor never carries a caret — the glyph itself is the affordance. */
  showCaret?: never;
  headline?: never;
  /**
   * Side of the glyph anchor's square frame, for a menu in a toolbar slot that is
   * not 44pt (UIKit's narrower native bar slot). iOS and web; Android's M3
   * IconButton keeps its 48dp target. The glyph keeps its size.
   */
  anchorSize?: number;
  children?: never;
  trigger?: never;
};

/** Opens a long-press menu from a separate control, such as a row's ⋮ button. */
export type AppMenuHandle = {
  /** Android and web open the menu under the row. A SwiftUI context menu only
   *  opens from its hold, so on iOS this does nothing. */
  open: () => void;
};

/** A row body keeps its own tap/accessibility behavior while a hold opens its menu. */
type AppMenuLongPressAnchorProps = AppMenuSharedProps & {
  children: ReactElement;
  trigger: 'longPress';
  menuRef?: RefObject<AppMenuHandle | null>;
  /**
   * What the actions act on (climb, board, slot, row set). The anchor and its
   * children stay mounted when it changes, so a recycled list cell keeps its
   * row; only the drawn menu is retired: Android and web close an open menu,
   * and iOS re-keys its items so one still on screen from before runs nothing.
   */
  menuKey?: string;
  /** Lift a list row as an opaque, rounded native preview on iOS. */
  liftPreview?: boolean;
  /** The lifted preview's opaque surface; the screen background by default. */
  previewBackgroundColor?: ColorValue;
  /** Preserve a selected row's translucent wash over the opaque preview surface. */
  previewOverlayColor?: ColorValue;
  accessibilityLabel?: string;
  label?: never;
  iconName?: never;
  iconAppearance?: never;
  showCaret?: never;
  headline?: never;
  anchorSize?: never;
};

/** A text, icon, or custom long-press anchor. */
export type AppMenuProps = AppMenuTextAnchorProps | AppMenuIconAnchorProps | AppMenuLongPressAnchorProps;
