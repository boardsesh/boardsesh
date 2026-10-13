// The quick-filter capsule row: the small, horizontally scrolling row of filter
// capsules a list pins under its title (the climbs list today). A surface builds
// a plain `Capsule[]` (labels already localised, handlers bound) and hands it to
// <CapsuleRow>; the row only maps each descriptor to the platform's native
// control. It knows nothing about climbs, logbooks or any filter state.
//
// Platform-split like SwitchRow (docs/expo-ui-components.md):
//   CapsuleRow.ios.tsx      SwiftUI glass buttons + menus in one <Host>
//   CapsuleRow.android.tsx  Compose M3 FilterChips + DropdownMenus in one <Host>
//   CapsuleRow.web.tsx      react-native-paper Chips + Menus
// This file carries no native imports, so every platform file, the surface
// builders and their tests can import it.
//
// Active capsules use the filled brand colour (`primaryFill`) with `onPrimary`
// text on every platform (docs/ai-design-guidelines.md, "Brand colours").

import type { ReactElement } from 'react';

/**
 * A glyph a capsule or menu action can carry. Each platform maps the name to its
 * own icon set (SF Symbol, Material vector drawable, Paper icon name); a platform
 * with no glyph for a name draws none. The lock glyphs are iOS-only, like the
 * Tall / Wide lock they belong to.
 */
export type CapsuleIcon = 'filters' | 'recent' | 'locked' | 'lock' | 'unlock';

/** One choice in a {@link MenuCapsule}. `value` is the stable tag handed back to `onSelect`. */
export type CapsuleOption = {
  value: string;
  label: string;
};

/** A plain command in a capsule's menu ("Clear recent searches", "Custom…", "Lock"). */
export type CapsuleMenuAction = {
  key: string;
  label: string;
  onPress: () => void;
  icon?: CapsuleIcon;
  /** Drawn in the destructive style (red) on iOS and Android. */
  destructive?: boolean;
};

type CapsuleBase = {
  /** Stable React key, unique within the row (the pinnable kind works well). */
  key: string;
  /** Localised final text; icon badges retain it as their spoken label. */
  label: string;
};

/**
 * Opens something the screen presents: the full filter sheet ("Filters · N"), a
 * picker route, the Android angle sheet. The screen owns what opens; the capsule
 * only reports the tap.
 */
export type SheetCapsule = CapsuleBase & {
  kind: 'sheet';
  /** Active filters behind the sheet. Lights the capsule when above 0. */
  count?: number;
  /** Full spoken label, including the active count. */
  accessibilityLabel?: string;
  onPress: () => void;
} & ({ presentation?: 'label'; icon?: CapsuleIcon } | { presentation: 'iconBadge'; icon: CapsuleIcon });

/**
 * Shows and hides an inline rail the screen renders under the row (the grade
 * range rail). On iOS the trailing chevron points up while the rail is shown.
 */
export type RailCapsule = CapsuleBase & {
  kind: 'rail';
  /** A value is set (lights the capsule). */
  active: boolean;
  /** The rail is shown. Flips the iOS chevron; also drives the popover below. */
  expanded: boolean;
  /** One tap handler for both directions: the caller decides open vs close from `expanded`. */
  onPress: () => void;
  /** VoiceOver hint, e.g. "Shows the grade row" / "Hides the grade row". */
  accessibilityHint?: string;
  /**
   * iOS only: present `content` in a popover anchored to the capsule instead of
   * an inline rail (regular-width iPad). Shown while `expanded`; `onDismiss`
   * fires when the system dismisses it (tap outside).
   */
  popover?: { content: ReactElement; onDismiss: () => void };
};

/**
 * A single-select menu. iOS draws a native Picker inside a Menu, Android and the
 * web a dropdown with a check on the selected option. `actions` follow the
 * options after a divider.
 */
export type MenuCapsule = CapsuleBase & {
  kind: 'menu';
  /** A non-default value is in force (lights the capsule). */
  active: boolean;
  icon?: CapsuleIcon;
  options: readonly CapsuleOption[];
  /** The selected option's `value`; `undefined` checks nothing. */
  selected: string | undefined;
  /** Called with an option's `value`. Narrow it before committing. */
  onSelect: (value: string) => void;
  /**
   * `'picker'` (default): one value is in force; iOS draws a Picker, which only
   * reports a change. `'commands'`: each option is something to apply (a saved
   * search). Every tap calls `onSelect`, the checked one too, and iOS draws
   * plain buttons with a checkmark. Android and the web draw both the same way.
   */
  optionStyle?: 'picker' | 'commands';
  actions?: readonly CapsuleMenuAction[];
};

/** An on/off filter. Tap flips it; VoiceOver hears a toggle that is on or off. */
export type ToggleCapsule = CapsuleBase & {
  kind: 'toggle';
  active: boolean;
  onPress: () => void;
};

/**
 * A toggle with extra commands behind a long-press (the climbs Tall / Wide lock).
 * iOS: tap runs `onPress`, a long-press opens `actions`. Android and the web
 * draw a plain toggle and `actions` are unreachable: a Compose FilterChip eats
 * the long-press (#3319, #3322). Only put commands here that the surface can do
 * without on those platforms.
 */
export type ToggleMenuCapsule = CapsuleBase & {
  kind: 'toggleMenu';
  active: boolean;
  icon?: CapsuleIcon;
  onPress: () => void;
  actions: readonly CapsuleMenuAction[];
};

export type Capsule = SheetCapsule | RailCapsule | MenuCapsule | ToggleCapsule | ToggleMenuCapsule;

export type CapsuleRowProps = {
  /** Rendered in order. Build the array in a `useMemo` so the row can skip re-renders. */
  capsules: readonly Capsule[];
};
