// The `?wall=<uuid>` capability on a share link, read at the front door.
//
// A slug route (`/b/{slug}` and `/b/{slug}/{angle}/list`) resolves its board from
// the slug and then, on a spray wall, asks `sprayWallByLayout` for the wall. That
// query refuses an unlisted wall to anyone but its owner or the gym's members, so
// a crew member following the link would land on a board with no art. Redeeming
// the uuid first puts the wall in the same cache entry, and the rest of the render
// path is unchanged.
//
// Deliberately fire-and-forget. The wall is one input to the screen, not the
// screen: a failed redemption leaves the board rendering its placeholder exactly
// as it does today, which is also what a stale or revoked link should do.

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { adoptSprayWallFromLink } from './spray-wall-loader';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a search param is shaped like the uuid a share link carries. */
export function isWallUuidParam(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Redeem a share link's `?wall=` param, once per uuid.
 *
 * Anything that is not a uuid is ignored rather than sent — a hand-edited param
 * is not worth a round trip, and the server would only reject it.
 */
export function useSprayWallFromLink(wallParam: string | string[] | undefined): void {
  const queryClient = useQueryClient();
  const wallUuid = Array.isArray(wallParam) ? wallParam[0] : wallParam;

  useEffect(() => {
    if (!isWallUuidParam(wallUuid)) return;
    void adoptSprayWallFromLink(queryClient, wallUuid).catch(() => {
      // Offline, or the wall is gone. The board falls back to its placeholder.
    });
  }, [queryClient, wallUuid]);
}
