import { describe, expect, it } from 'vitest';
import {
  BOARD_CARD_MENU_SYSTEM_ICONS,
  boardCardMenuAllows,
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
  canReport: false,
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
  canReport: false,
};
// Offline downloads disabled (the Expo browser app, or the flag off).
const NO_DOWNLOADS: BoardCardMenuCapabilities = { ...EVERYTHING, canDownload: false };
const NOTHING: BoardCardMenuCapabilities = {
  canPin: false,
  canDownload: false,
  canOpenDetails: false,
  canManage: false,
  canReport: false,
};

const owned: BoardCardMenuItemState = {
  isPinned: false,
  offlineState: 'off',
  isViewerOwner: true,
  isImport: false,
  canEdit: true,
  canDelete: true,
  canRemoveFromGym: false,
  gymName: null,
};
const followed: BoardCardMenuItemState = { ...owned, isViewerOwner: false, canEdit: false, canDelete: false };
const unknownOwner: BoardCardMenuItemState = {
  ...owned,
  isViewerOwner: undefined,
  canEdit: undefined,
  canDelete: undefined,
};
// Your own board, listed at a gym: you can take it off the listing yourself.
const ownedAtGym: BoardCardMenuItemState = { ...owned, canRemoveFromGym: true, gymName: 'Crux' };
// A climber's board you follow, at the gym you run as an admin.
const staffFollowed: BoardCardMenuItemState = { ...followed, canEdit: true, canRemoveFromGym: true, gymName: 'Crux' };
// A gym editor: can take a board off the listing, can't edit or delete it.
const editorFollowed: BoardCardMenuItemState = { ...followed, canRemoveFromGym: true, gymName: 'Crux' };
// A synced board (public board data) you follow at the gym you run: staff delete it.
const syncedAtYourGym: BoardCardMenuItemState = { ...followed, canEdit: true, canDelete: true, gymName: 'Crux' };
// A board read before the server sent these flags: the old owner-only rule.
const legacyOwned: BoardCardMenuItemState = {
  ...owned,
  canEdit: undefined,
  canDelete: undefined,
  canRemoveFromGym: undefined,
};
const legacyFollowed: BoardCardMenuItemState = { ...legacyOwned, isViewerOwner: false };
const pinned: BoardCardMenuItemState = { ...owned, isPinned: true };
const downloaded: BoardCardMenuItemState = { ...owned, offlineState: 'downloaded' };
const downloading: BoardCardMenuItemState = { ...owned, offlineState: 'downloading' };
const nearbyBoard: BoardCardMenuItemState = {
  isPinned: false,
  offlineState: undefined,
  isViewerOwner: undefined,
  isImport: false,
  canEdit: undefined,
  canDelete: undefined,
  canRemoveFromGym: undefined,
  gymName: undefined,
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
    [
      'your own board at a gym',
      ownedAtGym,
      EVERYTHING,
      ['climb_here', 'pin', 'download', 'details', 'edit', 'remove_from_gym', 'delete'],
    ],
    [
      "a climber's board at the gym you run",
      staffFollowed,
      EVERYTHING,
      ['climb_here', 'pin', 'download', 'details', 'edit', 'remove_from_gym', 'unfollow'],
    ],
    [
      'a board at the gym you edit for',
      editorFollowed,
      EVERYTHING,
      ['climb_here', 'pin', 'download', 'details', 'remove_from_gym', 'unfollow'],
    ],
    [
      'a synced board at the gym you run',
      syncedAtYourGym,
      EVERYTHING,
      ['climb_here', 'pin', 'download', 'details', 'edit', 'unfollow', 'delete'],
    ],
    // No gym to name: the row stays off rather than ask to remove it from "".
    [
      'a removable board whose gym privacy keeps back',
      { ...staffFollowed, gymName: null },
      EVERYTHING,
      ['climb_here', 'pin', 'download', 'details', 'edit', 'unfollow'],
    ],
    [
      'your own board read before the flags existed',
      legacyOwned,
      EVERYTHING,
      ['climb_here', 'pin', 'download', 'details', 'edit', 'delete'],
    ],
    [
      'a followed board read before the flags existed',
      legacyFollowed,
      EVERYTHING,
      ['climb_here', 'pin', 'download', 'details', 'unfollow'],
    ],
    [
      "a climber's board at your gym during onboarding",
      staffFollowed,
      ONBOARDING,
      ['climb_here', 'download', 'details'],
    ],
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

  it('tints only delete as destructive, and opens one new group above the first managing row', () => {
    expect(boardCardMenuEntries(owned, EVERYTHING).find((entry) => entry.action === 'delete')).toEqual({
      action: 'delete',
      destructive: true,
      dividerBefore: true,
      disabled: false,
    });
    // Removing from your boards only touches your list: red made it look like
    // the delete climbers were looking for.
    expect(boardCardMenuEntries(followed, EVERYTHING).find((entry) => entry.action === 'unfollow')).toEqual({
      action: 'unfollow',
      destructive: false,
      dividerBefore: true,
      disabled: false,
    });
    const staffRows = boardCardMenuEntries(staffFollowed, EVERYTHING).filter((entry) =>
      ['remove_from_gym', 'unfollow'].includes(entry.action),
    );
    expect(staffRows).toEqual([
      { action: 'remove_from_gym', destructive: false, dividerBefore: true, disabled: false },
      { action: 'unfollow', destructive: false, dividerBefore: false, disabled: false },
    ]);
  });

  it('keeps every row above the managing group plain, with no divider', () => {
    const plain = boardCardMenuEntries(owned, EVERYTHING).filter((entry) => entry.action !== 'delete');
    expect(plain.every((entry) => !entry.destructive && !entry.dividerBefore)).toBe(true);
  });

  // The server decides delete: a followed board the viewer can't delete never offers it.
  it('never offers delete or edit when the server refuses them', () => {
    const actions = actionsOf(followed, EVERYTHING);
    expect(actions).not.toContain('delete');
    expect(actions).not.toContain('edit');
    expect(actions).not.toContain('remove_from_gym');
  });
});

