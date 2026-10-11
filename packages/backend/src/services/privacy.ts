import {
  anonymousOnBoardCondition,
  boardIdentityVisibleCondition,
  restrictedBoardMemberIdentityCondition,
  userActivityVisibilityCondition,
} from '@boardsesh/db/queries';
export {
  anonymousOnBoardCondition,
  approvedFollowerCondition,
  boardIdentityVisibleCondition,
  userActivityVisibilityCondition,
  contentVisibilityCondition,
  entityOwnerCondition,
  climbDraftVisibilityCondition,
  climbVisibilityCondition,
  resourceAccessCondition,
  resourceLocationCondition,
  sessionBoardLocationCondition,
} from '@boardsesh/db/queries';
import { and, eq, inArray, not, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import * as schema from '@boardsesh/db/schema';
import {
  canReadContent,
  canReadLocation,
  canReadResource,
  type PrivacySettings,
  type PrivacyResourceKind,
  type PrivacyResourceAudience,
  type PrivacyLocationAudience,
} from '@boardsesh/privacy';
import { db } from '../db/client';

type ViewerId = string | null | undefined;
export const privacyControlsEnabled = (): boolean => process.env.BOARDSESH_PRIVACY_ENABLED === '1';
export function requirePrivacyControls(): void {
  if (!privacyControlsEnabled())
    throw new GraphQLError('Privacy controls are not available yet', { extensions: { code: 'PRIVACY_UNAVAILABLE' } });
}
/**
 * Old full-form booleans may narrow, but cannot replace a newer restricted audience.
 * A legacy private session asks for `unlisted` (off the listings, the link still
 * joins), the same reading `resourceAccessCondition` gives an `is_public = false` row.
 * For a session, Unlisted is that switch's own off position, so turning "Show this
 * session live" back on widens it to Public again; a board's switch cannot.
 */
export function legacyResourceAudience(
  current: PrivacyResourceAudience | undefined,
  requested: PrivacyResourceAudience,
  kind: PrivacyResourceKind = 'board',
): PrivacyResourceAudience {
  if (!current || current === 'public' || requested === 'only_me') return requested;
  if (current === 'unlisted' && (requested !== 'public' || kind === 'session')) return requested;
  if (current === 'followers' && requested === 'invite_only') return requested;
  return current;
}

export async function getPrivacySettings(userId: string): Promise<PrivacySettings> {
  const [profile] = await db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)).limit(1);
  return {
    isPrivate: profile?.isPrivate ?? false,
    privacyRevision: profile?.privacyRevision ?? 0,
    defaultSessionAudience: profile?.defaultSessionAudience ?? (profile?.isPrivate ? 'followers' : 'public'),
    anonymousOnForeignBoards: profile?.anonymousOnForeignBoards ?? false,
    enabled: privacyControlsEnabled(),
  };
}
export async function isApprovedFollower(viewerId: ViewerId, subjectId: string): Promise<boolean> {
  if (!viewerId) return false;
  const [follow] = await db
    .select({ id: schema.userFollows.id })
    .from(schema.userFollows)
    .where(and(eq(schema.userFollows.followerId, viewerId), eq(schema.userFollows.followingId, subjectId)))
    .limit(1);
  return !!follow;
}
export async function canViewUserActivity(viewerId: ViewerId, subjectId: string): Promise<boolean> {
  if (viewerId === subjectId) return true;
  const [subject] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.id, subjectId), userActivityVisibilityCondition(schema.users.id, viewerId)))
    .limit(1);
  return !!subject;
}
/**
 * The board a board-facing row is projected for, as a `user_boards.id`. For a
 * live session that is the board `resolveSessionBoards` places it on; null
 * when nothing places it yet, which `anonymousOnBoardCondition` reads as not
 * the climber's own (it fails closed).
 */
export type BoardFacingScope = { boardId: number | null; sessionId?: string };
const boardFacingSessionId = (scope: BoardFacingScope): SQL | undefined =>
  scope.sessionId ? sql`${scope.sessionId}::text` : undefined;
const boardFacingBoardId = (scope: BoardFacingScope): SQL => sql`${scope.boardId ?? null}::bigint`;
const distinctUserIds = (userIds: readonly (string | null | undefined)[]): string[] => [
  ...new Set(userIds.filter((userId): userId is string => !!userId)),
];

