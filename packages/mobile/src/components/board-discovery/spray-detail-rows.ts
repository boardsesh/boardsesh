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

/** The board fields the gate reads. Structural so a partial board works uncast. */
export type SprayDetailRowBoard = {
  uuid: string;
  boardType: string;
  canEdit?: boolean;
};

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
