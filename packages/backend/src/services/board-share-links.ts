import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import * as schema from '@boardsesh/db/schema';
import type { PrivacyResourceAudience } from '@boardsesh/privacy';
import { db } from '../db/client';
import { getPostgresErrorCode } from '../utils/postgres-errors';

/**
 * A home board's share link: `/b/{slug}?invite={token}`.
 *
 * The owner's Share sheet hands it out for a Followers or Invite-only board.
 * A signed-in climber who opens it and then chooses Join gets the same approved
 * `resource_grants` row an owner's name invite writes, with `invited_by` set to
 * the owner, so they read the board, its presence and its sessions on the next
 * request and the owner can remove them from the access screen as before.
 * Opening, previewing or signing in through the link grants nothing.
 *
 * Rules, each one a test in `board-share-links.test.ts`:
 *  - Only Followers and Invite-only boards have a link. Public and Unlisted
 *    boards are already reachable by their plain `/b/{slug}` link; an Only-me
 *    board is a private notebook. Spray walls keep their own `?wall=` link.
 *  - One active link per board (a partial unique index). Reset revokes it and
 *    mints another; a revoked or unknown token answers NOT_FOUND.
 *  - Moving a board out of Followers/Invite-only revokes its link, so an old
 *    link does not come back to life when the board is made shareable again.
 *  - A climber the owner removed (a `revoked` grant) stays removed: the link
 *    does not override the owner's decision about one person.
 *  - The token never reaches a log line or an analytics event. Callers pass
 *    it to these functions and to nothing else, and every statement that
 *    carries it as a parameter goes through `withoutTokenInErrors`: drizzle's
 *    failure message is `Failed query: … params: <token>`, and the Yoga logger
 *    and the Sentry mask would otherwise record it during a database outage.
 *  - Lock order matches `updateResourcePrivacy` and the other privacy writers:
 *    the owner's `users` row, then the board row. The link and grant inserts
 *    take a key-share lock on the owner's row through their foreign keys, so
 *    taking the board first would deadlock against an audience change.
 */

/** The query parameter the link carries the token in. */
export const BOARD_INVITE_PARAM = 'invite';

/** 128 random bits in base64url, no padding: always 22 characters. */
const SHARE_TOKEN_BYTES = 16;
const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

const SHAREABLE_AUDIENCES: ReadonlySet<PrivacyResourceAudience> = new Set(['followers', 'invite_only']);

export function isShareLinkAudience(audience: PrivacyResourceAudience | null | undefined): boolean {
  return !!audience && SHAREABLE_AUDIENCES.has(audience);
}

/** Cheap shape check before any database read: a malformed token opens nothing. */
export function isBoardShareTokenShape(token: unknown): token is string {
  return typeof token === 'string' && SHARE_TOKEN_SHAPE.test(token);
}

export function mintBoardShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

export function boardShareLinkPath(slug: string, token: string): string {
  return `/b/${encodeURIComponent(slug)}?${BOARD_INVITE_PARAM}=${token}`;
}

export type BoardShareLink = {
  boardUuid: string;
  token: string;
  path: string;
  createdAt: string;
};

export type BoardShareLinkRedemption = {
  boardUuid: string;
  slug: string;
  /** Whether this call wrote or upgraded a grant. A repeat redemption is a no-op. */
  granted: boolean;
};

type ShareTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ShareExecutor = Pick<typeof db, 'select' | 'update'>;

function notFound(): never {
  throw new GraphQLError('Not found', { extensions: { code: 'NOT_FOUND' } });
}

/**
 * Run `work` and replace any database failure with one that carries only its
 * SQLSTATE. The mask in `graphql/mask-error.ts` still sees a database error by
 * that code (and answers an outage with a 503); the SQL, the parameters and the
 * driver message, any of which can hold the token, are gone. Our own
 * GraphQLErrors (NOT_FOUND) pass through untouched.
 */
export async function withoutTokenInErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    const code = getPostgresErrorCode(error);
    throw Object.assign(new Error(`Board share link query failed${code ? ` (${code})` : ''}`), code ? { code } : {});
  }
}

