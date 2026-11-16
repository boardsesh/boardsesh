import { describe, expect, it } from 'vitest';
import {
  BOARD_CARD_MENU_SYSTEM_ICONS,
  boardCardMenuEntries,
  boardCardMenuLabel,
  type BoardCardMenuAction,
  type BoardCardMenuCapabilities,
  type BoardCardMenuItemState,
  type BoardCardMenuLabels,
} from '../board-card-menu';

// The picker's "Your boards" carousel, online, signed in, identity resolved.
const EVERYTHING: BoardCardMenuCapabilities = {
  canPin: true,
  canDownload: true,
  canOpenDetails: true,
  canManage: true,
};
// The picker opened from onboarding: no pins and no board management.
const ONBOARDING: BoardCardMenuCapabilities = { ...EVERYTHING, canPin: false, canManage: false };
// Signed in, but the viewer's id did not resolve: a pin is still the viewer's own.
const NO_IDENTITY: BoardCardMenuCapabilities = { ...EVERYTHING, canManage: false };
const NEARBY: BoardCardMenuCapabilities = {
  canPin: false,
  canDownload: false,
  canOpenDetails: true,
  canManage: false,
};
// Offline downloads disabled (the Expo browser app, or the flag off).
const NO_DOWNLOADS: BoardCardMenuCapabilities = { ...EVERYTHING, canDownload: false };
const NOTHING: BoardCardMenuCapabilities = {
  canPin: false,
  canDownload: false,
  canOpenDetails: false,
  canManage: false,
};

const owned: BoardCardMenuItemState = { isPinned: false, offlineState: 'off', isViewerOwner: true, isImport: false };
const followed: BoardCardMenuItemState = { ...owned, isViewerOwner: false };
const unknownOwner: BoardCardMenuItemState = { ...owned, isViewerOwner: undefined };
const pinned: BoardCardMenuItemState = { ...owned, isPinned: true };
const downloaded: BoardCardMenuItemState = { ...owned, offlineState: 'downloaded' };
const downloading: BoardCardMenuItemState = { ...owned, offlineState: 'downloading' };
const nearbyBoard: BoardCardMenuItemState = {
  isPinned: false,
  offlineState: undefined,
  isViewerOwner: undefined,
  isImport: false,
};
const importing: BoardCardMenuItemState = { ...owned, offlineState: undefined, isImport: true };

const actionsOf = (item: BoardCardMenuItemState, capabilities: BoardCardMenuCapabilities): BoardCardMenuAction[] =>
  boardCardMenuEntries(item, capabilities).map((entry) => entry.action);

