// The root tab headers' actions as native UIKit bar items rather than custom
// glass capsules. On iPhone Duo the system lays native items out on the side
// rail; a custom view never moves there, and neither does an item with a title
// but no icon. So every item here carries an icon and a title: the icon is what
// the bar and the rail show, the title is what the overflow menu and VoiceOver
// read.
//
// Pure builders, no hooks: `use-root-bar-items.tsx` feeds them live data.
import type { ColorValue, ImageURISource } from 'react-native';
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

/** The avatar shows the person's photo; with none, this outline. */
export const AVATAR_FALLBACK_SYMBOL: BarSymbol = 'person.crop.circle';

/**
 * The avatar photo's size in the bar, in points. UIKit draws a bar item's image
 * at its own size, so this is the face's size: the glass slot around it is
 * UIKit's. 28pt keeps the face inside the 38pt native slot with the same 5pt
 * margin the custom capsule had.
 */
export const AVATAR_BAR_PHOTO_SIZE = 28;

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

type AvatarBarItemOptions = {
  label: string;
  onPress: () => void;
  /**
   * The loaded photo, sized for the bar. `null` while there is none, it has not
   * loaded yet, or it failed: the item then shows `AVATAR_FALLBACK_SYMBOL`.
   */
  photo: ImageURISource | null;
};

/**
 * The account avatar: the person's photo in its own colours (`tinted: false`,
 * so UIKit does not flatten it to the bar tint), else the outline symbol.
 */
export function avatarBarItem({ label, onPress, photo }: AvatarBarItemOptions): RootBarButtonItem {
  return {
    type: 'button',
    label,
    icon: photo ? { type: 'image', source: photo, tinted: false } : { type: 'sfSymbol', name: AVATAR_FALLBACK_SYMBOL },
    variant: 'plain',
    onPress,
    identifier: 'root.account',
    accessibilityLabel: label,
  };
}

/** The bar-sized request for a photo: UIKit scales the decoded image to this box. */
export function avatarPhotoSource(uri: string, scale: number): ImageURISource {
  return { uri, width: AVATAR_BAR_PHOTO_SIZE, height: AVATAR_BAR_PHOTO_SIZE, scale };
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
