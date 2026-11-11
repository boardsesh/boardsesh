import { eq, inArray, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '@boardsesh/db/schema';
import type { ConsolidationContext, ConsolidationDomainHandler, ConsolidationTransaction } from './executor';
import type { ConsolidationPreimageArchive } from './profile-handler';
import { ConsolidationError } from './planner';

function bounded(rows: readonly unknown[]) {
  if (
    rows.length > 100000 ||
    Buffer.byteLength(
      JSON.stringify(rows, (_, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry)),
    ) > 16777216
  )
    throw new ConsolidationError('INPUT_LIMIT');
}
function latest(instants: readonly (Date | null)[]): Date | null {
  return instants.reduce<Date | null>(
    (result, instant) => (instant && (!result || instant > result) ? instant : result),
    null,
  );
}

/** Explicit domain policies only. Unknown nonzero references remain the coordinator's blockers. */
export function createConsolidationOwnershipHandler(options: {
  readonly archivePreimages: ConsolidationPreimageArchive;
  readonly enqueueProviderSync: (
    transaction: ConsolidationTransaction,
    context: ConsolidationContext,
    link: { readonly boardType: string; readonly linkGeneration: string },
  ) => Promise<void>;
}): ConsolidationDomainHandler {
  return {
    name: 'ownership',
    userReferences: [
      'public.user_boards.owner_id',
      'public.gyms.owner_id',
      'public.board_climbs.user_id',
      'public.board_beta_links.created_by_user_id',
      'public.board_climb_events.user_id',
      'public.app_feedback.user_id',
      'public.app_feedback.resolved_by',
      'public.user_activity_days.user_id',
      'public.user_board_activity.user_id',
      'public.user_board_serials.user_id',
      'public.aurora_credentials.user_id',
      'public.user_board_mappings.user_id',
      'public.provider_sync_controls.user_id',
      'public.user_climb_percentiles.user_id',
    ],
    async apply(transaction, context) {
      const sources = [...context.sourceUserIds];
      const members = [context.survivorUserId, ...sources];
      const counts: Record<string, number> = {};
      const archive = async (table: string, rows: readonly unknown[]) => {
        bounded(rows);
        await options.archivePreimages(context, `ownership:${table}`, { rows });
      };
      // A manufacturer serial is not proof of one physical wall. Leave physical-board collisions for explicit review.
      const boards = await transaction
        .select()
        .from(schema.userBoards)
        .where(inArray(schema.userBoards.ownerId, members))
        .limit(100001)
        .for('update');
      bounded(boards);
      const serialKeys = new Set<string>();
      for (const board of boards) {
        if (board.deletedAt || !board.serialNumber) continue;
        const key = JSON.stringify([board.boardType, board.serialNumber]);
        if (serialKeys.has(key)) throw new ConsolidationError('UNSAFE_PLAN');
        serialKeys.add(key);
      }
      await archive('user_boards', boards);
      counts.boards = (
        await transaction
          .update(schema.userBoards)
          .set({ ownerId: context.survivorUserId, updatedAt: new Date() })
          .where(inArray(schema.userBoards.ownerId, sources))
          .returning({ id: schema.userBoards.id })
      ).length;

      const direct: readonly {
        name: string;
        read: (tx: ConsolidationTransaction) => PromiseLike<readonly unknown[]>;
        move: (tx: ConsolidationTransaction) => PromiseLike<readonly unknown[]>;
      }[] = [
        {
          name: 'gyms',
          read: (tx) => tx.select().from(schema.gyms).where(inArray(schema.gyms.ownerId, sources)).limit(100001),
          move: (tx) =>
            tx
              .update(schema.gyms)
              .set({ ownerId: context.survivorUserId, updatedAt: new Date() })
              .where(inArray(schema.gyms.ownerId, sources))
              .returning({ id: schema.gyms.id }),
        },
        {
          name: 'board_climbs',
          read: (tx) =>
            tx.select().from(schema.boardClimbs).where(inArray(schema.boardClimbs.userId, sources)).limit(100001),
          move: (tx) =>
            tx
              .update(schema.boardClimbs)
              .set({ userId: context.survivorUserId, updatedAt: new Date() })
              .where(inArray(schema.boardClimbs.userId, sources))
              .returning({ uuid: schema.boardClimbs.uuid }),
        },
        {
          name: 'board_beta_links',
          read: (tx) =>
            tx
              .select()
              .from(schema.boardBetaLinks)
              .where(inArray(schema.boardBetaLinks.createdByUserId, sources))
              .limit(100001),
          move: (tx) =>
            tx
              .update(schema.boardBetaLinks)
              .set({ createdByUserId: context.survivorUserId })
              .where(inArray(schema.boardBetaLinks.createdByUserId, sources))
              .returning({ link: schema.boardBetaLinks.link }),
        },
        {
          name: 'board_climb_events',
          read: (tx) =>
            tx
              .select()
              .from(schema.boardClimbEvents)
              .where(inArray(schema.boardClimbEvents.userId, sources))
              .limit(100001),
          move: (tx) =>
            tx
              .update(schema.boardClimbEvents)
              .set({ userId: context.survivorUserId })
              .where(inArray(schema.boardClimbEvents.userId, sources))
              .returning({ id: schema.boardClimbEvents.id }),
        },
        {
          name: 'app_feedback',
          read: (tx) =>
            tx
              .select()
              .from(schema.appFeedback)
              .where(or(inArray(schema.appFeedback.userId, sources), inArray(schema.appFeedback.resolvedBy, sources)))
              .limit(100001),
          move: async (tx) => {
            const authored = await tx
              .update(schema.appFeedback)
              .set({ userId: context.survivorUserId })
              .where(inArray(schema.appFeedback.userId, sources))
              .returning({ id: schema.appFeedback.id });
            const resolved = await tx
              .update(schema.appFeedback)
              .set({ resolvedBy: context.survivorUserId })
              .where(inArray(schema.appFeedback.resolvedBy, sources))
              .returning({ id: schema.appFeedback.id });
            return [...authored, ...resolved];
          },
        },
      ];
      const importedClimbs = await transaction
        .select({ uuid: schema.boardClimbs.uuid, userId: schema.boardClimbs.userId })
        .from(schema.boardClimbs)
        .where(inArray(schema.boardClimbs.userId, sources))
        .limit(100001);
      if (importedClimbs.length > 100000) throw new ConsolidationError('INPUT_LIMIT');
      for (const climb of importedClimbs) {
        if (!climb.uuid.startsWith('json-import-climb-') || climb.userId === null) continue;
        const [existing] = await transaction
          .select()
          .from(schema.accountConsolidationImportAliases)
          .where(eq(schema.accountConsolidationImportAliases.externalId, climb.uuid));
        if (existing) throw new ConsolidationError('UNSAFE_PLAN');
        await transaction.insert(schema.accountConsolidationImportAliases).values({
          formerUserId: climb.userId,
          provider: 'aurora',
          kind: 'climb',
          externalId: climb.uuid,
          canonicalResourceId: climb.uuid,
          targetUserId: context.survivorUserId,
          mergeId: context.mergeId,
        });
      }
      for (const policy of direct) {
        const rows = await policy.read(transaction);
        await archive(policy.name, rows);
        counts[policy.name] = (await policy.move(transaction)).length;
      }
      const days = await transaction
        .select()
        .from(schema.userActivityDays)
        .where(inArray(schema.userActivityDays.userId, members))
        .limit(100001)
        .for('update');
      await archive('user_activity_days', days);
      const dayKeys = new Set(
        days
          .filter((day) => day.userId === context.survivorUserId)
          .map((day) => JSON.stringify([day.day, day.platform])),
      );
      for (const day of days.filter((day) => sources.includes(day.userId))) {
        const key = JSON.stringify([day.day, day.platform]);
        if (!dayKeys.has(key)) {
          await transaction.insert(schema.userActivityDays).values({ ...day, userId: context.survivorUserId });
          dayKeys.add(key);
        }
      }
      counts.activityDaysRetired = (
        await transaction
          .delete(schema.userActivityDays)
          .where(inArray(schema.userActivityDays.userId, sources))
          .returning({ day: schema.userActivityDays.day })
      ).length;

      const activity = await transaction
        .select()
        .from(schema.userBoardActivity)
        .where(inArray(schema.userBoardActivity.userId, members))
        .limit(100001)
        .for('update');
      await archive('user_board_activity', activity);
      const byBoard = new Map<string, typeof activity>();
      for (const row of activity) {
        const entries = byBoard.get(row.boardUuid) ?? [];
        entries.push(row);
        byBoard.set(row.boardUuid, entries);
      }
      for (const entries of byBoard.values()) {
        const retained =
          entries.find((row) => row.userId === context.survivorUserId) ??
          [...entries].sort((left, right) => left.id - right.id)[0];
        const losers = entries.filter((row) => row !== retained);
        if (losers.length)
          await transaction.delete(schema.userBoardActivity).where(
            inArray(
              schema.userBoardActivity.id,
              losers.map((row) => row.id),
            ),
          );
        await transaction
          .update(schema.userBoardActivity)
          .set({
            userId: context.survivorUserId,
            lastUsedAt: latest(entries.map((row) => row.lastUsedAt)),
            pinnedAt: latest(entries.map((row) => row.pinnedAt)),
            updatedAt: new Date(),
          })
          .where(eq(schema.userBoardActivity.id, retained.id));
      }
      counts.boardActivityRows = activity.length;
      const serials = await transaction
        .select()
        .from(schema.userBoardSerials)
        .where(inArray(schema.userBoardSerials.userId, members))
        .limit(100001)
        .for('update');
      await archive('user_board_serials', serials);
      const bySerial = new Map<string, typeof serials>();
      for (const row of serials) {
        const key = JSON.stringify([row.boardName, row.serialNumber]);
        const entries = bySerial.get(key) ?? [];
        entries.push(row);
        bySerial.set(key, entries);
      }
      for (const entries of bySerial.values()) {
        if (
          new Set(entries.map((row) => JSON.stringify([row.layoutId, row.sizeId, row.setIds]))).size > 1 ||
          new Set(entries.flatMap((row) => (row.boardUuid ? [row.boardUuid] : []))).size > 1
        )
          throw new ConsolidationError('UNSAFE_PLAN');
        const retained = entries.find((row) => row.userId === context.survivorUserId) ?? entries[0];
        const newest = [...entries].sort(
          (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || right.id - left.id,
        )[0];
        const losers = entries.filter((row) => row !== retained);
        if (losers.length)
          await transaction.delete(schema.userBoardSerials).where(
            inArray(
              schema.userBoardSerials.id,
              losers.map((row) => row.id),
            ),
          );
        await transaction
          .update(schema.userBoardSerials)
          .set({
            userId: context.survivorUserId,
            boardUuid: entries.find((row) => row.boardUuid)?.boardUuid ?? null,
            apiLevel: newest.apiLevel ?? entries.find((row) => row.apiLevel !== null)?.apiLevel ?? null,
            updatedAt: newest.updatedAt,
          })
          .where(eq(schema.userBoardSerials.id, retained.id));
      }
      counts.boardSerialRows = serials.length;
      counts.providerLinks = await consolidateBoardProviderLinks(transaction, context, options);
      const percentiles = await transaction
        .select()
        .from(schema.userClimbPercentiles)
        .where(inArray(schema.userClimbPercentiles.userId, members))
        .for('update');
      await archive('user_climb_percentiles', percentiles);
      await transaction
        .delete(schema.userClimbPercentiles)
        .where(eq(schema.userClimbPercentiles.userId, context.survivorUserId));
      counts.historicalSourcePercentilesRetained = percentiles.filter(
        (row) => row.userId !== context.survivorUserId,
      ).length;
      return counts;
    },
  };
}

/** Stored AES-GCM board credentials are not user-ID-bound; never decrypt them in operator code. */
async function consolidateBoardProviderLinks(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
  options: {
    readonly archivePreimages: ConsolidationPreimageArchive;
    readonly enqueueProviderSync: (
      transaction: ConsolidationTransaction,
      context: ConsolidationContext,
      link: { readonly boardType: string; readonly linkGeneration: string },
    ) => Promise<void>;
  },
) {
  const members = [context.survivorUserId, ...context.sourceUserIds];
  const mappings = await transaction
    .select()
    .from(schema.userBoardMappings)
    .where(inArray(schema.userBoardMappings.userId, members))
    .orderBy(schema.userBoardMappings.id)
    .limit(1001)
    .for('update');
  // No passwords, ciphertext, refresh secrets or access tokens are selected into the private planning archive.
  const credentials = await transaction
    .select({
      id: schema.auroraCredentials.id,
      userId: schema.auroraCredentials.userId,
      boardType: schema.auroraCredentials.boardType,
      auroraUserId: schema.auroraCredentials.auroraUserId,
    })
    .from(schema.auroraCredentials)
    .where(inArray(schema.auroraCredentials.userId, members))
    .orderBy(schema.auroraCredentials.id)
    .limit(1001)
    .for('update');
  const controls = await transaction
    .select()
    .from(schema.providerSyncControls)
    .where(inArray(schema.providerSyncControls.userId, members))
    .orderBy(schema.providerSyncControls.userId, schema.providerSyncControls.boardType)
    .limit(1001)
    .for('update');
  if ([mappings, credentials, controls].some((rows) => rows.length > 1000)) throw new ConsolidationError('INPUT_LIMIT');
  await options.archivePreimages(context, 'provider-link-identity-and-fences', { mappings, credentials, controls });
  const boardTypes = new Set([...mappings, ...credentials, ...controls].map((row) => row.boardType));
  for (const boardType of boardTypes) {
    const boardMappings = mappings.filter((row) => row.boardType === boardType);
    const boardCredentials = credentials.filter((row) => row.boardType === boardType);
    const identities = new Set(
      boardMappings.map((row) => {
        if ((row.boardUserId === null) === (row.boardUserIdText === null)) throw new ConsolidationError('UNSAFE_PLAN');
        return JSON.stringify([row.boardUserId, row.boardUserIdText]);
      }),
    );
    if (identities.size > 1 || (boardCredentials.length && identities.size !== 1))
      throw new ConsolidationError('UNSAFE_PLAN');
    const identity = boardMappings[0];
    for (const credential of boardCredentials) {
      const ownMapping = boardMappings.find((mapping) => mapping.userId === credential.userId);
      if (
        !ownMapping ||
        (credential.auroraUserId !== null &&
          identity.boardUserId !== null &&
          credential.auroraUserId !== identity.boardUserId)
      )
        throw new ConsolidationError('UNSAFE_PLAN');
    }
    if (boardMappings.length) {
      const retained = boardMappings.find((row) => row.userId === context.survivorUserId) ?? boardMappings[0];
      const retired = boardMappings.filter((row) => row !== retained);
      if (retired.length)
        await transaction.delete(schema.userBoardMappings).where(
          inArray(
            schema.userBoardMappings.id,
            retired.map((row) => row.id),
          ),
        );
      await transaction
        .update(schema.userBoardMappings)
        .set({ userId: context.survivorUserId, linkedAt: new Date() })
        .where(eq(schema.userBoardMappings.id, retained.id));
    }
    if (boardCredentials.length) {
      const retained = boardCredentials.find((row) => row.userId === context.survivorUserId) ?? boardCredentials[0];
      const retired = boardCredentials.filter((row) => row !== retained);
      if (retired.length)
        await transaction.delete(schema.auroraCredentials).where(
          inArray(
            schema.auroraCredentials.id,
            retired.map((row) => row.id),
          ),
        );
      await transaction
        .update(schema.auroraCredentials)
        .set({
          userId: context.survivorUserId,
          syncStatus: 'pending',
          lastSyncAttemptAt: null,
          providerRetryAfterUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.auroraCredentials.id, retained.id));
    }
    let canonicalGeneration: string | null = null;
    for (const userId of members) {
      const linked = userId === context.survivorUserId && boardCredentials.length > 0;
      const linkGeneration = randomUUID();
      if (linked) canonicalGeneration = linkGeneration;
      await transaction
        .insert(schema.providerSyncControls)
        .values({ userId, boardType, linked, linkGeneration })
        .onConflictDoUpdate({
          target: [schema.providerSyncControls.userId, schema.providerSyncControls.boardType],
          set: {
            linked,
            linkGeneration,
            pendingRunId: null,
            activeRunId: null,
            activeLeaseUntil: null,
            notifyRequester: false,
            updatedAt: new Date(),
          },
        });
    }
    if (canonicalGeneration)
      await options.enqueueProviderSync(transaction, context, { boardType, linkGeneration: canonicalGeneration });
  }
  return boardTypes.size;
}
