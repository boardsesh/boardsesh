import { createHash } from 'node:crypto';
import { and, asc, count, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as tables from '@boardsesh/db/schema';
import { distanceMeters } from '@boardsesh/db/queries';
import { db, runWithDatabaseTransaction } from '../../db/client';
import { afterCommit, transactionWithAfterCommit } from '../../db/after-commit';
import { requireAuthenticated } from '../../graphql/resolvers/shared/helpers';
import { recordBoardModerationEvent } from '../../graphql/resolvers/social/board-moderation-events';
import { updateBoardRecord } from '../../graphql/resolvers/social/boards';
import { socialGymDuplicateMutations } from '../../graphql/resolvers/social/gym-duplicates';
import { notifyResourcePrivacyChanged } from '../../services/board-session-privacy';
import { logger } from '../../utils/logger';
import { boardRepairStateHash } from '../../services/board-repair-state';
import { normaliseSetIds } from '@boardsesh/board-config';
import { getPostgresErrorCode, isUniqueViolation } from '../../utils/postgres-errors';

type GymRow = typeof tables.gyms.$inferSelect;
const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';

function refusal(message: string, code = 'CONFLICT'): never {
  throw new GraphQLError(message, { extensions: { code } });
}

/** A board-scoped community admin is deliberately insufficient for cross-owner repairs. */
export async function assertGymMcpGlobalAdmin(context: ConnectionContext): Promise<void> {
  requireAuthenticated(context);
  const [actor] = await db
    .select({ id: tables.users.id })
    .from(tables.users)
    .where(eq(tables.users.id, context.userId!))
    .for('key share')
    .limit(1);
  if (!actor) refusal('A current global admin role is required for directory repairs.', 'FORBIDDEN');
  const [role] = await db
    .select({ id: tables.communityRoles.id })
    .from(tables.communityRoles)
    .where(
      and(
        eq(tables.communityRoles.userId, context.userId!),
        eq(tables.communityRoles.role, 'admin'),
        isNull(tables.communityRoles.boardType),
      ),
    )
    .for('share')
    .limit(1);
  if (!role) refusal('A current global admin role is required for directory repairs.', 'FORBIDDEN');
}

function fingerprint(state: unknown): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function gymRepairStateHash(gym: GymRow): string {
  return fingerprint(gym);
}

interface CanonicalSlugRepairInput {
  gymUuid: string;
  aliasGymUuid: string;
  slug: string;
  expectedStateHash: string;
  expectedAliasStateHash: string;
  reason: string;
}

/** Collect the same bounded merge chain used by public reads without following a cycle. */
async function gymAliasChain(start: GymRow): Promise<GymRow[]> {
  const chain = [start];
  let current = start;
  for (let hop = 0; hop < 9 && current.deletedAt && current.mergedIntoGymId !== null; hop++) {
    if (chain.some((gym) => gym.id === current.mergedIntoGymId)) break;
    const [next] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, current.mergedIntoGymId)).limit(1);
    if (!next) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

/** Only the approved alias's slug moves. Merge pointers and both identities remain intact. */
export async function repairGymCanonicalSlug(input: CanonicalSlugRepairInput, context: ConnectionContext) {
  return runWithDatabaseTransaction(async () => {
    await assertGymMcpGlobalAdmin(context);
    const selected = await db
      .select()
      .from(tables.gyms)
      .where(inArray(tables.gyms.uuid, [input.gymUuid, input.aliasGymUuid]));
    const candidate = selected.find((gym) => gym.uuid === input.gymUuid);
    const aliasCandidate = selected.find((gym) => gym.uuid === input.aliasGymUuid);
    if (!candidate || !aliasCandidate || candidate.id === aliasCandidate.id)
      refusal('Select an active survivor and a distinct merged alias gym.', 'BAD_USER_INPUT');
    const colliders = await db
      .select()
      .from(tables.gyms)
      .where(
        and(
          or(eq(tables.gyms.slug, input.slug), candidate.slug ? eq(tables.gyms.slug, candidate.slug) : sql`false`),
          // Public reads ignore ordinary deletions; only live URLs and merge
          // tombstones reserve a slug or count toward the bounded review set.
          or(isNull(tables.gyms.deletedAt), isNotNull(tables.gyms.mergedIntoGymId)),
        ),
      )
      .limit(101);
    if (colliders.length > 100) refusal('Too many records reserve these URLs. Review the directory first.');
    const chains = await Promise.all([aliasCandidate, ...colliders].map(gymAliasChain));
    const lockIds = [...new Set([candidate.id, ...chains.flatMap((chain) => chain.map((gym) => gym.id))])];
    const locked = await db
      .select()
      .from(tables.gyms)
      .where(inArray(tables.gyms.id, lockIds))
      .orderBy(asc(tables.gyms.id))
      .for('update', { noWait: true });
    const gym = locked.find((row) => row.uuid === input.gymUuid)!;
    const alias = locked.find((row) => row.uuid === input.aliasGymUuid)!;
    if (
      !gym ||
      !alias ||
      gym.deletedAt ||
      gym.mergedIntoGymId !== null ||
      !alias.deletedAt ||
      alias.mergedIntoGymId === null ||
      alias.slug !== input.slug ||
      gymRepairStateHash(gym) !== input.expectedStateHash ||
      gymRepairStateHash(alias) !== input.expectedAliasStateHash
    )
      refusal('The survivor or alias changed. Inspect both gyms again before repairing the URL.');
    const resolvesToSurvivor = (start: GymRow): boolean => {
      let current = start;
      const visited = new Set<number>();
      for (let hop = 0; hop < 10; hop++) {
        if (visited.has(current.id)) return false;
        visited.add(current.id);
        if (!current.deletedAt) return current.id === gym.id && current.mergedIntoGymId === null;
        const next = locked.find((row) => row.id === current.mergedIntoGymId);
        if (!next) return false;
        current = next;
      }
      return false;
    };
    if (!resolvesToSurvivor(alias))
      refusal('That alias does not resolve to the selected survivor. Repair the merge first.');
    for (const collider of locked.filter(
      (row) =>
        (row.deletedAt === null || row.mergedIntoGymId !== null) &&
        (row.slug === input.slug || (gym.slug && row.slug === gym.slug)),
    )) {
      if (!resolvesToSurvivor(collider))
        refusal('A requested URL belongs to another gym or an invalid redirect chain.');
    }
    const now = new Date();
    // The alias stays deleted. Exchanging its slug keeps the survivor's old URL
    // resolving through the exact same merge graph, without manufacturing a gym.
    await db
      .update(tables.gyms)
      .set({ slug: gym.slug, updatedAt: now, syncFrozenAt: now })
      .where(eq(tables.gyms.id, alias.id));
    const [updated] = await db
      .update(tables.gyms)
      .set({ slug: input.slug, updatedAt: now, syncFrozenAt: now })
      .where(eq(tables.gyms.id, gym.id))
      .returning();
    await db.insert(tables.gymDirectoryRepairAudit).values({
      operation: 'repair_gym_canonical_slug',
      gymId: gym.id,
      gymUuid: gym.uuid,
      actorUserId: context.userId!,
      reason: input.reason,
      before: { slug: gym.slug, ownerId: gym.ownerId, aliasGymUuid: alias.uuid, aliasSlug: alias.slug },
      after: { slug: input.slug, ownerId: gym.ownerId, aliasGymUuid: alias.uuid, aliasSlug: gym.slug },
      details: { expectedStateHash: input.expectedStateHash, expectedAliasStateHash: input.expectedAliasStateHash },
    });
    return {
      gymUuid: gym.uuid,
      slug: input.slug,
      previousSlug: gym.slug,
      aliasGymUuid: alias.uuid,
      stateHash: gymRepairStateHash(updated!),
      url: `https://www.boardsesh.com/gym/${input.slug}`,
    };
  }).catch((error: unknown) => {
    if (isUniqueViolation(error, 'gyms_unique_slug')) refusal('That URL is now taken. Inspect both gyms again.');
    if (getPostgresErrorCode(error) === '55P03') refusal('These gyms are changing. Retry the same repair in a moment.');
    throw error;
  });
}

export async function authorizeCanonicalSlugReplay(input: CanonicalSlugRepairInput, context: ConnectionContext) {
  await assertGymMcpGlobalAdmin(context);
  const selected = await db
    .select()
    .from(tables.gyms)
    .where(inArray(tables.gyms.uuid, [input.gymUuid, input.aliasGymUuid]));
  const gym = selected.find((row) => row.uuid === input.gymUuid);
  const alias = selected.find((row) => row.uuid === input.aliasGymUuid);
  if (!gym || !alias || gym.deletedAt || gym.mergedIntoGymId !== null || !alias.deletedAt)
    refusal('The repaired gym identities changed. Inspect the directory again.');
  const chain = await gymAliasChain(alias);
  if (chain.at(-1)?.id !== gym.id)
    refusal('The repaired alias no longer resolves to the survivor. Inspect the directory again.');
}

/** Explicit IDs find differently named duplicates; the automatic queue requires matching names. */
export async function inspectGymDuplicates(gymUuids: string[], context: ConnectionContext) {
  return runWithDatabaseTransaction(
    async () => {
      await assertGymMcpGlobalAdmin(context);
      const gyms = await db
        .select()
        .from(tables.gyms)
        .where(inArray(tables.gyms.uuid, gymUuids))
        .orderBy(asc(tables.gyms.id));
      if (gyms.length !== gymUuids.length) refusal('One of the selected gyms is unavailable.', 'NOT_FOUND');
      const boards = await db
        .select()
        .from(tables.userBoards)
        .where(
          inArray(
            tables.userBoards.gymId,
            gyms.map((gym) => gym.id),
          ),
        )
        .orderBy(asc(tables.userBoards.id))
        .limit(101);
      if (boards.length > 100) refusal('Inspect at most 100 board records at once.', 'BAD_USER_INPUT');
      const policies = boards.length
        ? await db
            .select()
            .from(tables.resourcePrivacy)
            .where(
              and(
                eq(tables.resourcePrivacy.kind, 'board'),
                inArray(
                  tables.resourcePrivacy.resourceId,
                  boards.map((board) => board.uuid),
                ),
              ),
            )
        : [];
      const ownerIds = [...new Set([...gyms.map((gym) => gym.ownerId), ...boards.map((board) => board.ownerId)])];
      const owners = await db
        .select({ id: tables.users.id, name: tables.users.name, displayName: tables.userProfiles.displayName })
        .from(tables.users)
        .leftJoin(tables.userProfiles, eq(tables.userProfiles.userId, tables.users.id))
        .where(inArray(tables.users.id, ownerIds));
      const ownerDisplayName = (ownerId: string) => {
        const owner = owners.find((candidate) => candidate.id === ownerId);
        return owner?.displayName || owner?.name || null;
      };
      const boardIds = boards.map((board) => board.id);
      const boardUuids = boards.map((board) => board.uuid);
      const events = boardIds.length
        ? await db
            .select({ boardId: tables.boardClimbEvents.boardId, count: count() })
            .from(tables.boardClimbEvents)
            .where(inArray(tables.boardClimbEvents.boardId, boardIds))
            .groupBy(tables.boardClimbEvents.boardId)
        : [];
      const ticks = boardIds.length
        ? await db
            .select({ boardId: tables.boardseshTicks.boardId, count: count() })
            .from(tables.boardseshTicks)
            .where(inArray(tables.boardseshTicks.boardId, boardIds))
            .groupBy(tables.boardseshTicks.boardId)
        : [];
      const follows = boardUuids.length
        ? await db
            .select({ boardUuid: tables.boardFollows.boardUuid, count: count() })
            .from(tables.boardFollows)
            .where(inArray(tables.boardFollows.boardUuid, boardUuids))
            .groupBy(tables.boardFollows.boardUuid)
        : [];
      const claims = await db
        .select({ gymId: tables.gymClaims.gymId, status: tables.gymClaims.status, count: count() })
        .from(tables.gymClaims)
        .where(
          inArray(
            tables.gymClaims.gymId,
            gyms.map((gym) => gym.id),
          ),
        )
        .groupBy(tables.gymClaims.gymId, tables.gymClaims.status);
      return {
        asOf: new Date().toISOString(),
        gyms: gyms.map((gym) => ({
          gymUuid: gym.uuid,
          name: gym.name,
          slug: gym.slug,
          address: gym.address,
          latitude: gym.latitude,
          longitude: gym.longitude,
          ownership: gym.ownerId === SYSTEM_OWNER ? 'system' : 'user',
          ownerId: gym.ownerId,
          ownerDisplayName: ownerDisplayName(gym.ownerId),
          isPublic: gym.isPublic,
          isListed: gym.isListed,
          deletedAt: gym.deletedAt?.toISOString() ?? null,
          mergedIntoGymUuid: gyms.find((candidate) => candidate.id === gym.mergedIntoGymId)?.uuid ?? null,
          isMerged: gym.mergedIntoGymId !== null,
          stateHash: gymRepairStateHash(gym),
          claims: claims
            .filter((claim) => claim.gymId === gym.id)
            .map(({ status, count: claimCount }) => ({ status, count: claimCount })),
          boards: boards
            .filter((board) => board.gymId === gym.id)
            .map((board) => {
              const policy = policies.find((candidate) => candidate.resourceId === board.uuid);
              return {
                boardUuid: board.uuid,
                name: board.name,
                slug: board.slug,
                boardType: board.boardType,
                layoutId: board.layoutId,
                sizeId: board.sizeId,
                setIds: board.setIds,
                angle: board.angle,
                isAngleAdjustable: board.isAngleAdjustable,
                ownership: board.ownerId === SYSTEM_OWNER ? 'system' : 'user',
                ownerId: board.ownerId,
                ownerDisplayName: ownerDisplayName(board.ownerId),
                isPublic: board.isPublic,
                isUnlisted: board.isUnlisted,
                hideLocation: board.hideLocation,
                audience: policy?.audience ?? (board.isUnlisted ? 'unlisted' : board.isPublic ? 'public' : 'only_me'),
                locationAudience: policy?.locationAudience ?? (board.hideLocation ? 'only_me' : 'public'),
                hasSerialNumber: Boolean(board.serialNumber),
                deletedAt: board.deletedAt?.toISOString() ?? null,
                mergedIntoBoardUuid: board.mergedIntoBoardUuid,
                stateHash: boardRepairStateHash(board, policy),
                climbEvents: events.find((entry) => entry.boardId === board.id)?.count ?? 0,
                ticks: ticks.find((entry) => entry.boardId === board.id)?.count ?? 0,
                followers: follows.find((entry) => entry.boardUuid === board.uuid)?.count ?? 0,
              };
            }),
        })),
        distances: gyms.flatMap((first, index) =>
          gyms.slice(index + 1).map((second) => ({
            firstGymUuid: first.uuid,
            secondGymUuid: second.uuid,
            meters:
              first.latitude !== null &&
              first.longitude !== null &&
              second.latitude !== null &&
              second.longitude !== null
                ? distanceMeters(
                    { latitude: first.latitude, longitude: first.longitude },
                    { latitude: second.latitude, longitude: second.longitude },
                  )
                : null,
          })),
        ),
        guidance:
          'Configuration equality and nearby coordinates are candidates, not proof of one physical wall. Correct stale setups separately. Merge gym listings before merging their boards. Serial numbers are optional.',
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}

export async function assertAdminBoardState(
  gymUuid: string,
  boardUuid: string,
  expectedStateHash: string,
  context: ConnectionContext,
) {
  await assertGymMcpGlobalAdmin(context);
  // Owner privacy writers lock the owner before the board. Keep that order for
  // moderation's owner-notification FKs, including when the admin is the owner.
  const [candidate] = await db
    .select({ ownerId: tables.userBoards.ownerId })
    .from(tables.userBoards)
    .where(eq(tables.userBoards.uuid, boardUuid))
    .limit(1);
  if (!candidate) refusal('The board is not active at the selected gym.', 'NOT_FOUND');
  await db
    .select({ id: tables.users.id })
    .from(tables.users)
    .where(eq(tables.users.id, candidate.ownerId))
    .for('key share');
  const [gym] = await db
    .select({ id: tables.gyms.id })
    .from(tables.gyms)
    .where(and(eq(tables.gyms.uuid, gymUuid), isNull(tables.gyms.deletedAt), isNull(tables.gyms.mergedIntoGymId)))
    .for('update')
    .limit(1);
  const board = await (async () => {
    try {
      const [locked] = await db
        .select()
        .from(tables.userBoards)
        .where(and(eq(tables.userBoards.uuid, boardUuid), gym ? eq(tables.userBoards.gymId, gym.id) : sql`false`))
        .for('update', { noWait: true })
        .limit(1);
      return locked;
    } catch (error) {
      if (getPostgresErrorCode(error) === '55P03')
        refusal('This board is changing. Retry the same repair in a moment.');
      throw error;
    }
  })();
  if (!board || !gym || board.gymId !== gym.id || board.deletedAt || board.mergedIntoBoardUuid)
    refusal('The board is not active at the selected gym.', 'NOT_FOUND');
  if (board.ownerId !== candidate.ownerId) refusal('Board ownership changed. Inspect the gym again.');
  const [policy] = await db
    .select()
    .from(tables.resourcePrivacy)
    .where(and(eq(tables.resourcePrivacy.kind, 'board'), eq(tables.resourcePrivacy.resourceId, board.uuid)))
    .for('update')
    .limit(1);
  if (boardRepairStateHash(board, policy) !== expectedStateHash)
    refusal('The board changed. Inspect the gym again before repairing it.');
  return { board, policy };
}

export async function correctBoardLocationVisibility(
  input: { gymUuid: string; boardUuid: string; expectedStateHash: string; hideLocation: boolean; reason: string },
  context: ConnectionContext,
) {
  return runWithDatabaseTransaction(() =>
    transactionWithAfterCommit(async (transaction) => {
      const { board, policy } = await assertAdminBoardState(
        input.gymUuid,
        input.boardUuid,
        input.expectedStateHash,
        context,
      );
      if (board.boardType === 'spray') refusal('Change spray wall visibility on the wall itself.', 'BAD_USER_INPUT');
      const locationAudience = input.hideLocation ? ('only_me' as const) : ('public' as const);
      await transaction
        .update(tables.userBoards)
        .set({ hideLocation: input.hideLocation, updatedAt: new Date(), syncFrozenAt: new Date() })
        .where(eq(tables.userBoards.id, board.id));
      if (policy)
        await transaction
          .update(tables.resourcePrivacy)
          .set({ locationAudience, revision: sql`${tables.resourcePrivacy.revision} + 1`, updatedAt: new Date() })
          .where(and(eq(tables.resourcePrivacy.kind, 'board'), eq(tables.resourcePrivacy.resourceId, board.uuid)));
      await recordBoardModerationEvent(transaction, {
        boardId: board.id,
        gymId: board.gymId,
        actorUserId: context.userId!,
        actorRole: 'global_admin',
        action: 'edited_by_staff',
        reason: input.reason,
        details: {
          mutation: 'correctGymBoardLocationVisibility',
          fields: ['hideLocation', 'locationAudience'],
          adminRepair: {
            previousHideLocation: board.hideLocation,
            hideLocation: input.hideLocation,
            previousLocationAudience: policy?.locationAudience ?? null,
            locationAudience: policy ? locationAudience : null,
            reason: input.reason,
          },
        },
      });
      afterCommit(transaction, () => {
        void notifyResourcePrivacyChanged('board', board.uuid).catch((error: unknown) =>
          logger.warn('Could not refresh board location visibility after admin repair', {
            boardUuid: board.uuid,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
      return { boardUuid: board.uuid, hideLocation: input.hideLocation, locationAudience, changedBy: 'global_admin' };
    }),
  );
}

export async function correctBoardSetup(
  input: {
    gymUuid: string;
    boardUuid: string;
    expectedStateHash: string;
    changes: { layoutId?: number; sizeId?: number; setIds?: string; angle?: number; isAngleAdjustable?: boolean };
    allowDuplicateConfig?: boolean;
    reason: string;
  },
  context: ConnectionContext,
) {
  return runWithDatabaseTransaction(() =>
    transactionWithAfterCommit(async () => {
      const { board } = await assertAdminBoardState(input.gymUuid, input.boardUuid, input.expectedStateHash, context);
      const updated = await updateBoardRecord(
        { boardUuid: board.uuid, ...input.changes, allowDuplicateConfig: input.allowDuplicateConfig ?? false },
        context,
        'admin',
        {
          reason: input.reason,
          details: {
            before: { layoutId: board.layoutId, sizeId: board.sizeId, setIds: board.setIds, angle: board.angle },
            after: {
              layoutId: input.changes.layoutId ?? board.layoutId,
              sizeId: input.changes.sizeId ?? board.sizeId,
              setIds: normaliseSetIds(input.changes.setIds ?? board.setIds),
              angle: input.changes.angle ?? board.angle,
            },
          },
        },
      );
      return {
        boardUuid: updated.uuid,
        layoutId: updated.layoutId,
        sizeId: updated.sizeId,
        setIds: updated.setIds,
        angle: updated.angle,
        isAngleAdjustable: updated.isAngleAdjustable,
      };
    }),
  );
}

export async function mergeAdminGyms(
  input: {
    canonicalGymUuid: string;
    duplicateGymUuids: string[];
    expectedStates: { gymUuid: string; stateHash: string }[];
    allowSystemCanonicalOverride: boolean;
    reason: string;
  },
  context: ConnectionContext,
) {
  return runWithDatabaseTransaction(() =>
    transactionWithAfterCommit(async () => {
      await assertGymMcpGlobalAdmin(context);
      const requested = [input.canonicalGymUuid, ...input.duplicateGymUuids];
      const gyms = await db
        .select()
        .from(tables.gyms)
        .where(inArray(tables.gyms.uuid, requested))
        .orderBy(asc(tables.gyms.id))
        .for('update');
      if (gyms.length !== requested.length) refusal('One of the selected gyms is unavailable.', 'NOT_FOUND');
      for (const gym of gyms) {
        if (
          gym.deletedAt ||
          gym.mergedIntoGymId ||
          input.expectedStates.find((expected) => expected.gymUuid === gym.uuid)?.stateHash !== gymRepairStateHash(gym)
        )
          refusal('A gym changed. Inspect the selected gyms again before merging.');
      }
      return socialGymDuplicateMutations.mergeGyms(
        {},
        {
          input: {
            canonicalGymUuid: input.canonicalGymUuid,
            duplicateGymUuids: input.duplicateGymUuids,
            allowSystemCanonicalOverride: input.allowSystemCanonicalOverride,
            reason: input.reason,
          },
        },
        context,
      );
    }),
  );
}

/** Receipt authorization accepts only the exact tombstones produced by this merge. */
export async function authorizeAdminMergeReplay(
  kind: 'gym' | 'board',
  canonicalUuid: string,
  duplicateUuids: string[],
  context: ConnectionContext,
): Promise<void> {
  await assertGymMcpGlobalAdmin(context);
  if (kind === 'gym') {
    const gyms = await db
      .select()
      .from(tables.gyms)
      .where(inArray(tables.gyms.uuid, [canonicalUuid, ...duplicateUuids]));
    const canonical = gyms.find((gym) => gym.uuid === canonicalUuid);
    if (
      !canonical ||
      canonical.deletedAt ||
      canonical.mergedIntoGymId ||
      gyms.length !== duplicateUuids.length + 1 ||
      gyms.some((gym) => gym.uuid !== canonicalUuid && (!gym.deletedAt || gym.mergedIntoGymId !== canonical.id))
    )
      refusal('The merged gym identities changed. Inspect the directory again.');
  } else {
    const boards = await db
      .select()
      .from(tables.userBoards)
      .where(inArray(tables.userBoards.uuid, [canonicalUuid, ...duplicateUuids]));
    const canonical = boards.find((board) => board.uuid === canonicalUuid);
    if (
      !canonical ||
      canonical.deletedAt ||
      canonical.mergedIntoBoardUuid ||
      boards.length !== duplicateUuids.length + 1 ||
      boards.some(
        (board) => board.uuid !== canonicalUuid && (!board.deletedAt || board.mergedIntoBoardUuid !== canonical.uuid),
      )
    )
      refusal('The merged board identities changed. Inspect the directory again.');
  }
}