function toShareLink(slug: string, row: { token: string; boardUuid: string; createdAt: Date }): BoardShareLink {
  return {
    boardUuid: row.boardUuid,
    token: row.token,
    path: boardShareLinkPath(slug, row.token),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The board row, locked, and whether its stored audience lets it have a link.
 *
 * A board without a `resource_privacy` row reads its audience from the legacy
 * booleans, which only ever say Public, Unlisted or Only me, so a shareable
 * board always has a policy row. Reading it inside the transaction, after the
 * lock, serializes with `updateResourcePrivacy`, which locks the same row.
 */
async function lockBoardForSharing(transaction: ShareTransaction, boardUuid: string, ownerId: string) {
  // Owner first, board second: see the lock-order rule at the top.
  await transaction
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .for('key share');
  const [board] = await transaction
    .select({
      uuid: schema.userBoards.uuid,
      slug: schema.userBoards.slug,
      ownerId: schema.userBoards.ownerId,
      boardType: schema.userBoards.boardType,
    })
    .from(schema.userBoards)
    .where(and(eq(schema.userBoards.uuid, boardUuid), isNull(schema.userBoards.deletedAt)))
    .for('update');
  // Gone, or changed hands while this transaction waited: the caller's view of
  // who owns it is stale, so nothing here applies.
  if (!board || board.ownerId !== ownerId) return null;
  const [policy] = await transaction
    .select({ audience: schema.resourcePrivacy.audience })
    .from(schema.resourcePrivacy)
    .where(and(eq(schema.resourcePrivacy.kind, 'board'), eq(schema.resourcePrivacy.resourceId, boardUuid)))
    .limit(1);
  const shareable = board.boardType !== 'spray' && isShareLinkAudience(policy?.audience);
  return { ...board, shareable };
}

async function activeShareLinkRow(executor: Pick<typeof db, 'select'>, boardUuid: string) {
  const [row] = await executor
    .select({
      token: schema.boardShareLinks.token,
      boardUuid: schema.boardShareLinks.boardUuid,
      createdAt: schema.boardShareLinks.createdAt,
    })
    .from(schema.boardShareLinks)
    .where(and(eq(schema.boardShareLinks.boardUuid, boardUuid), isNull(schema.boardShareLinks.revokedAt)))
    .limit(1);
  return row;
}

/** Stamp `revoked_at` on the board's active link, if it has one. */
export async function revokeBoardShareLinks(executor: ShareExecutor, boardUuid: string): Promise<void> {
  await executor
    .update(schema.boardShareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.boardShareLinks.boardUuid, boardUuid), isNull(schema.boardShareLinks.revokedAt)));
}

/**
 * The owner's current link, minted on first read. `null` for a board that has
 * no link (see the rules above). NOT_FOUND for a board the caller does not own.
 */
export async function getOrCreateBoardShareLink(boardUuid: string, ownerId: string): Promise<BoardShareLink | null> {
  return withoutTokenInErrors(() =>
    db.transaction(async (transaction) => {
      const board = await lockBoardForSharing(transaction, boardUuid, ownerId);
      if (!board) notFound();
      if (!board.shareable) return null;
      const existing = await activeShareLinkRow(transaction, boardUuid);
      if (existing) return toShareLink(board.slug, existing);
      const [created] = await transaction
        .insert(schema.boardShareLinks)
        .values({ token: mintBoardShareToken(), boardUuid, createdBy: ownerId })
        .returning({
          token: schema.boardShareLinks.token,
          boardUuid: schema.boardShareLinks.boardUuid,
          createdAt: schema.boardShareLinks.createdAt,
        });
      return toShareLink(board.slug, created);
    }),
  );
}

/** Revoke the board's link and mint a new one. Same answers as the read above. */
export async function resetBoardShareLink(boardUuid: string, ownerId: string): Promise<BoardShareLink | null> {
  return withoutTokenInErrors(() =>
    db.transaction(async (transaction) => {
      const board = await lockBoardForSharing(transaction, boardUuid, ownerId);
      if (!board) notFound();
      if (!board.shareable) return null;
      await revokeBoardShareLinks(transaction, boardUuid);
      const [created] = await transaction
        .insert(schema.boardShareLinks)
        .values({ token: mintBoardShareToken(), boardUuid, createdBy: ownerId })
        .returning({
          token: schema.boardShareLinks.token,
          boardUuid: schema.boardShareLinks.boardUuid,
          createdAt: schema.boardShareLinks.createdAt,
        });
      return toShareLink(board.slug, created);
    }),
  );
}

