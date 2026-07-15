// Turning a downloaded board scope ("kilter:1:5") into something a human recognises.
//
// Pure and offline by construction: layout and product-size names are bundled static
// data in @boardsesh/board-constants, so this needs no network, no auth, and no warm
// cache. That matters — Manage Storage is the screen you open BECAUSE the device is
// full, quite possibly in a gym basement with no signal.
//
// It deliberately does NOT name the user's boards (via useMyBoards or otherwise). A
// download is keyed on (boardType, layoutId, sizeId), so two of your boards sharing a
// layout and size share ONE download — labelling the row "Marco's garage" and removing
// it would silently take the data behind "Gym wall" too. The layout+size is the honest
// unit of what's actually being removed.

import { formatBoardDisplayName, toBoardName } from '@boardsesh/board-config';
import { getLayoutName, getProductSize } from '@boardsesh/board-constants';
import { parseOfflineBoardKey } from '@boardsesh/offline-sync';

export type StorageBoardLabel = {
  /** The layout, e.g. "Kilter Board Original". Falls back to the board name. */
  title: string;
  /** The board and size, e.g. "Kilter · 12 x 14". */
  subtitle: string;
};

/**
 * Resolve a scope key to a display label, or null when the key itself is malformed
 * (a legacy or corrupt `syncEnabledBoards` entry — there are no rows behind it to
 * remove, so the caller skips the row entirely).
 *
 * Every other miss still yields a usable, REMOVABLE row: an unknown board type or a
 * layout newer than the bundled tables degrades to the ids rather than disappearing.
 * An orphaned scope is precisely the one a user most needs to reclaim, so it must
 * never be the one the UI can't render.
 *
 * `unknownScopeLabel` is injected rather than imported so this stays pure and
 * trivially testable; the screen passes the translated "Layout 12 · Size 30".
 */
export function storageBoardLabel(
  scopeKey: string,
  unknownScopeLabel: (parts: { layoutId: number; sizeId: number }) => string,
): StorageBoardLabel | null {
  const scope = parseOfflineBoardKey(scopeKey);
  if (!scope) return null;

  const boardDisplayName = formatBoardDisplayName(scope.boardType);
  const boardName = toBoardName(scope.boardType);
  const unknownScope = unknownScopeLabel({ layoutId: scope.layoutId, sizeId: scope.sizeId });

  // A board type board-constants doesn't know (a future board, or a corrupt entry).
  if (!boardName) {
    return { title: boardDisplayName, subtitle: unknownScope };
  }

  // getLayoutName returns '' for a layout the bundled tables predate.
  const layoutName = getLayoutName(boardName, scope.layoutId);
  const sizeName = getProductSize(boardName, scope.sizeId)?.name;

  if (!layoutName) {
    return { title: boardDisplayName, subtitle: unknownScope };
  }
  return {
    title: layoutName,
    subtitle: sizeName ? `${boardDisplayName} · ${sizeName}` : `${boardDisplayName} · ${unknownScope}`,
  };
}