/**
 * `canViewUserActivity` for a page of climbers: one query for all of them.
 * Given the board a board-facing page is about (`onBoard`), the same query also
 * leaves out climbers who stay anonymous there (`anonymousOnBoardCondition`).
 */
export async function visibleActivityUserIds(
  subjectUserIds: readonly (string | null | undefined)[],
  viewerId: ViewerId,
  onBoard?: BoardFacingScope,
): Promise<Set<string>> {
  const candidates = distinctUserIds(subjectUserIds);
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.id, candidates),
        onBoard
          ? or(
              userActivityVisibilityCondition(schema.users.id, viewerId),
              restrictedBoardMemberIdentityCondition(
                schema.users.id,
                boardFacingBoardId(onBoard),
                viewerId,
                boardFacingSessionId(onBoard),
              ),
            )
          : userActivityVisibilityCondition(schema.users.id, viewerId),
        onBoard
          ? not(
              anonymousOnBoardCondition(
                schema.users.id,
                boardFacingBoardId(onBoard),
                viewerId,
                boardFacingSessionId(onBoard),
              ),
            )
          : undefined,
      ),
    );
  return new Set(rows.map((row) => row.id));
}

type BoardRows = readonly { userIds: readonly (string | null | undefined)[]; onBoard: BoardFacingScope }[];
/** One query over (row, climber, board) triples: the climbers of each row that `keep` passes. */
async function userIdsByBoard(
  rows: BoardRows,
  keep: (boardId: SQLWrapper, sessionId: SQLWrapper) => SQL | undefined,
): Promise<Set<string>[]> {
  const found = rows.map(() => new Set<string>());
  const triples = rows.flatMap((row, rowIndex) =>
    distinctUserIds(row.userIds).map(
      (userId) =>
        sql`(${rowIndex}::int, ${userId}::text, ${boardFacingBoardId(row.onBoard)}, ${row.onBoard.sessionId ?? null}::text)`,
    ),
  );
  if (triples.length === 0) return found;
  const matches = await db
    .select({ rowIndex: sql<number>`anon_row.row_index`, userId: schema.users.id })
    .from(sql`(VALUES ${sql.join(triples, sql`, `)}) AS anon_row(row_index, user_id, board_id, session_id)`)
    .innerJoin(schema.users, eq(schema.users.id, sql`anon_row.user_id`))
    .where(keep(sql`anon_row.board_id`, sql`anon_row.session_id`));
  for (const { rowIndex, userId } of matches) found[Number(rowIndex)]?.add(userId);
  return found;
}

/**
 * `visibleActivityUserIds` for a page whose rows sit on different boards (the
 * Climbing now rail, nearby discovery): the climbers each row may name on its
 * own board, in the order given. One query for the whole page.
 */
export async function visibleActivityUserIdsByBoard(rows: BoardRows, viewerId: ViewerId): Promise<Set<string>[]> {
  return userIdsByBoard(rows, (boardId, sessionId) =>
    and(
      or(
        userActivityVisibilityCondition(schema.users.id, viewerId),
        restrictedBoardMemberIdentityCondition(schema.users.id, boardId, viewerId, sessionId),
      ),
      not(anonymousOnBoardCondition(schema.users.id, boardId, viewerId, sessionId)),
    ),
  );
}

/** `anonymousOnBoardUserIds` for rows on different boards, in the order given. One query. */
export async function anonymousOnBoardUserIdsByBoard(rows: BoardRows, viewerId: ViewerId): Promise<Set<string>[]> {
  return userIdsByBoard(rows, (boardId, sessionId) =>
    anonymousOnBoardCondition(schema.users.id, boardId, viewerId, sessionId),
  );
}