describe('boardCardMenuEntries', () => {
  it.each<[string, BoardCardMenuItemState, BoardCardMenuCapabilities, BoardCardMenuAction[]]>([
    ['your own board', owned, EVERYTHING, ['climb_here', 'pin', 'download', 'details', 'edit', 'delete']],
    ['a board you follow', followed, EVERYTHING, ['climb_here', 'pin', 'download', 'details', 'unfollow']],
    ['a pinned board', pinned, EVERYTHING, ['climb_here', 'unpin', 'download', 'details', 'edit', 'delete']],
    ['a board already on the phone', downloaded, EVERYTHING, ['climb_here', 'pin', 'details', 'edit', 'delete']],
    ['a board still downloading', downloading, EVERYTHING, ['climb_here', 'pin', 'details', 'edit', 'delete']],
    // Guessing "followed" would offer to unfollow the climber's own wall.
    ['a board whose ownership did not resolve', unknownOwner, EVERYTHING, ['climb_here', 'pin', 'download', 'details']],
    ['your own board during onboarding', owned, ONBOARDING, ['climb_here', 'download', 'details']],
    ['your own board with no identity', owned, NO_IDENTITY, ['climb_here', 'pin', 'download', 'details']],
    [
      'your own board with offline downloads off',
      owned,
      NO_DOWNLOADS,
      ['climb_here', 'pin', 'details', 'edit', 'delete'],
    ],
    ['a Near you board', nearbyBoard, NEARBY, ['climb_here', 'details']],
    // An import's tap continues the import, and it has nothing to download or show.
    ['an unfinished spray wall import', importing, EVERYTHING, ['pin', 'edit', 'delete']],
  ])('offers the right rows for %s', (_case, item, capabilities, expected) => {
    expect(actionsOf(item, capabilities)).toEqual(expected);
  });

  // A menu whose only row repeats the tap is a ⋯ that does nothing new.
  it.each<[string, BoardCardMenuItemState, BoardCardMenuCapabilities]>([
    ['nothing allowed', owned, NOTHING],
    ['only a download, on a board already on the phone', downloaded, { ...NOTHING, canDownload: true }],
    ['only management, with ownership unknown', unknownOwner, { ...NOTHING, canManage: true }],
    ['only details, on an import', importing, { ...NOTHING, canOpenDetails: true }],
  ])('offers no rows at all with %s', (_case, item, capabilities) => {
    expect(boardCardMenuEntries(item, capabilities)).toEqual([]);
  });

  it('marks unfollow and delete destructive and opens a new group above them', () => {
    const deleteRow = boardCardMenuEntries(owned, EVERYTHING).find((entry) => entry.action === 'delete');
    const unfollowRow = boardCardMenuEntries(followed, EVERYTHING).find((entry) => entry.action === 'unfollow');
    expect(deleteRow).toEqual({ action: 'delete', destructive: true, dividerBefore: true });
    expect(unfollowRow).toEqual({ action: 'unfollow', destructive: true, dividerBefore: true });
  });

  it('keeps every other row plain, with no divider', () => {
    const plain = boardCardMenuEntries(owned, EVERYTHING).filter((entry) => entry.action !== 'delete');
    expect(plain.every((entry) => !entry.destructive && !entry.dividerBefore)).toBe(true);
  });

  // Delete is owner-only on the server: a followed board must never reach it.
  it('never offers delete or edit on a board the viewer does not own', () => {
    const actions = actionsOf(followed, EVERYTHING);
    expect(actions).not.toContain('delete');
    expect(actions).not.toContain('edit');
  });
});

const LABELS: BoardCardMenuLabels = {
  climbHere: 'Climb here',
  pin: 'Pin',
  unpin: 'Unpin',
  download: 'Download for offline',
  details: 'Details',
  edit: 'Edit board',
  editWall: 'Edit Spraywall',
  unfollow: 'Unfollow',
  delete: 'Delete',
};

describe('boardCardMenuLabel', () => {
  it.each<[BoardCardMenuAction, string]>([
    ['climb_here', 'Climb here'],
    ['pin', 'Pin'],
    ['unpin', 'Unpin'],
    ['download', 'Download for offline'],
    ['details', 'Details'],
    ['edit', 'Edit board'],
    ['unfollow', 'Unfollow'],
    ['delete', 'Delete'],
  ])('labels %s', (action, expected) => {
    expect(boardCardMenuLabel(action, LABELS, false)).toBe(expected);
  });

  // A spray wall is never called a board in copy.
  it('calls a spray wall a Spraywall when offering to edit it', () => {
    expect(boardCardMenuLabel('edit', LABELS, true)).toBe('Edit Spraywall');
    expect(boardCardMenuLabel('delete', LABELS, true)).toBe('Delete');
  });
});

describe('BOARD_CARD_MENU_SYSTEM_ICONS', () => {
  it('gives every row an SF Symbol', () => {
    const actions: BoardCardMenuAction[] = [
      'climb_here',
      'pin',
      'unpin',
      'download',
      'details',
      'edit',
      'unfollow',
      'delete',
    ];
    for (const action of actions) expect(BOARD_CARD_MENU_SYSTEM_ICONS[action]).toMatch(/\S/);
  });
});
