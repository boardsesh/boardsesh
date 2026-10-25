// Links that open the store app itself, by its custom URL scheme.
//
// Not `buildAppHandoffUrl` (`app-handoff.ts`): that one targets the browser app
// on app.boardsesh.com and drops the query string, and a Spraywall's `?wall=`
// capability is the query string. A scheme link only opens something when the
// app is installed, so it sits next to a store button, never alone.

import { WALL_CAPABILITY_PARAM } from '@/app/lib/spray/spray-visibility';

/** The custom scheme the store app registers: `scheme` in `packages/mobile/app.config.ts`. */
export const NATIVE_APP_SCHEME = 'com.boardsesh.app';

/**
 * `com.boardsesh.app://b/{slug}/{angle}/list`, plus `?wall=<uuid>` for an
 * unlisted Spraywall, which the app's `/b/[board_slug]/[angle]/list` route
 * hands to its board handoff exactly as it does for the universal link.
 */
export function buildNativeBoardListUrl(boardSlug: string, angle: number, wallUuid?: string): string {
  const path = `${NATIVE_APP_SCHEME}://b/${encodeURIComponent(boardSlug)}/${angle}/list`;
  return wallUuid ? `${path}?${WALL_CAPABILITY_PARAM}=${encodeURIComponent(wallUuid)}` : path;
}
