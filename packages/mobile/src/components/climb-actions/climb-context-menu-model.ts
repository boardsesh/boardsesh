// How the climb actions are laid out in the iOS native context menu. Pure, so the
// mapping is tested without UIKit.
//
// HIG (Context menus): put the most-used items first, group related items with
// separators, keep the list short, and put a destructive item last. Each group
// below is an inline section, so UIKit draws the separators between them.
//
// The menu's tree has the same shape for every climb: an action this climber
// isn't offered is HIDDEN, never left out. FlashList recycles a row for a new
// climb, and a stable tree means a recycle only flips `hidden` flags on views
// that already exist, rather than mounting and unmounting native menu items.

import type { ClimbActionId } from './climb-action-gating';

/** The three most-reached actions. The overlay pins them as a button row above its
 *  list, and the native menu shows them as its small top row (like Mail's). */
export const PRIMARY_CLIMB_ACTION_IDS: readonly ClimbActionId[] = ['tick', 'playlist', 'share'];

export type ClimbContextMenuSectionKey = 'quick' | 'play' | 'personal' | 'setter' | 'moderation';

type SectionLayout = {
  key: ClimbContextMenuSectionKey;
  ids: readonly ClimbActionId[];
  /** Small, side-by-side items (`UIMenu.ElementSize.small`): icon over a short title. */
  compact: boolean;
};

export const CLIMB_CONTEXT_MENU_LAYOUT: readonly SectionLayout[] = [
  { key: 'quick', ids: PRIMARY_CLIMB_ACTION_IDS, compact: true },
  // Putting the climb on the wall, now or later.
  { key: 'play', ids: ['preview', 'queue', 'playNext', 'openQueue'], compact: false },
  // Your own record of the climb.
  { key: 'personal', ids: ['favorite', 'editEntry', 'betaVideo'], compact: false },
  // Setting: change it, build on it, or open it where it was set.
  { key: 'setter', ids: ['edit', 'fork', 'openInApp'], compact: false },
  // Acting against the climb sits below everything a climber came to do.
  { key: 'moderation', ids: ['report', 'delete'], compact: false },
];

const DESTRUCTIVE_IDS: ReadonlySet<ClimbActionId> = new Set(['delete']);

export type ClimbContextMenuItem = {
  id: ClimbActionId;
  hidden: boolean;
  destructive: boolean;
};

export type ClimbContextMenuSection = {
  key: ClimbContextMenuSectionKey;
  compact: boolean;
  items: ClimbContextMenuItem[];
};

/** Lay `offeredIds` (from `resolveClimbActionIds`) out as menu sections. */
export function buildClimbContextMenu(offeredIds: readonly ClimbActionId[]): ClimbContextMenuSection[] {
  const offered = new Set(offeredIds);
  return CLIMB_CONTEXT_MENU_LAYOUT.map(({ key, ids, compact }) => ({
    key,
    compact,
    items: ids.map((id) => ({ id, hidden: !offered.has(id), destructive: DESTRUCTIVE_IDS.has(id) })),
  }));
}