describe('Report a problem in the card menu', () => {
  const REPORTING: BoardCardMenuCapabilities = { ...EVERYTHING, canReport: true };
  const NEARBY_REPORTING: BoardCardMenuCapabilities = { ...NEARBY, canReport: true };

  it('opens the trailing group with Report a problem on a board the viewer only follows', () => {
    expect(actionsOf(followed, REPORTING)).toEqual(['climb_here', 'pin', 'download', 'details', 'report', 'unfollow']);
    const report = boardCardMenuEntries(followed, REPORTING).find((entry) => entry.action === 'report');
    expect(report).toEqual({ action: 'report', destructive: false, dividerBefore: true, disabled: false });
  });

  it("offers it on Near you, where every board is another climber's", () => {
    expect(actionsOf(nearbyBoard, NEARBY_REPORTING)).toEqual(['climb_here', 'details', 'report']);
  });

  it("says Reported, disabled, once the viewer's own report is waiting", () => {
    const entries = boardCardMenuEntries({ ...followed, viewerHasOpenReport: true }, REPORTING);
    expect(entries.find((entry) => entry.action === 'reported')).toEqual({
      action: 'reported',
      destructive: false,
      dividerBefore: true,
      disabled: true,
    });
    expect(entries.some((entry) => entry.action === 'report')).toBe(false);
  });

  it('gives the creator and staff See reports instead, while a report waits on them', () => {
    expect(actionsOf({ ...owned, openReportCount: 2 }, REPORTING)).toEqual([
      'climb_here',
      'pin',
      'download',
      'details',
      'edit',
      'review_reports',
      'delete',
    ]);
    expect(actionsOf({ ...staffFollowed, openReportCount: 1 }, REPORTING)).toContain('review_reports');
  });

  it.each<[string, BoardCardMenuItemState]>([
    ['the creator', owned],
    ['staff who edit and remove it', staffFollowed],
    ['an editor who only removes it', editorFollowed],
    ['staff who delete a synced board', syncedAtYourGym],
  ])('offers no report to %s, who can fix it', (_who, item) => {
    const actions = actionsOf(item, REPORTING);
    expect(actions).not.toContain('report');
    expect(actions).not.toContain('reported');
  });

  it('offers nothing to report with the flag off, or on an unfinished import', () => {
    expect(actionsOf(followed, EVERYTHING)).not.toContain('report');
    expect(
      actionsOf({ ...importing, isViewerOwner: false, canEdit: false, canDelete: false }, REPORTING),
    ).not.toContain('report');
  });
});

describe('boardCardMenuAllows', () => {
  it('reads the server flags, and the owner-only rule only for a board read before them', () => {
    expect(boardCardMenuAllows(staffFollowed, 'edit')).toBe(true);
    expect(boardCardMenuAllows(staffFollowed, 'delete')).toBe(false);
    expect(boardCardMenuAllows(syncedAtYourGym, 'delete')).toBe(true);
    expect(boardCardMenuAllows({ ...owned, canDelete: false }, 'delete')).toBe(false);
    expect(boardCardMenuAllows(legacyOwned, 'delete')).toBe(true);
    expect(boardCardMenuAllows(legacyOwned, 'remove_from_gym')).toBe(false);
  });

  it('offers unfollow only on a board the viewer follows and does not own', () => {
    expect(boardCardMenuAllows(followed, 'unfollow')).toBe(true);
    expect(boardCardMenuAllows(owned, 'unfollow')).toBe(false);
    expect(boardCardMenuAllows(unknownOwner, 'unfollow')).toBe(false);
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
  removeFromGym: 'Remove from gym',
  removeFromNamedGym: (gymName) => `Remove from ${gymName}`,
  unfollow: 'Remove from your boards',
  delete: 'Delete',
  reviewReports: 'See reports',
  report: 'Report a problem',
  reported: 'Reported',
};

describe('boardCardMenuLabel', () => {
  it.each<[BoardCardMenuAction, string]>([
    ['climb_here', 'Climb here'],
    ['pin', 'Pin'],
    ['unpin', 'Unpin'],
    ['download', 'Download for offline'],
    ['details', 'Details'],
    ['edit', 'Edit board'],
    ['unfollow', 'Remove from your boards'],
    ['delete', 'Delete'],
    ['review_reports', 'See reports'],
    ['report', 'Report a problem'],
    ['reported', 'Reported'],
  ])('labels %s', (action, expected) => {
    expect(boardCardMenuLabel(action, LABELS, false)).toBe(expected);
  });

  it('names the gym a board comes off when it knows it', () => {
    expect(boardCardMenuLabel('remove_from_gym', LABELS, false, 'Crux')).toBe('Remove from Crux');
    expect(boardCardMenuLabel('remove_from_gym', LABELS, true, 'Crux')).toBe('Remove from Crux');
    expect(boardCardMenuLabel('remove_from_gym', LABELS, false, null)).toBe('Remove from gym');
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
      'review_reports',
      'report',
      'reported',
      'remove_from_gym',
      'unfollow',
      'delete',
    ];
    for (const action of actions) expect(BOARD_CARD_MENU_SYSTEM_ICONS[action]).toMatch(/\S/);
  });
});