/** Account/item policy only: the session or wall an item sits in never hides it. */
export async function canViewContent(
  viewerId: ViewerId,
  entityType: string,
  entityId: string,
  ownerId: string | null,
): Promise<boolean> {
  if (ownerId && viewerId === ownerId) return true;
  const [content] = await db
    .select()
    .from(schema.contentPrivacy)
    .where(
      and(
        eq(schema.contentPrivacy.entityType, entityType as (typeof schema.contentPrivacy.$inferSelect)['entityType']),
        eq(schema.contentPrivacy.entityId, entityId),
      ),
    )
    .limit(1);
  if (!ownerId) return !content;
  const [owner] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .limit(1);
  if (!owner) return false;
  const [settings, approved] = await Promise.all([getPrivacySettings(ownerId), isApprovedFollower(viewerId, ownerId)]);
  return canReadContent(settings, content?.ownerId === ownerId ? content : null, {
    isOwner: false,
    isApprovedFollower: approved,
  });
}
export interface ResourcePrivacyState {
  kind: PrivacyResourceKind;
  resourceId: string;
  ownerId: string | null;
  audience: PrivacyResourceAudience;
  locationAudience: PrivacyLocationAudience;
  inheritFollowers: boolean;
  revision: number;
  hasOverride: boolean;
}
/** Read current ownership from the resource, never from a potentially stale override. */
export async function getResourcePrivacy(
  kind: PrivacyResourceKind,
  resourceId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<ResourcePrivacyState | null> {
  let legacy: { ownerId: string | null; audience: PrivacyResourceAudience; locationAudience: PrivacyLocationAudience };
  if (kind === 'board') {
    const [board] = await executor
      .select()
      .from(schema.userBoards)
      .where(and(eq(schema.userBoards.uuid, resourceId), sql`${schema.userBoards.deletedAt} IS NULL`))
      .limit(1);
    if (!board) return null;
    legacy = {
      ownerId: board.ownerId,
      audience:
        board.ownerId === '00000000-0000-0000-0000-000000000000'
          ? 'public'
          : board.isUnlisted
            ? 'unlisted'
            : board.isPublic
              ? 'public'
              : 'only_me',
      locationAudience: board.hideLocation ? 'only_me' : 'public',
    };
  } else {
    const [session] = await executor
      .select()
      .from(schema.boardSessions)
      .where(eq(schema.boardSessions.id, resourceId))
      .limit(1);
    if (!session) return null;
    legacy = {
      ownerId: session.createdByUserId,
      audience: session.isPublic ? 'public' : 'unlisted',
      locationAudience: 'only_me',
    };
  }
  const [override] = await executor
    .select()
    .from(schema.resourcePrivacy)
    .where(and(eq(schema.resourcePrivacy.kind, kind), eq(schema.resourcePrivacy.resourceId, resourceId)))
    .limit(1);
  return {
    kind,
    resourceId,
    ...legacy,
    audience: override?.audience ?? legacy.audience,
    locationAudience: override?.locationAudience ?? legacy.locationAudience,
    inheritFollowers: override?.inheritFollowers ?? false,
    revision: override?.revision ?? 0,
    hasOverride: !!override,
  };
}
async function resourceViewer(resource: ResourcePrivacyState, viewerId: ViewerId) {
  const [grant] = viewerId
    ? await db
        .select()
        .from(schema.resourceGrants)
        .where(
          and(
            eq(schema.resourceGrants.kind, resource.kind),
            eq(schema.resourceGrants.resourceId, resource.resourceId),
            eq(schema.resourceGrants.userId, viewerId),
          ),
        )
        .limit(1)
    : [];
  const [legacyParticipant] =
    viewerId && resource.kind === 'session' && !resource.hasOverride
      ? await db
          .select({ userId: schema.boardSessionParticipants.userId })
          .from(schema.boardSessionParticipants)
          .where(
            and(
              eq(schema.boardSessionParticipants.sessionId, resource.resourceId),
              eq(schema.boardSessionParticipants.userId, viewerId),
            ),
          )
          .limit(1)
      : [];
  return {
    isOwner: !!viewerId && resource.ownerId === viewerId,
    isApprovedFollower: !!resource.ownerId && (await isApprovedFollower(viewerId, resource.ownerId)),
    hasApprovedGrant: grant?.status === 'approved' || (!!legacyParticipant && grant?.status !== 'revoked'),
    hasRevokedGrant: grant?.status === 'revoked',
    inheritFollowers: resource.inheritFollowers,
  };
}
/**
 * Both readings of one resource from a single policy load, which reads the
 * effective audience (the `resource_privacy` row first, the legacy booleans
 * second).
 *
 * - `withLink`: what the resource's link opens. For a session that is its
 *   invite link or id; for a home board its uuid or its `/b/<slug>` path. An
 *   Unlisted resource opens for anyone holding one.
 * - `withoutLink`: everything that is not that link. Listings, search, feeds,
 *   a log that names a board, a spray wall's name-derived slug, and every key a
 *   caller can count: `user_boards.id` is a sequential bigserial, so a numeric
 *   board id is never a link. Here an Unlisted resource opens only for people
 *   who already hold it (owner, approved grant, follower inheritance).
 */
export async function resourceAccess(
  kind: PrivacyResourceKind,
  resourceId: string,
  viewerId: ViewerId,
): Promise<{ withLink: boolean; withoutLink: boolean }> {
  const resource = await getResourcePrivacy(kind, resourceId);
  if (!resource) return { withLink: false, withoutLink: false };
  const viewer = await resourceViewer(resource, viewerId);
  return {
    withLink: canReadResource(resource.audience, viewer),
    withoutLink: canReadResource(resource.audience === 'unlisted' ? 'invite_only' : resource.audience, viewer),
  };
}
/** The `withLink` reading of {@link resourceAccess}: a session invite, a board uuid or home-board slug. */
export async function canAccessResource(
  kind: PrivacyResourceKind,
  resourceId: string,
  viewerId: ViewerId,
): Promise<boolean> {
  return (await resourceAccess(kind, resourceId, viewerId)).withLink;
}
/** The `withoutLink` reading of {@link resourceAccess}: listings, logs, numeric ids, spray slugs. */
export async function canAccessResourceWithoutLink(
  kind: PrivacyResourceKind,
  resourceId: string,
  viewerId: ViewerId,
): Promise<boolean> {
  return (await resourceAccess(kind, resourceId, viewerId)).withoutLink;
}
/**
 * Access to a board through whatever key the caller holds. Only the board's own
 * uuid, passed as `presentedBoardUuid`, is its link and gets the `withLink`
 * reading. Everything else gets `withoutLink`: a numeric `user_boards.id`
 * (enumerable), a slug or uuid carried across another owner's merge, or a uuid
 * of some other board, which unlocks nothing here.
 */
export async function canAccessBoard(
  boardUuid: string,
  viewerId: ViewerId,
  presentedBoardUuid: string | null | undefined,
): Promise<boolean> {
  const access = await resourceAccess('board', boardUuid, viewerId);
  return presentedBoardUuid === boardUuid ? access.withLink : access.withoutLink;
}
export async function requireResourceAccess(
  kind: PrivacyResourceKind,
  resourceId: string,
  viewerId: ViewerId,
): Promise<void> {
  if (!(await canAccessResource(kind, resourceId, viewerId)))
    throw new GraphQLError('Not found', { extensions: { code: 'NOT_FOUND' } });
}
export async function canViewResourceLocation(boardUuid: string, viewerId: ViewerId): Promise<boolean> {
  const resource = await getResourcePrivacy('board', boardUuid);
  if (!resource) return false;
  const viewer = await resourceViewer(resource, viewerId);
  return canReadLocation(resource.locationAudience, {
    ...viewer,
    hasResourceAccess: canReadResource(resource.audience, viewer),
  });
}
/**
 * Whether a climber's identity may accompany their activity. Decided by the
 * author's account privacy and, given an item, that item's own audience. The
 * session or board the activity happened in never decides it: those hide the
 * board's name and place on the item (`visibleBoardIdentityUuids`), not the climber.
 */
export async function canViewActivityIdentity(
  subjectUserId: string,
  viewerId: ViewerId,
  item?: { entityType: string; entityId: string },
): Promise<boolean> {
  if (subjectUserId === viewerId) return true;
  return item
    ? canViewContent(viewerId, item.entityType, item.entityId, subjectUserId)
    : canViewUserActivity(viewerId, subjectUserId);
}
/**
 * Which of these boards an item may name for this viewer: name, place, gym and
 * distance. Built on `boardIdentityVisibleCondition`, so the batch and the SQL
 * forms cannot drift. A log is not a link: an unlisted board is named only to
 * people who already hold it (owner, approved grant, follower inheritance). A
 * deleted board is never named. The items themselves stay visible either way.
 */
export async function visibleBoardIdentityUuids(
  boardUuids: readonly (string | null | undefined)[],
  viewerId: ViewerId,
): Promise<Set<string>> {
  const candidates = [...new Set(boardUuids.filter((boardUuid): boardUuid is string => !!boardUuid))];
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ uuid: schema.userBoards.uuid })
    .from(schema.userBoards)
    .where(
      and(inArray(schema.userBoards.uuid, candidates), boardIdentityVisibleCondition(schema.userBoards.id, viewerId)),
    );
  return new Set(rows.map((row) => row.uuid));
}
/** `visibleBoardIdentityUuids` keyed by `user_boards.id`, for items that store the numeric id. */
export async function visibleBoardIdentityIds(
  boardIds: readonly (number | null | undefined)[],
  viewerId: ViewerId,
): Promise<Set<number>> {
  const candidates = [...new Set(boardIds.filter((boardId): boardId is number => boardId != null))];
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.userBoards.id })
    .from(schema.userBoards)
    .where(
      and(inArray(schema.userBoards.id, candidates), boardIdentityVisibleCondition(schema.userBoards.id, viewerId)),
    );
  return new Set(rows.map((row) => Number(row.id)));
}

