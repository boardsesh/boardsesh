// The rows a board card's menu offers, and the order it offers them in. The card
// has two ways into one menu (the ⋯ beside the title and a hold on the card) and
// publishes the same rows as screen-reader actions, so the decision lives here,
// pure, where a table test can pin every combination without rendering a card.

import type { BoardDownloadState } from './board-offline-state';

/**
 * Everything a card menu can do. Also the `action` property of the
 * `Board Card Action` event, so a rename here is a rename in PostHog.
 *
 * There is deliberately no `'follow'`: inside "Your boards" a board you do not
 * own is one you already follow, and following someone else's board happens on
 * Near you by picking it.
 */
export type BoardCardMenuAction =
  | 'climb_here'
  | 'pin'
  | 'unpin'
  | 'download'
  | 'details'
  | 'edit'
  | 'unfollow'
  | 'delete';

/** Which way in the climber used: the ⋯ button, a hold on the card, or a screen-reader action. */
export type BoardCardMenuVia = 'menu_button' | 'long_press' | 'accessibility';

/** The carousel the card sits in. Only these two get a menu. */
export type BoardCardMenuSection = 'your_boards' | 'nearby';

/**
 * What the surface allows, decided once per carousel by the host. Every flag is
 * a gate the host owns (onboarding, offline, a session with no identity), so no
 * per-item input below can talk the menu past it.
 */
export type BoardCardMenuCapabilities = {
  /** Pin and unpin. The picker's `canPinBoards`: signed in, online, not onboarding. */
  canPin: boolean;
  /** Download for offline, for a board that is not on the phone yet. Off with offline downloads disabled. */
  canDownload: boolean;
  /** The board detail sheet. Every board has one; a surface that cannot show it turns this off. */
  canOpenDetails: boolean;
  /**
   * Edit, unfollow and delete. The picker's `canEditBoards`: there are boards,
   * the viewer's identity resolved, the phone is online and this is not
   * onboarding.
   */
  canManage: boolean;
};

/** The parts of a card's item the menu reads. Scalars, so a caller can memoize on them. */
export type BoardCardMenuItemState = {
  isPinned: boolean;
  offlineState: BoardDownloadState | undefined;
  /** `undefined` means ownership did not resolve, which offers neither unfollow nor delete. */
  isViewerOwner: boolean | undefined;
  /** An unfinished spray wall import. A tap continues the import instead of climbing. */
  isImport: boolean;
};

export type BoardCardMenuEntry = {
  action: BoardCardMenuAction;
  /** Tinted as destructive: the system destructive role on iOS, the error colour elsewhere. */
  destructive: boolean;
  /** Opens a new group with a separator above the row. */
  dividerBefore: boolean;
};

const NO_ENTRIES: readonly BoardCardMenuEntry[] = [];

function entry(action: BoardCardMenuAction, dividerBefore = false): BoardCardMenuEntry {
  return { action, destructive: action === 'unfollow' || action === 'delete', dividerBefore };
}

/**
 * The card's menu, top to bottom: Climb here, Pin or Unpin, Download for
 * offline, Details, Edit board, then a divider and Unfollow or Delete.
 *
 * Returns no rows at all when nothing beyond Climb here is on offer: a menu
 * whose only row repeats the tap is a ⋯ that does nothing new, so the card
 * draws no ⋯ and publishes no actions.
 */
export function boardCardMenuEntries(
  item: BoardCardMenuItemState,
  capabilities: BoardCardMenuCapabilities,
): readonly BoardCardMenuEntry[] {
  const entries: BoardCardMenuEntry[] = [];
  // An unfinished import is not a board you can climb on yet: its tap opens
  // the import wizard, so "Climb here" would promise something the tap does
  // not do. It has no catalogue to download and no details to show either.
  if (!item.isImport) entries.push(entry('climb_here'));
  if (capabilities.canPin) entries.push(entry(item.isPinned ? 'unpin' : 'pin'));
  if (capabilities.canDownload && !item.isImport && item.offlineState === 'off') entries.push(entry('download'));
  if (capabilities.canOpenDetails && !item.isImport) entries.push(entry('details'));
  if (capabilities.canManage && item.isViewerOwner === true) entries.push(entry('edit'));
  // Delete is owner-only on the server, so a board you follow offers unfollow
  // rather than a delete the backend would reject. Unknown ownership offers
  // neither: guessing "followed" would offer to unfollow the climber's own wall.
  if (capabilities.canManage && item.isViewerOwner !== undefined) {
    entries.push(entry(item.isViewerOwner ? 'delete' : 'unfollow', true));
  }
  return entries.some((candidate) => candidate.action !== 'climb_here') ? entries : NO_ENTRIES;
}

/** The menu's visible row labels, resolved once per carousel so every card shares one object. */
export type BoardCardMenuLabels = Readonly<{
  climbHere: string;
  pin: string;
  unpin: string;
  download: string;
  details: string;
  /** "Edit board". */
  edit: string;
  /** "Edit Spraywall": a spray wall is never called a board in copy. */
  editWall: string;
  unfollow: string;
  delete: string;
}>;

export function boardCardMenuLabel(
  action: BoardCardMenuAction,
  labels: BoardCardMenuLabels,
  isSprayWall: boolean,
): string {
  switch (action) {
    case 'climb_here':
      return labels.climbHere;
    case 'pin':
      return labels.pin;
    case 'unpin':
      return labels.unpin;
    case 'download':
      return labels.download;
    case 'details':
      return labels.details;
    case 'edit':
      return isSprayWall ? labels.editWall : labels.edit;
    case 'unfollow':
      return labels.unfollow;
    case 'delete':
      return labels.delete;
  }
}

/** SF Symbols for the iOS menu rows. Android and the browser draw text-only rows. */
export const BOARD_CARD_MENU_SYSTEM_ICONS: Readonly<Record<BoardCardMenuAction, string>> = {
  climb_here: 'figure.climbing',
  pin: 'pin',
  unpin: 'pin.slash',
  download: 'icloud.and.arrow.down',
  details: 'info.circle',
  edit: 'pencil',
  unfollow: 'person.badge.minus',
  delete: 'trash',
};
