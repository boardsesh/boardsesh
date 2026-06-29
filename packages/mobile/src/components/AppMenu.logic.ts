import type { AppMenuAction } from './AppMenu.types';

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
};

export function resolveMenuAction(action: AppMenuAction): ResolvedMenuAction {
  return {
    label: action.label,
    iosSystemImage: action.selected ? 'checkmark' : action.systemIcon,
    showCheck: action.selected === true,
    isDestructive: action.destructive === true,
  };
}

export const resolveMenuActions = (actions: AppMenuAction[]): ResolvedMenuAction[] => actions.map(resolveMenuAction);
