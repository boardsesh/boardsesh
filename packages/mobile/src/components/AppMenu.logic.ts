import type { AppMenuAction } from './AppMenu.types';
import type { IconName } from './icon-map';

/** A menu action resolved to the per-platform pieces each native impl renders. */
export type ResolvedMenuAction = {
  label: string;
  /**
   * The SF Symbol the iOS row shows: `checkmark` when selected (the active marker),
   * otherwise the action's own `systemIcon` (or none). The native UIMenu has a single
   * symbol slot, so the checkmark replaces the scope glyph on the active row.
   */
  iosSystemImage: string | undefined;
  /** Android renders a leading ✓ on the active row (no SF Symbols there). */
  showCheck: boolean;
  isDestructive: boolean;
  /** Row is shown but unselectable — SwiftUI `.disabled`, Compose `enabled={false}`, Paper `disabled`. */
  isDisabled: boolean;
};

export function resolveMenuAction(action: AppMenuAction): ResolvedMenuAction {
  return {
    label: action.label,
    iosSystemImage: action.selected ? 'checkmark' : action.systemIcon,
    showCheck: action.selected === true,
    isDestructive: action.destructive === true,
    isDisabled: action.disabled === true,
  };
}

export const resolveMenuActions = (actions: AppMenuAction[]): ResolvedMenuAction[] => actions.map(resolveMenuAction);

/**
 * Whether a press on row `index` may reach `onSelectIndex`. Every native menu already
 * swallows a disabled row's press (SwiftUI `.disabled`, Compose `enabled={false}`,
 * Paper `disabled`), so this is the JS-side backstop each impl runs first — and the
 * only version of the rule a test can reach, since none of those menus mount under
 * Vitest.
 */
export const isMenuActionSelectable = (resolvedActions: ResolvedMenuAction[], index: number): boolean =>
  resolvedActions[index]?.isDisabled === false;

// Plain-text stand-ins for an icon anchor's glyph on Android and web. The Compose
// `Icon` needs a vector-drawable source and @expo/ui bundles none, so the glyph is a
// text character there — the same trade-off the `▾` caret already makes. Only the
// overflow family has a faithful stand-in; every other icon falls back to the
// horizontal ellipsis, which is what a glyph-anchored menu reads as anyway.
const ANCHOR_GLYPHS: Partial<Record<IconName, string>> = {
  more: '⋯',
  'more.actions': '⋯',
  'more.vertical': '⋮',
};

export const anchorGlyphForIcon = (iconName: IconName): string => ANCHOR_GLYPHS[iconName] ?? '⋯';
