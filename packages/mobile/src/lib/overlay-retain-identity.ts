// The identity a retained overlay is allowed to bridge across.
//
// `LayeredClimbImage` keeps the previous overlay on screen while a replacement
// renders, but only while the BOARD is the same — bridging across a board switch
// would paint one wall's holds over another's art. That identity used to be a
// literal in `BoardImageNative`; it lives here so the spray-wall version can be
// folded in and the rule can be tested without rendering a native board.

import { sprayCacheToken } from './spray/spray-wall-registry';

/**
 * `"<boardName>-<layoutId>-<sizeId>-<setIds>"`, plus the wall version for a spray
 * board (`''` for every catalogue one, so no existing bridge changes).
 *
 * The version is in it because a reset IS a different board as far as bridging
 * goes: the photograph is new and the hold generation is new, so retaining across
 * one would hold the superseded overlay over the new photo — the same staleness
 * the cache keys prevent on disk, on screen for as long as the replacement takes.
 */
export function overlayRetainIdentity(boardName: string, layoutId: number, sizeId: number, setIds: string): string {
  return `${boardName}-${layoutId}-${sizeId}-${setIds}${sprayCacheToken(boardName, layoutId)}`;
}
