// The root tab headers' actions as native UIKit bar items rather than custom
// glass capsules. On iPhone Duo the system lays native items out on the side
// rail; a custom view never moves there, and neither does an item with a title
// but no icon. So every item here carries an icon and a title: the icon is what
// the bar and the rail show, the title is what the overflow menu and VoiceOver
// read.
//
// Pure builders, no hooks: `use-root-bar-items.tsx` feeds them live data.
import type { ColorValue } from 'react-native';
import type { NativeStackHeaderItem, NativeStackHeaderItemButton, NativeStackHeaderItemMenu } from 'expo-router';
import type { HeaderBarButtonItemVisibilityPriority } from 'react-native-screens';
/** An SF Symbol name, as the native item takes it. */
export type BarSymbol = Extract<NonNullable<NativeStackHeaderItemButton['icon']>, { type: 'sfSymbol' }>['name'];

/**
 * Which items UIKit keeps on screen longest when the bar runs out of room (iOS
 * 27; ignored before). react-native-screens reads the field off the item and
 * expo-router passes it through untouched, but expo-router's item type does not
 * declare it yet, hence the widened types below.
 */
export type BarItemVisibilityPriority = HeaderBarButtonItemVisibilityPriority;

export type RootBarButtonItem = NativeStackHeaderItemButton & { visibilityPriority?: BarItemVisibilityPriority };
export type RootBarMenuItem = NativeStackHeaderItemMenu & { visibilityPriority?: BarItemVisibilityPriority };
export type RootBarItem = RootBarButtonItem | RootBarMenuItem;

/** The `unstable_header{Left,Right}Items` factory for a fixed list of items. */
export type RootBarItemsFactory = () => NativeStackHeaderItem[];

/**
 * The account item's symbol on the Duo rail. Not `person.crop.circle`, which is
 * the Profile tab's icon just below it on the rail; the ellipsis badge reads as
 * "your menu", which is what the item opens.
 */
export const ACCOUNT_RAIL_SYMBOL: BarSymbol = 'person.crop.circle.badge.ellipsis';

/** The board-history item's identifier; the showcase recorder's anchor finds it by this. */
export const BOARD_HISTORY_ITEM_ID = 'root.boardHistory';

/** Badge text for an unread count: the number, capped like the tab badges. */
export function unreadBadgeValue(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

/**
 * The onboarding cue on the board button. The custom capsule drew a dot; a
 * native badge always carries text, so an empty one stands in for the dot.
 */
export const ONBOARDING_BADGE_VALUE = '';

type SymbolBarItemOptions = {
  /** The title: overflow menu, Large Content Viewer, and the spoken name unless `accessibilityLabel` is set. */
  label: string;
  symbol: BarSymbol;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  visibilityPriority?: BarItemVisibilityPriority;
  /** Badge text, e.g. an unread count. `null`/omitted draws no badge. */
  badge?: string | null;
  badgeColor?: ColorValue;
  tintColor?: ColorValue;
  /** Matches the item across header updates, so UIKit animates rather than swaps it. */
  identifier: string;
};

/** An SF Symbol button with a title: the shape every root action takes. */
export function symbolBarItem({
  label,
  symbol,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  visibilityPriority,
  badge,
  badgeColor,
  tintColor,
  identifier,
}: SymbolBarItemOptions): RootBarButtonItem {
  return {
    type: 'button',
    label,
    icon: { type: 'sfSymbol', name: symbol },
    variant: 'plain',
    onPress,
    identifier,
    accessibilityLabel: accessibilityLabel ?? label,
    ...(accessibilityHint ? { accessibilityHint } : {}),
    ...(visibilityPriority ? { visibilityPriority } : {}),
    ...(tintColor ? { tintColor } : {}),
    ...(badge != null
      ? { badge: { value: badge, ...(badgeColor ? { style: { backgroundColor: badgeColor } } : {}) } }
      : {}),
  };
}

/**
 * The account item for the Duo rail: a symbol, never the photo. In a horizontal
 * bar the chrome keeps the glass avatar (round photo, initials without one) as
 * a custom view instead. A bar item's image is not clipped (a photo shows
 * square), react-native-screens loads any image source after it makes the item
 * (a blank item on every header change, and UIKit then keeps it off the rail),
 * and a bar item cannot draw initials.
 */
export function accountRailItem({ label, onPress }: { label: string; onPress: () => void }): RootBarButtonItem {
  return symbolBarItem({ label, symbol: ACCOUNT_RAIL_SYMBOL, onPress, identifier: 'root.account' });
}

type MenuRow = { label: string; symbol: BarSymbol; onPress: () => void };

type MenuBarItemOptions = {
  label: string;
  symbol: BarSymbol;
  rows: readonly MenuRow[];
  identifier: string;
  visibilityPriority?: BarItemVisibilityPriority;
};

/**
 * A button that opens a native menu. react-native-screens does not expose the
 * system overflow (`additionalOverflowItems`), so a screen's own ⋯ menu stays
 * its own item; when the bar is full, UIKit folds it into the overflow as a
 * submenu.
 */
export function menuBarItem({
  label,
  symbol,
  rows,
  identifier,
  visibilityPriority,
}: MenuBarItemOptions): RootBarMenuItem {
  return {
    type: 'menu',
    label,
    icon: { type: 'sfSymbol', name: symbol },
    variant: 'plain',
    identifier,
    accessibilityLabel: label,
    ...(visibilityPriority ? { visibilityPriority } : {}),
    menu: {
      items: rows.map((row) => ({
        type: 'action',
        label: row.label,
        icon: { type: 'sfSymbol', name: row.symbol },
        onPress: row.onPress,
      })),
    },
  };
}

/**
 * A title-only button, for a value that IS the control (the board angle, "40°").
 * Apple: an item with a title and no icon never goes on the vertical rail. An
 * icon would replace the number in the horizontal bar, so this trade keeps the
 * glanceable angle on every iPhone and gives up its rail slot on iPhone Duo.
 */
export function titleBarItem({
  label,
  onPress,
  accessibilityLabel,
  identifier,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  identifier: string;
}): RootBarButtonItem {
  return {
    type: 'button',
    label,
    labelStyle: { fontWeight: '700' },
    variant: 'plain',
    onPress,
    identifier,
    accessibilityLabel,
  };
}

/** A stable factory for an item list, or `undefined` for none (clears the slot). */
export function barItemsFactory(items: readonly RootBarItem[]): RootBarItemsFactory | undefined {
  if (items.length === 0) return undefined;
  const snapshot: NativeStackHeaderItem[] = [...items];
  return () => snapshot;
}
