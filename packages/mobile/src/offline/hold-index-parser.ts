import { HOLD_STATE_MAP, parseFramesToHoldRows } from '@boardsesh/board-constants/hold-states';
import type { HoldIndexSyncOptions, HoldRowParser } from '@boardsesh/offline-sync';
import type { BoardName } from '@boardsesh/shared-schema';
import { addErrorBreadcrumb } from '../lib/error-reporting';

function isKnownBoard(boardType: string): boardType is BoardName {
  return Object.prototype.hasOwnProperty.call(HOLD_STATE_MAP, boardType);
}

/**
 * The frames parser the offline engine's holds index runs (see
 * `@boardsesh/offline-sync` → holds-index/hold-index.ts). The engine has no
 * runtime dependencies, so it takes the parser as a parameter; this is the one
 * place mobile binds it.
 *
 * A board type with no role table yields no rows rather than a guess: its
 * climbs are simply absent from the index, which reads as "no similar climbs",
 * never as wrong holds.
 */
export const parseHoldRows: HoldRowParser = (boardType, frames) =>
  isKnownBoard(boardType) ? parseFramesToHoldRows(boardType, frames) : [];

/**
 * What the sync cycle is handed: the parser, plus a breadcrumb when a build
 * throws. A breadcrumb and not an error report, because the index is derived
 * data the next cycle (or the reader that needs it) rebuilds, and a contended
 * write lock is the expected way for one chunk to lose.
 */
export const holdIndexSyncOptions: HoldIndexSyncOptions = {
  parseHoldRows,
  onError: (error, scopeKey) => {
    addErrorBreadcrumb({
      category: 'offline-sync',
      message: 'holds index build failed',
      level: 'warning',
      data: { scopeKey, error: error instanceof Error ? error.message : String(error) },
    });
  },
};
