// What the Near you list says when the Bluetooth quickstart's "Find it at my
// gym" has narrowed it to one board type, shared by the list's title (the
// picker screen) and its empty line (NearbySearchStatus).
//
// MoonBoard gets its own keys because "{{board}} boards" reads wrong for it in
// every locale ("MoonBoard boards"). Every other type goes through
// `formatBoardDisplayName`, which spells each brand as it is written (Kilter,
// Tension, So iLL), never the lowercase board id.

import type { TFunction } from 'i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { formatBoardDisplayName } from '@boardsesh/board-config';

/** "Near you", or "MoonBoards near you" / "Kilter boards near you" when narrowed. */
export function nearbyListTitle(t: TFunction<'boards'>, boardType: BoardName | null): string {
  if (!boardType) return t('mobile.discovery.nearbyTitle');
  if (boardType === 'moonboard') return t('mobile.discovery.nearbyTitleMoonboard');
  return t('mobile.discovery.nearbyTitleType', { board: formatBoardDisplayName(boardType) });
}

/**
 * "Nothing within 20 km", or which type there is none of when narrowed: in a
 * gym full of other boards "Nothing within 20 km" would be false.
 */
export function nearbyEmptyLine(t: TFunction<'boards'>, boardType: BoardName | null): string {
  if (!boardType) return t('mobile.firstBoard.nearbyEmpty');
  if (boardType === 'moonboard') return t('mobile.firstBoard.nearbyEmptyMoonboard');
  return t('mobile.firstBoard.nearbyEmptyType', { board: formatBoardDisplayName(boardType) });
}
