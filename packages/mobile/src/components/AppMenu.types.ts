import type { StyleProp, ViewStyle } from 'react-native';
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
};

/** Icon anchor: a bare glyph trigger (the "⋯" overflow button), with no visible text. */
type AppMenuIconAnchorProps = AppMenuSharedProps & {
  label?: never;
  iconName: IconName;
  /** Required here: a glyph-only anchor has no visible text for a screen reader to fall back on. */
  accessibilityLabel: string;
  /** A glyph anchor never carries a caret — the glyph itself is the affordance. */
  showCaret?: never;
};

/** Exactly one of `label` / `iconName`: a text anchor or a glyph anchor, never both. */
export type AppMenuProps = AppMenuTextAnchorProps | AppMenuIconAnchorProps;