/**
 * Climbers among `subjectUserIds` who show as anonymous to `viewerId` on this
 * board: they chose to stay anonymous on boards they don't own, and this one is
 * not theirs (`anonymousOnBoardCondition`). For a row whose identity follows an
 * item's own audience rather than the account (the hardest send); everywhere
 * else `visibleActivityUserIds(..., onBoard)` folds it into the page's query.
 */
export async function anonymousOnBoardUserIds(
  subjectUserIds: readonly (string | null | undefined)[],
  onBoard: BoardFacingScope,
  viewerId: ViewerId,
): Promise<Set<string>> {
  const candidates = distinctUserIds(subjectUserIds).filter((userId) => userId !== viewerId);
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.id, candidates),
        anonymousOnBoardCondition(
          schema.users.id,
          boardFacingBoardId(onBoard),
          viewerId,
          boardFacingSessionId(onBoard),
        ),
      ),
    );
  return new Set(rows.map((row) => row.id));
}
/** `anonymousOnBoardUserIds` for one climber. */
export async function isAnonymousOnBoard(
  authorId: string,
  onBoard: BoardFacingScope,
  viewerId: ViewerId,
): Promise<boolean> {
  return (await anonymousOnBoardUserIds([authorId], onBoard, viewerId)).has(authorId);
}

