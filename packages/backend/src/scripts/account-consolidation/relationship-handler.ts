import { and, eq, getTableColumns, getTableName, inArray, or } from 'drizzle-orm';
import type { AnyPgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  boardFollows,
  comments,
  contentPrivacy,
  feedItems,
  gymFollows,
  notifications,
  playlistFollows,
  playlistOwnership,
  playlists,
  resourceGrants,
  resourcePrivacy,
  setterFollows,
  userFavorites,
  userFollows,
  userPlaylistPins,
  votes,
} from '@boardsesh/db/schema/app';
import { accountConsolidationImportAliases } from '@boardsesh/db/schema/auth';
import { ConsolidationError } from './planner';
import type { ConsolidationContext, ConsolidationDomainHandler, ConsolidationTransaction } from './executor';
import type { ConsolidationArchive } from './tick-handler';

type EdgeRow = Record<string, unknown>;
function timeOf(row: EdgeRow): number {
  const timestamp = row.createdAt;
  return timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === 'string' ? Date.parse(timestamp) : 0;
}
function keyPart(part: unknown): unknown {
  return typeof part === 'bigint' ? part.toString() : part;
}
async function mergeSetEdges(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
  archive: ConsolidationArchive,
  table: AnyPgTable,
  ownerKey: string,
  businessKeys: readonly string[],
  hasUpdatedAt: boolean,
  preferLatest = false,
) {
  const columns = getTableColumns(table);
  const owner = columns[ownerKey];
  const id = columns.id;
  if (!owner || !id) throw new ConsolidationError('UNSAFE_PLAN');
  const rows = (await transaction
    .select()
    .from(table)
    .where(inArray(owner, [context.survivorUserId, ...context.sourceUserIds]))
    .for('update')) as EdgeRow[];
  await archive.archivePreimages(context, { [getTableName(table)]: rows });
  const sorted = [...rows].sort(
    (left, right) =>
      Number(right[ownerKey] === context.survivorUserId) - Number(left[ownerKey] === context.survivorUserId) ||
      (preferLatest ? timeOf(right) - timeOf(left) : timeOf(left) - timeOf(right)) ||
      String(left.id).localeCompare(String(right.id)),
  );
  const selected = new Map<string, EdgeRow>();
  let removed = 0;
  let moved = 0;
  for (const row of sorted) {
    const key = JSON.stringify(businessKeys.map((column) => keyPart(row[column])));
    if (selected.has(key)) {
      await transaction.delete(table).where(eq(id, row.id));
      removed++;
      continue;
    }
    selected.set(key, row);
  }
  for (const row of selected.values())
    if (row[ownerKey] !== context.survivorUserId) {
      await transaction
        .update(table)
        .set({
          [ownerKey]: context.survivorUserId,
          ...(hasUpdatedAt ? { updatedAt: new Date() } : {}),
        } as PgUpdateSetSource<typeof table>)
        .where(eq(id, row.id));
      moved++;
    }
  return { removed, moved };
}
async function mergePlaylistOwnership(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
  archive: ConsolidationArchive,
) {
  const rows = await transaction
    .select()
    .from(playlistOwnership)
    .where(inArray(playlistOwnership.userId, [context.survivorUserId, ...context.sourceUserIds]))
    .orderBy(playlistOwnership.id)
    .for('update');
  const roles = new Map<string, string>();
  for (const row of rows) {
    const key = row.playlistId.toString();
    const previous = roles.get(key);
    if (previous !== undefined && previous !== row.role) throw new ConsolidationError('UNSAFE_PLAN');
    roles.set(key, row.role);
  }
  const changedPlaylistIds = [
    ...new Set(rows.filter((row) => row.userId !== context.survivorUserId).map((row) => row.playlistId)),
  ];
  const allPlaylistIds = [...new Set(rows.map((row) => row.playlistId))];
  if (allPlaylistIds.length) {
    const playlistRows = await transaction
      .select()
      .from(playlists)
      .where(inArray(playlists.id, allPlaylistIds))
      .for('update');
    await archive.archivePreimages(context, { playlists: playlistRows });
    for (const edge of rows) {
      const playlist = playlistRows.find((row) => row.id === edge.playlistId);
      if (!playlist) throw new ConsolidationError('UNSAFE_PLAN');
      for (const [provider, externalId] of [
        ['aurora', playlist.auroraId],
        ['kilter', playlist.kilterId],
      ] as const) {
        if (externalId)
          await transaction.insert(accountConsolidationImportAliases).values({
            formerUserId: edge.userId,
            provider,
            kind: 'playlist',
            externalId,
            canonicalResourceId: playlist.uuid,
            targetUserId: context.survivorUserId,
            mergeId: context.mergeId,
          });
      }
    }
  }
  const counts = await mergeSetEdges(transaction, context, archive, playlistOwnership, 'userId', ['playlistId'], false);
  if (changedPlaylistIds.length)
    await transaction.update(playlists).set({ updatedAt: new Date() }).where(inArray(playlists.id, changedPlaylistIds));
  return counts;
}
async function mergeUserFollows(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
  archive: ConsolidationArchive,
) {
  const members = [context.survivorUserId, ...context.sourceUserIds];
  const rows = await transaction
    .select()
    .from(userFollows)
    .where(or(inArray(userFollows.followerId, members), inArray(userFollows.followingId, members)))
    .orderBy(userFollows.id)
    .for('update');
  await archive.archivePreimages(context, { user_follows: rows });
  const remap = (userId: string) => (context.sourceUserIds.includes(userId) ? context.survivorUserId : userId);
  const ordered = [...rows].sort(
    (left, right) =>
      Number(right.followerId === remap(right.followerId) && right.followingId === remap(right.followingId)) -
        Number(left.followerId === remap(left.followerId) && left.followingId === remap(left.followingId)) ||
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id - right.id,
  );
  const selected = new Map<string, (typeof rows)[number]>();
  let removed = 0;
  let moved = 0;
  for (const row of ordered) {
    const follower = remap(row.followerId);
    const following = remap(row.followingId);
    const key = JSON.stringify([follower, following]);
    if (follower === following || selected.has(key)) {
      await transaction.delete(userFollows).where(eq(userFollows.id, row.id));
      removed++;
    } else selected.set(key, row);
  }
  for (const row of selected.values())
    if (row.followerId !== remap(row.followerId) || row.followingId !== remap(row.followingId)) {
      await transaction
        .update(userFollows)
        .set({ followerId: remap(row.followerId), followingId: remap(row.followingId), updatedAt: new Date() })
        .where(eq(userFollows.id, row.id));
      moved++;
    }
  return { removed, moved };
}
async function mergeGrants(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
  archive: ConsolidationArchive,
) {
  const rows = await transaction
    .select()
    .from(resourceGrants)
    .where(
      or(
        inArray(resourceGrants.userId, [context.survivorUserId, ...context.sourceUserIds]),
        inArray(resourceGrants.invitedBy, [...context.sourceUserIds]),
      ),
    )
    .for('update');
  await archive.archivePreimages(context, { resource_grants: rows });
  const sets = new Map<string, typeof rows>();
  for (const row of rows)
    if (context.group.memberUserIds.includes(row.userId)) {
      const key = JSON.stringify([row.kind, row.resourceId]);
      const entries = sets.get(key) ?? [];
      entries.push(row);
      sets.set(key, entries);
    }
  let moved = 0;
  let removed = 0;
  for (const entries of sets.values()) {
    const first = entries.find((row) => row.userId === context.survivorUserId) ?? entries[0];
    const status = entries.some((row) => row.status === 'revoked')
      ? 'revoked'
      : entries.some((row) => row.status === 'pending')
        ? 'pending'
        : 'approved';
    const sourceIds = entries.filter((row) => row.userId !== context.survivorUserId).map((row) => row.userId);
    if (sourceIds.length) {
      await transaction
        .delete(resourceGrants)
        .where(
          and(
            eq(resourceGrants.kind, first.kind),
            eq(resourceGrants.resourceId, first.resourceId),
            inArray(resourceGrants.userId, sourceIds),
          ),
        );
      removed += sourceIds.length;
    }
    const invitedBy =
      first.invitedBy && context.sourceUserIds.includes(first.invitedBy) ? context.survivorUserId : first.invitedBy;
    const canonical = entries.some((row) => row.userId === context.survivorUserId);
    if (canonical)
      await transaction
        .update(resourceGrants)
        .set({ status, invitedBy, updatedAt: new Date() })
        .where(
          and(
            eq(resourceGrants.kind, first.kind),
            eq(resourceGrants.resourceId, first.resourceId),
            eq(resourceGrants.userId, context.survivorUserId),
          ),
        );
    else {
      await transaction
        .insert(resourceGrants)
        .values({ ...first, userId: context.survivorUserId, status, invitedBy, updatedAt: new Date() });
      moved++;
    }
  }
  await transaction
    .update(resourceGrants)
    .set({ invitedBy: context.survivorUserId, updatedAt: new Date() })
    .where(inArray(resourceGrants.invitedBy, [...context.sourceUserIds]));
  return { removed, moved };
}
/** Fixed, reviewed relationship policies. This never discovers and rewrites arbitrary FKs. */
export function createConsolidationRelationshipHandler(archive: ConsolidationArchive): ConsolidationDomainHandler {
  return {
    name: 'relationships',
    userReferences: [
      'public.user_favorites.user_id',
      'public.user_follows.follower_id',
      'public.user_follows.following_id',
      'public.setter_follows.follower_id',
      'public.playlist_follows.follower_id',
      'public.playlist_ownership.user_id',
      'public.board_follows.user_id',
      'public.gym_follows.user_id',
      'public.user_playlist_pins.user_id',
      'public.votes.user_id',
      'public.comments.user_id',
      'public.feed_items.actor_id',
      'public.feed_items.recipient_id',
      'public.notifications.actor_id',
      'public.notifications.recipient_id',
      'public.resource_privacy.owner_id',
      'public.content_privacy.owner_id',
      'public.resource_grants.user_id',
      'public.resource_grants.invited_by',
    ],
    async apply(transaction, context) {
      const counts: Record<string, number> = {};
      const playlistOwnershipCounts = await mergePlaylistOwnership(transaction, context, archive);
      counts.playlistOwnershipMoved = playlistOwnershipCounts.moved;
      counts.playlistOwnershipRemoved = playlistOwnershipCounts.removed;
      const policies = [
        { table: userFavorites, owner: 'userId', keys: ['boardName', 'climbUuid', 'angle'], updated: true },
        { table: setterFollows, owner: 'followerId', keys: ['setterUsername'], updated: true },
        { table: playlistFollows, owner: 'followerId', keys: ['playlistUuid'], updated: true },
        { table: boardFollows, owner: 'userId', keys: ['boardUuid'], updated: false },
        { table: gymFollows, owner: 'userId', keys: ['gymId'], updated: false },
        { table: userPlaylistPins, owner: 'userId', keys: ['playlistId'], updated: true },
        { table: votes, owner: 'userId', keys: ['entityType', 'entityId'], updated: false },
      ];
      for (const policy of policies) {
        const result = await mergeSetEdges(
          transaction,
          context,
          archive,
          policy.table,
          policy.owner,
          policy.keys,
          policy.updated,
          policy.table === votes,
        );
        counts[`${getTableName(policy.table)}Moved`] = result.moved;
        counts[`${getTableName(policy.table)}Removed`] = result.removed;
      }
      const follows = await mergeUserFollows(transaction, context, archive);
      counts.userFollowsMoved = follows.moved;
      counts.userFollowsRemoved = follows.removed;
      const grants = await mergeGrants(transaction, context, archive);
      counts.resourceGrantsMoved = grants.moved;
      counts.resourceGrantsRemoved = grants.removed;
      for (const policy of [
        { table: comments, key: 'userId' },
        { table: feedItems, key: 'actorId' },
        { table: feedItems, key: 'recipientId' },
        { table: notifications, key: 'actorId' },
        { table: notifications, key: 'recipientId' },
        { table: resourcePrivacy, key: 'ownerId' },
        { table: contentPrivacy, key: 'ownerId' },
      ]) {
        const column = getTableColumns(policy.table)[
          policy.key as keyof ReturnType<typeof getTableColumns<typeof policy.table>>
        ];
        if (!column) throw new ConsolidationError('UNSAFE_PLAN');
        const before = await transaction
          .select()
          .from(policy.table)
          .where(inArray(column, [...context.sourceUserIds]))
          .for('update');
        await archive.archivePreimages(context, { [`${getTableName(policy.table)}.${policy.key}`]: before });
        await transaction
          .update(policy.table)
          .set({ [policy.key]: context.survivorUserId } as PgUpdateSetSource<typeof policy.table>)
          .where(inArray(column, [...context.sourceUserIds]));
        counts[`${getTableName(policy.table)}.${policy.key}`] = before.length;
      }
      return counts;
    },
  };
}
