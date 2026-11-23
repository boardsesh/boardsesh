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
 *
 * `unfollow` reads "Remove from your boards": it only touches the viewer's own
 * list. `remove_from_gym` takes the board off its gym's listing and leaves it
 * with its creator. `delete` removes it for everyone.
 *
 * A "Merge into another board" row is planned for duplicates once the board
 * merge tool lands (docs/product/gym-board-governance.md, decision 1). It
 * belongs in the trailing group, above `delete`, gated on a server flag like
 * the rows below.
 */
export type BoardCardMenuAction =
  | 'climb_here'
  | 'pin'
  | 'unpin'
  | 'download'
  | 'details'
  | 'edit'
  | 'remove_from_gym'
  | 'unfollow'
  | 'delete';

/** Which way in the climber used: the ⋯ button, a hold on the card, or a screen-reader action. */
export type BoardCardMenuVia = 'menu_button' | 'long_press' | 'accessibility';

/**
 * The picker list the board sits in. Only these get a menu; At {gym} only on
 * the walls that are the climber's own or followed boards.
 */
export type BoardCardMenuSection = 'your_boards' | 'nearby' | 'at_gym';

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
   * Edit, remove from gym, unfollow and delete. The picker's `canEditBoards`:
   * there are boards, the viewer's identity resolved, the phone is online and
   * this is not onboarding.
   */
  canManage: boolean;
};

/** The parts of a card's item the menu reads. Scalars, so a caller can memoize on them. */
export type BoardCardMenuItemState = {
  isPinned: boolean;
  offlineState: BoardDownloadState | undefined;
  /** `undefined` means ownership did not resolve, which offers no unfollow. */
  isViewerOwner: boolean | undefined;
  /** An unfinished spray wall import. A tap continues the import instead of climbing. */
  isImport: boolean;
  /**
   * The server's `UserBoard.canEdit`, `canDelete` and `canRemoveFromGym`: the
   * viewer's own boards, and the boards gym staff look after. `undefined` is a
   * board read before the field existed (an older offline snapshot), which
   * falls back to the owner-only rule the server applied then.
   */
  canEdit: boolean | undefined;
  canDelete: boolean | undefined;
  canRemoveFromGym: boolean | undefined;
  /** The gym the board is listed at, so Remove from gym can name it. */
  gymName: string | null | undefined;
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
  // Only delete is red. Removing a board from your list or from a gym is
  // reversible and leaves the board for everyone else; a red row there read as
  // the delete climbers were looking for.
  return { action, destructive: action === 'delete', dividerBefore };
}

/**
 * The card's menu, top to bottom: Climb here, Pin or Unpin, Download for
 * offline, Details, Edit board, then a divider and Remove from {gym}, Remove
 * from your boards, Delete.
 *
 * Edit, Remove from {gym} and Delete follow the server's flags, so gym staff get
 * them on a board they follow and a climber never sees a row the backend would
 * refuse. Remove from your boards is for any board the viewer follows and does
 * not own.
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
  if (capabilities.canManage && boardCardMenuAllows(item, 'edit')) entries.push(entry('edit'));
  if (capabilities.canManage) {
    const trailing = TRAILING_ACTIONS.filter((action) => boardCardMenuAllows(item, action));
    trailing.forEach((action, index) => entries.push(entry(action, index === 0)));
  }
  return entries.some((candidate) => candidate.action !== 'climb_here') ? entries : NO_ENTRIES;
}

const TRAILING_ACTIONS = ['remove_from_gym', 'unfollow', 'delete'] as const;

/** The rows that change a board rather than the viewer's view of it. */
export type BoardCardManageAction = 'edit' | (typeof TRAILING_ACTIONS)[number];

/**
 * Whether this board allows a managing row, before the surface's own gates.
 * The menu builder and the host that runs the row both ask here, so a row drawn
 * from stale data cannot run something the current data refuses.
 *
 * - Edit, delete: the server's flag; on a board read before the flag existed,
 *   ownership, which is what the server allowed then.
 * - Remove from gym: the server's flag, and a gym name to put in the row and
 *   its confirm. Location privacy can keep the gym back; then the row stays
 *   off rather than asking to remove a board from a gym it cannot name.
 * - Unfollow: a board the viewer follows and does not own. Unknown ownership
 *   offers none: guessing "followed" would offer to unfollow the climber's own
 *   wall.
 */
export function boardCardMenuAllows(item: BoardCardMenuItemState, action: BoardCardManageAction): boolean {
  switch (action) {
    case 'edit':
      return item.canEdit ?? item.isViewerOwner === true;
    case 'delete':
      return item.canDelete ?? item.isViewerOwner === true;
    case 'remove_from_gym':
      return item.canRemoveFromGym === true && !!item.gymName;
    case 'unfollow':
      return item.isViewerOwner === false;
  }
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
  /** "Remove from gym", for a board whose gym name the viewer can't see. */
  removeFromGym: string;
  /** "Remove from {gym}". Built from a resolved template, so it is stable across renders. */
  removeFromNamedGym: (gymName: string) => string;
  /** "Remove from your boards". */
  unfollow: string;
  delete: string;
}>;

export function boardCardMenuLabel(
  action: BoardCardMenuAction,
  labels: BoardCardMenuLabels,
  isSprayWall: boolean,
  gymName?: string | null,
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
    case 'remove_from_gym':
      return gymName ? labels.removeFromNamedGym(gymName) : labels.removeFromGym;
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
  remove_from_gym: 'mappin.slash',
  unfollow: 'person.badge.minus',
  delete: 'trash',
};
