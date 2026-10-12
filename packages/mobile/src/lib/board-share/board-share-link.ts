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

export type HomeBoardShareTarget =
  | { kind: 'plain'; url: string; visibility: 'public' | 'unlisted' }
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
  if (board.isUnlisted) return { kind: 'plain', url: buildPlainBoardShareUrl(board.slug), visibility: 'unlisted' };
  if (board.isPublic) return { kind: 'plain', url: buildPlainBoardShareUrl(board.slug), visibility: 'public' };
  const isOwner = typeof board.ownerId === 'string' && board.ownerId.length > 0 && board.ownerId === viewerUserId;
  if (!isOwner) return null;
  if (audience !== 'followers' && audience !== 'invite_only') return null;
  return { kind: 'invite', boardUuid: board.uuid };
}
