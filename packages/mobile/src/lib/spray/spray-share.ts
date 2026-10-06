// The link you hand a friend so they can climb on your wall.
//
// Two rules make this more than string concatenation:
//
//  1. **A private wall has no link.** Nobody but its owner can open it, so
//     producing a URL would only promise something the server refuses. `null` is
//     the answer, and every caller uses it as the gate on the share affordance.
//  2. **An unlisted wall carries its uuid.** `sprayWallByLayout` deliberately
//     returns null for an unlisted wall — a layout id is a sequence number, so
//     resolving one there would make every unlisted wall enumerable. `sprayWall(uuid)`
//     does resolve it, so the `?wall=` param is the capability that lets the link
//     work: holding it is the proof you were given the link. A public wall needs
//     no capability and gets a clean URL.

import { generateSlugFromText } from '@boardsesh/play-view/readable-url-utils';
import { WEB_BASE_URL } from '../env';

export type SprayWallVisibility = 'private' | 'unlisted' | 'public';

/**
 * The wall's visibility as one value.
 *
 * `isPublic` wins: the two flags are independent booleans on the board row, and a
 * wall that is both is world-readable however it got there.
 */
export function sprayWallVisibility(flags: { isPublic: boolean; isUnlisted: boolean }): SprayWallVisibility {
  if (flags.isPublic) return 'public';
  if (flags.isUnlisted) return 'unlisted';
  return 'private';
}

export type SprayWallShareTarget = {
  /** The board's slug — what `/b/{slug}` routes on. */
  slug: string;
  /** The wall's angle. Omitted (or null) lands on the board's own stored angle. */
  angle?: number | null;
  /** The wall's uuid, which is its board uuid (`SprayWall.uuid`). */
  wallUuid: string;
  isPublic: boolean;
  isUnlisted: boolean;
};

/**
 * The shareable https URL for one wall, or `null` when the wall is private.
 *
 * Universal Links route this into the app when it's installed; the web route is
 * the fallback. It follows `WEB_BASE_URL` so a staging build hands out links to
 * its own deployment.
 */
export function buildSprayWallShareUrl({
  slug,
  angle,
  wallUuid,
  isPublic,
  isUnlisted,
}: SprayWallShareTarget): string | null {
  const visibility = sprayWallVisibility({ isPublic, isUnlisted });
  if (visibility === 'private') return null;

  const board = `${WEB_BASE_URL}/b/${encodeURIComponent(slug)}`;
  const url = angle == null ? board : `${board}/${encodeURIComponent(String(angle))}/list`;

  return visibility === 'unlisted' ? `${url}?wall=${encodeURIComponent(wallUuid)}` : url;
}

export type SprayClimbShareTarget = {
  /** The wall's board slug, or null/undefined when the app does not hold it yet. */
  slug: string | null | undefined;
  angle: number;
  climbUuid: string;
  climbName?: string | null;
  wallUuid: string;
  isPublic: boolean;
  isUnlisted: boolean;
};

/**
 * The path (no origin) that opens one climb on a wall: `/b/{slug}/{angle}/view/{name-slug}-{uuid}`.
 *
 * A wall has no config-tuple URL that www can render — `/spray/{layout}/...`
 * 404s there by design — so the board slug is the only address a climb on it
 * has. The climb segment is byte-for-byte what www's `constructBoardSlugViewUrl`
 * emits, and both hosts read the uuid back out of it with
 * `extractUuidFromClimbSegment`, so a name that slugs to nothing falls back to
 * the bare uuid exactly as web does.
 *
 * The rules {@link buildSprayWallShareUrl} follows, plus the missing-slug case:
 *  - `null` for a private wall. www answers 404 for it, so the link would only
 *    promise something nobody else can open.
 *  - `null` without a slug. Falling back to the numeric path would hand out the
 *    exact dead link this exists to replace.
 *  - An unlisted wall carries `?wall=`, which the app redeems so a crew member
 *    who is not the owner still gets the wall's photo. www ignores it: an
 *    unlisted wall renders at its slug for anyone holding the link.
 */
export function buildSprayClimbSharePath({
  slug,
  angle,
  climbUuid,
  climbName,
  wallUuid,
  isPublic,
  isUnlisted,
}: SprayClimbShareTarget): string | null {
  if (!slug) return null;
  const visibility = sprayWallVisibility({ isPublic, isUnlisted });
  if (visibility === 'private') return null;

  const nameSlug = climbName ? generateSlugFromText(climbName) : '';
  const climbSegment = nameSlug ? `${nameSlug}-${climbUuid}` : climbUuid;
  const path = `/b/${encodeURIComponent(slug)}/${encodeURIComponent(String(angle))}/view/${encodeURIComponent(climbSegment)}`;

  return visibility === 'unlisted' ? `${path}?wall=${encodeURIComponent(wallUuid)}` : path;
}