/**
 * Make `userId` an approved member of the board the token names.
 *
 * NOT_FOUND, with nothing written, for: a malformed, unknown or revoked token;
 * a deleted board; a board that is no longer Followers or Invite-only; and a
 * climber the owner removed. The owner opening their own link is a no-op.
 */
export async function redeemBoardShareLink(token: string, userId: string): Promise<BoardShareLinkRedemption> {
  if (!isBoardShareTokenShape(token)) notFound();
  return withoutTokenInErrors(() =>
    db.transaction(async (transaction) => {
      // Unlocked read for the board and its owner, so the locks below can be taken
      // in the shared order. Everything it said is checked again under them.
      const [link] = await transaction
        .select({ boardUuid: schema.boardShareLinks.boardUuid, ownerId: schema.userBoards.ownerId })
        .from(schema.boardShareLinks)
        .innerJoin(schema.userBoards, eq(schema.userBoards.uuid, schema.boardShareLinks.boardUuid))
        .where(and(eq(schema.boardShareLinks.token, token), isNull(schema.boardShareLinks.revokedAt)))
        .limit(1);
      if (!link) notFound();
      const board = await lockBoardForSharing(transaction, link.boardUuid, link.ownerId);
      if (!board || !board.shareable) notFound();
      // Asked again under the board lock: a reset that committed while this
      // transaction waited for it has revoked the token.
      const [stillActive] = await transaction
        .select({ token: schema.boardShareLinks.token })
        .from(schema.boardShareLinks)
        .where(and(eq(schema.boardShareLinks.token, token), isNull(schema.boardShareLinks.revokedAt)))
        .limit(1);
      if (!stillActive) notFound();
      if (board.ownerId === userId) return { boardUuid: board.uuid, slug: board.slug, granted: false };

      const [grant] = await transaction
        .select({ status: schema.resourceGrants.status })
        .from(schema.resourceGrants)
        .where(
          and(
            eq(schema.resourceGrants.kind, 'board'),
            eq(schema.resourceGrants.resourceId, board.uuid),
            eq(schema.resourceGrants.userId, userId),
          ),
        )
        .for('update');
      if (grant?.status === 'revoked') notFound();
      if (grant?.status === 'approved') return { boardUuid: board.uuid, slug: board.slug, granted: false };

      const written = await transaction
        .insert(schema.resourceGrants)
        .values({ kind: 'board', resourceId: board.uuid, userId, status: 'approved', invitedBy: board.ownerId })
        .onConflictDoUpdate({
          target: [schema.resourceGrants.kind, schema.resourceGrants.resourceId, schema.resourceGrants.userId],
          set: { status: 'approved', invitedBy: board.ownerId, updatedAt: new Date() },
          // A removal inserted after the read above (there was no row to lock) still wins.
          setWhere: sql`${schema.resourceGrants.status} <> 'revoked'`,
        })
        .returning({ status: schema.resourceGrants.status });
      if (written.length === 0) notFound();
      return { boardUuid: board.uuid, slug: board.slug, granted: true };
    }),
  );
}

/** The board's name for a signed-out visitor holding an active link, or null. */
export async function previewBoardShareLink(token: string): Promise<{ name: string } | null> {
  if (!isBoardShareTokenShape(token)) return null;
  const [row] = await withoutTokenInErrors(() =>
    db
      .select({
        name: schema.userBoards.name,
        boardType: schema.userBoards.boardType,
        audience: schema.resourcePrivacy.audience,
      })
      .from(schema.boardShareLinks)
      .innerJoin(schema.userBoards, eq(schema.userBoards.uuid, schema.boardShareLinks.boardUuid))
      .leftJoin(
        schema.resourcePrivacy,
        and(eq(schema.resourcePrivacy.kind, 'board'), eq(schema.resourcePrivacy.resourceId, schema.userBoards.uuid)),
      )
      .where(
        and(
          eq(schema.boardShareLinks.token, token),
          isNull(schema.boardShareLinks.revokedAt),
          isNull(schema.userBoards.deletedAt),
        ),
      )
      .limit(1),
  );
  if (!row || row.boardType === 'spray' || !isShareLinkAudience(row.audience)) return null;
  return { name: row.name };
}
