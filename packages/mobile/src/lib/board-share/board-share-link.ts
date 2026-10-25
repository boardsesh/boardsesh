// The link you hand a friend so they can climb on your home board.
//
// What the link is depends on who can open the board:
//
//  - Public and Unlisted: the plain `/b/{slug}` link. Public is on the open web
//    already; Unlisted is reachable by anyone holding the link, so the slug is
//    enough and nothing has to be minted.
//  - Followers and Invite-only: `/b/{slug}?invite={token}`, owner only. The
//    token is minted server-side (`boardShareLink`), and confirming Join while signed
//    in makes the climber an approved member (`redeemBoardShareLink`).
//    A follower passing on the plain link would only hand out a not-found, so a
//    non-owner gets no share row on these boards.
//  - Only me: no link. It is a private notebook.
//
// Spray walls keep their own rules and `?wall=` link (`spray-share.ts`).
//
// The token is a capability. It goes into the URL the owner shares and into the
// redeem request, and nowhere else: never a log line, an analytics property or
// a toast.

import { toBoardName } from '@boardsesh/board-config';
import type { PrivacyResourceAudience } from '@boardsesh/graphql/operations/privacy';
import { WEB_BASE_URL } from '../env';

/** The query parameter a board share link carries its token in. */
export const BOARD_INVITE_PARAM = 'invite';

/** 128 random bits in base64url without padding: always 22 characters. */
const INVITE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** Whether a URL value is shaped like a share-link token. Anything else is dropped unread. */
export function isBoardInviteToken(value: unknown): value is string {
  return typeof value === 'string' && INVITE_TOKEN_SHAPE.test(value);
}

/** The full URL for a path the backend returned (`/b/{slug}?invite={token}`). */
export function buildBoardShareUrl(path: string): string {
  return `${WEB_BASE_URL}${path}`;
}

/** The plain link for a board anyone holding it may open. */
export function buildPlainBoardShareUrl(slug: string): string {
  return `${WEB_BASE_URL}/b/${encodeURIComponent(slug)}`;
}

/**
 * The www print page for a board's wall poster (#4415): `/poster/b/{slug}`.
 * Callers gate it first; this only builds the URL. A Spraywall's own gate and
 * `?wall=` live in `buildSprayWallPosterUrl` (spray-share.ts).
 */
export function buildBoardPosterPageUrl(slug: string): string {
  return `${WEB_BASE_URL}/poster/b/${encodeURIComponent(slug)}`;
}

/**
 * The poster page for a home board, or `null` when the board can't have one.
 *
 * Only Public and Unlisted, the two whose plain `/b/{slug}` link opens for
 * anyone holding it, which is the link the printed code encodes. A Followers or
 * Invite-only board would need its `?invite=` token on the wall, and a token
 * taped to a wall is no longer an invite, so those get no poster. Spraywalls
 * have their own builder.
 */
export function buildHomeBoardPosterUrl(
  board: Pick<HomeBoardShareBoard, 'slug' | 'boardType' | 'isPublic' | 'isUnlisted'> | null | undefined,
): string | null {
  if (!board?.slug || toBoardName(board.boardType) === 'spray') return null;
  if (!board.isPublic && !board.isUnlisted) return null;
  return buildBoardPosterPageUrl(board.slug);
}

export type HomeBoardShareTarget =
  | {
      kind: 'plain';
      url: string;
      visibility: 'public' | 'unlisted';
      /** The print page for the board's wall poster (`buildHomeBoardPosterUrl`). */
      posterUrl: string | null;
    }
  | { kind: 'invite'; boardUuid: string };

/** The board fields the gate reads. Structural so a partial board works uncast. */
export type HomeBoardShareBoard = {
  uuid: string;
  slug: string;
  boardType: string;
  ownerId?: string | null;
  isPublic: boolean;
  isUnlisted: boolean;
};

/**
 * What the board detail sheet's share row hands out, or `null` for no row.
 *
 * `audience` is the owner's own `resourcePrivacy` answer, which only the owner
 * can read; it is what tells Followers and Invite-only apart from Only me,
 * since all three store the same legacy booleans. Until it arrives the owner
 * sees no row rather than a guess.
 *
 * Unlisted wins over Public when a row carries both flags, the same reading the
 * backend's `getResourcePrivacy` gives a home board.
 */
export function homeBoardShareTarget(
  board: HomeBoardShareBoard | null | undefined,
  viewerUserId: string | null | undefined,
  audience: PrivacyResourceAudience | null | undefined,
): HomeBoardShareTarget | null {
  if (!board || toBoardName(board.boardType) === 'spray') return null;
  const posterUrl = buildHomeBoardPosterUrl(board);
  if (board.isUnlisted) {
    return { kind: 'plain', url: buildPlainBoardShareUrl(board.slug), visibility: 'unlisted', posterUrl };
  }
  if (board.isPublic)
    return { kind: 'plain', url: buildPlainBoardShareUrl(board.slug), visibility: 'public', posterUrl };
  const isOwner = typeof board.ownerId === 'string' && board.ownerId.length > 0 && board.ownerId === viewerUserId;
  if (!isOwner) return null;
  if (audience !== 'followers' && audience !== 'invite_only') return null;
  return { kind: 'invite', boardUuid: board.uuid };
}
