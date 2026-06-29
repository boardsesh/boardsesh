import type { StyleProp, ViewStyle } from 'react-native';

/** A single menu row, neutral across the native iOS `Menu` / Android `DropdownMenu` impls. */
export type AppMenuAction = {
  label: string;
  /** Marks the active row — a `checkmark` on iOS, a leading ✓ on Android. */
  selected?: boolean;
  /** Tints the row as destructive — the system destructive role on iOS, `m3.error` text on Android. */
  destructive?: boolean;
  /**
   * SF Symbol name shown on the native iOS dropdown row (e.g. `person.2.fill`).
   * iOS-only: the Android Compose menu has no SF Symbols, so it's ignored there.
   */
  systemIcon?: string;
};

export type AppMenuProps = {
  /** The anchor button's text (the active scope). The native trigger renders this — there's no RN `children` anchor anymore. */
  label: string;
  actions: AppMenuAction[];
  /** Called with the index of the tapped action, matching `actions` order. */
  onSelectIndex: (index: number) => void;
  /** Trailing down-caret on the anchor. Default `true`. */
  showCaret?: boolean;
  /** Caps the anchor's width (iOS: SwiftUI `frame`; Android: best-effort RN clip). */
  maxWidth?: number;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Positions the menu's `Host` in its parent; not the menu popup. */
  style?: StyleProp<ViewStyle>;
};