export type PrivacyExecutor = Pick<typeof db, 'select' | 'insert'>;
/** Call inside the writer's transaction before publishing any event. */
export async function setContentPrivacy(
  executor: PrivacyExecutor,
  userId: string,
  entityType: (typeof schema.contentPrivacy.$inferSelect)['entityType'],
  entityId: string,
  audience: (typeof schema.contentPrivacy.$inferSelect)['audience'],
  privacyRevision: number,
): Promise<void> {
  // The flag hides controls; queued publications must still commit their exact
  // audience during rollback. Authorization and stale-public consent stay active.
  await executor
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .for('no key update');
  const [profile] = await executor
    .select({ revision: schema.userProfiles.privacyRevision })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId))
    .limit(1);
  const currentRevision = profile?.revision ?? 0;
  if (audience === 'public' && privacyRevision !== currentRevision) {
    throw new GraphQLError('Privacy settings changed; choose an audience again', {
      extensions: { code: 'PRIVACY_REVISION_CONFLICT' },
    });
  }
  const settings = {
    ownerId: userId,
    audience,
    publicConsentRevision: audience === 'public' ? currentRevision : null,
    updatedAt: new Date(),
  };
  await executor
    .insert(schema.contentPrivacy)
    .values({ entityType, entityId, ...settings })
    .onConflictDoUpdate({
      target: [schema.contentPrivacy.entityType, schema.contentPrivacy.entityId],
      set: settings,
    });
}
export function betaPrivacyEntityId(boardType: string, climbUuid: string, link: string): string {
  return `${boardType}:${climbUuid}:${link}`;
}
