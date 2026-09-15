// The wall-maintenance rows in the board-detail sheet.
//
// Kept out of the component so the gate is one pure function with one test,
// rather than a `&&` chain inside JSX that no test can reach without mounting a
// bottom sheet. The gate is the interesting part: these rows expose the two
// destructive-ish things you can do to a wall, and showing them to a climber who
// merely follows someone's wall is a route into a screen the server will refuse.
//
// Why `canEdit` and not `isOwned`: `canEdit` is the server's own answer to
// "may this viewer change this board" — the owner, a gym owner/admin of the gym
// the wall is attached to, or a community admin. The spray API gates every
// version mutation on exactly that rule (`canEditBoard` in
// `packages/backend/src/graphql/resolvers/board/spray-walls.ts`), so reading the
// same field is what keeps the affordance and the permission from drifting apart.
// `isOwned` is a different question entirely — it means "this is my wall, not one
// I follow" and is true for boards the viewer cannot edit.

import { toBoardName } from '@boardsesh/board-config';
import type { IconName } from '../icon-map';
import { sprayHoldEditorHref, sprayResetHref } from '../../lib/spray/spray-routes';
import { buildSprayWallShareUrl, sprayWallVisibility, type SprayWallVisibility } from '../../lib/spray/spray-share';

/** The board fields the gate reads. Structural so a partial board works uncast. */
export type SprayDetailRowBoard = {
  uuid: string;
  boardType: string;
  canEdit?: boolean;
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

export type SprayDetailRowKey = 'editHolds' | 'newPhoto';

export type SprayDetailRow = {
  key: SprayDetailRowKey;
  icon: IconName;
  /** Where the row navigates. */
  href: string;
};

/**
 * The owner rows for one board: two on a spray wall the viewer may edit, none
 * anywhere else.
 *
 * Returns a fresh array, so call it from the sheet's `useMemo` rather than from a
 * row. It is O(1) either way — the cost that matters is the re-render, not the
 * allocation.
 */
export function sprayDetailRows(board: SprayDetailRowBoard | null | undefined): SprayDetailRow[] {
  if (!board) return [];
  if (toBoardName(board.boardType) !== 'spray') return [];
  if (board.canEdit !== true) return [];
  return [
    {
      key: 'editHolds',
      icon: 'edit',
      href: sprayHoldEditorHref(board.uuid),
    },
    {
      key: 'newPhoto',
      icon: 'camera',
      href: sprayResetHref(board.uuid),
    },
  ];
}
