// The wall-maintenance rows in the board-detail sheet.
//
// Kept out of the component so the gate is one pure function with one test,
// rather than a `&&` chain inside JSX that no test can reach without mounting a
// bottom sheet. The gate is the interesting part: these rows lead into screens
// the server refuses for anyone it does not allow, so showing one to a climber
// who merely follows someone's wall is a dead end.
//
// Two different permissions, on purpose:
//
//  - Editing holds reads `canEdit`, the server's own answer to "may this viewer
//    change this board": the owner, a gym owner/admin of the gym the wall is
//    attached to, or a community admin (`canEditBoard` in
//    `packages/backend/src/graphql/resolvers/board/spray-walls.ts`).
//  - Resetting is the OWNER's call alone (`SPRAY_WALL_RESET_OWNER_ONLY`): it
//    replaces the wall and archives this one. So it reads `ownerId` against the
//    signed-in viewer. `isOwned` is a different question ("I own the physical
//    board") and is never used here.
//
// And one rule from the wall itself (`docs/spray-walls.md`, "Archive and reset"):
// holds are free to edit until the wall has its first published climb. After
// that they are locked, and changing a hold means resetting the wall. An
// archived wall offers none of these: it is read-only.

import { toBoardName } from '@boardsesh/board-config';
import type { IconName } from '../icon-map';
import { sprayHoldEditorHref, sprayResetWizardHref } from '../../lib/spray/spray-routes';
import type { SprayWallArchiveState } from '../../lib/spray/spray-wall-registry';
import { buildSprayWallShareUrl, sprayWallVisibility, type SprayWallVisibility } from '../../lib/spray/spray-share';

/** The board fields the gate reads. Structural so a partial board works uncast. */
export type SprayDetailRowBoard = {
  uuid: string;
  boardType: string;
  canEdit?: boolean;
  /** The wall owner's user id. Reset is offered only when it is the viewer's. */
  ownerId?: string;
};

/**
 * What the rows need beyond the board row: who is looking, and the wall's
 * archive state from the registry (`useSprayWallArchiveState`).
 *
 * `archive` is null until the wall has registered from its published version,
 * and every row waits for it: whether holds are locked, and whether the wall is
 * archived, is not something to guess.
 */
export type SprayDetailRowContext = {
  viewerUserId: string | null | undefined;
  archive: SprayWallArchiveState | null;
};

/** The board fields the share gate reads, on top of the ones above. */
export type SprayShareBoard = SprayDetailRowBoard & {
  slug: string;
  angle: number;
  name: string;
  isPublic: boolean;
  isUnlisted: boolean;
};

export type SprayShareTarget = {
  url: string;
  /** What the link grants — the sheet says so in words, and they differ. */
  visibility: Exclude<SprayWallVisibility, 'private'>;
};

/**
 * The share link for one wall, or `null` when there is nothing to share.
 *
 * Null on every catalogue board (they have their own slug routes and no wall
 * capability to hand out) and, deliberately, on a PRIVATE wall: a private wall's
 * link resolves for nobody, so offering one would be a promise the server
 * refuses. The way to get a link is to make the wall shareable on the edit
 * screen, which is where that decision — and its consequences — belong.
 *
 * No `canEdit` gate. A wall you can already open is a wall you can already tell a
 * friend about; the link grants exactly the access the viewer has.
 */
export function sprayShareTarget(board: SprayShareBoard | null | undefined): SprayShareTarget | null {
  if (!board) return null;
  if (toBoardName(board.boardType) !== 'spray') return null;

  const visibility = sprayWallVisibility(board);
  if (visibility === 'private') return null;

  const url = buildSprayWallShareUrl({
    slug: board.slug,
    angle: board.angle,
    // A wall's uuid IS its board uuid (`SprayWall.uuid`), which is what makes the
    // `?wall=` capability resolvable by `sprayWall(uuid:)`.
    wallUuid: board.uuid,
    isPublic: board.isPublic,
    isUnlisted: board.isUnlisted,
  });
  return url ? { url, visibility } : null;
}

/**
 * - `editHolds`: open the hold editor.
 * - `holdsLocked`: says the holds are locked. Opens the reset confirm for the
 *   owner, and does nothing for anyone else.
 * - `resetWall`: the owner's reset, behind a confirm.
 */
export type SprayDetailRowKey = 'editHolds' | 'holdsLocked' | 'resetWall';

export type SprayDetailRow = {
  key: SprayDetailRowKey;
  icon: IconName;
  /** Where the row leads once it is confirmed, or null for a row that only informs. */
  href: string | null;
  /** The row asks "Reset this wall?" before it navigates. */
  confirmsReset: boolean;
};

/** Whether the signed-in viewer owns this wall. False when either id is missing. */
export function viewerOwnsSprayWall(
  board: Pick<SprayDetailRowBoard, 'ownerId'>,
  viewerUserId: string | null | undefined,
): boolean {
  return typeof board.ownerId === 'string' && board.ownerId.length > 0 && board.ownerId === viewerUserId;
}

/**
 * The maintenance rows for one board, in display order. None on a catalogue
 * board, on a wall not registered yet, or on an archived wall.
 *
 * | Viewer            | Holds free | Holds locked              |
 * | ----------------- | ---------- | ------------------------- |
 * | owner             | edit, reset | locked (opens reset), reset |
 * | editor, not owner | edit       | locked (information only) |
 * | anyone else       | none       | none                      |
 *
 * Returns a fresh array, so call it from the sheet's `useMemo` rather than from a
 * row. It is O(1) either way.
 */
export function sprayDetailRows(
  board: SprayDetailRowBoard | null | undefined,
  { viewerUserId, archive }: SprayDetailRowContext,
): SprayDetailRow[] {
  if (!board || !archive) return [];
  if (toBoardName(board.boardType) !== 'spray') return [];
  if (archive.archivedAt != null) return [];
  const isOwner = viewerOwnsSprayWall(board, viewerUserId);
  const canEdit = board.canEdit === true;
  const rows: SprayDetailRow[] = [];
  if (canEdit && !archive.holdsLocked) {
    rows.push({ key: 'editHolds', icon: 'edit', href: sprayHoldEditorHref(board.uuid), confirmsReset: false });
  }
  if ((canEdit || isOwner) && archive.holdsLocked) {
    rows.push({
      key: 'holdsLocked',
      icon: 'lock',
      href: isOwner ? sprayResetWizardHref(board.uuid) : null,
      confirmsReset: isOwner,
    });
  }
  if (isOwner) {
    rows.push({
      key: 'resetWall',
      icon: 'camera',
      href: sprayResetWizardHref(board.uuid),
      confirmsReset: true,
    });
  }
  return rows;
}
