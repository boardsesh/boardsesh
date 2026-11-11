import { and, eq, inArray, sql } from 'drizzle-orm';
import { boardseshTicks, boardSessions, contentPrivacy } from '@boardsesh/db/schema/app';
import { accountConsolidationImportAliases, accountConsolidationTickAliases } from '@boardsesh/db/schema/auth';
import type { ConsolidationContext, ConsolidationDomainHandler, ConsolidationTransaction } from './executor';
import { ConsolidationError } from './planner';

type TickRow = typeof boardseshTicks.$inferSelect;
function migratedSyncTimestamp(row: TickRow | undefined, syncedAt: string | null | undefined, mutationTime: string) {
  if (!row || !syncedAt) return null;
  return sql<string>`CASE WHEN ${row.updatedAt}::timestamp <= ${syncedAt}::timestamp THEN ${mutationTime}::timestamp ELSE ${syncedAt}::timestamp END`;
}
export interface ConsolidationArchive {
  archivePreimages(context: ConsolidationContext, preimages: Readonly<Record<string, unknown>>): Promise<void>;
}
async function refuseUnplannedTickReferences(transaction: ConsolidationTransaction, retired: TickRow) {
  const [references] = await transaction.execute<{ referenced: boolean }>(sql`SELECT
  EXISTS(SELECT 1 FROM public.board_beta_links WHERE tick_uuid=${retired.uuid}) OR
  EXISTS(SELECT 1 FROM public.board_sessions WHERE anchor_tick_id=${retired.id}) OR
  EXISTS(SELECT 1 FROM public.session_workouts WHERE tick_map @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('tickUuid',${retired.uuid}::text))) OR
  EXISTS(SELECT 1 FROM public.content_privacy WHERE entity_type='tick' AND entity_id=${retired.uuid}) OR
  EXISTS(SELECT 1 FROM public.comments WHERE entity_type='tick' AND entity_id=${retired.uuid}) OR
  EXISTS(SELECT 1 FROM public.votes WHERE entity_type='tick' AND entity_id=${retired.uuid}) OR
  EXISTS(SELECT 1 FROM public.vote_counts WHERE entity_type='tick' AND entity_id=${retired.uuid}) OR
  EXISTS(SELECT 1 FROM public.feed_items WHERE entity_type='tick' AND entity_id=${retired.uuid}) OR
  EXISTS(SELECT 1 FROM public.notifications WHERE entity_type='tick' AND entity_id=${retired.uuid}) AS referenced`);
  if (references?.referenced !== false) throw new ConsolidationError('UNSAFE_PLAN');
}
async function preserveImportAliases(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
  tick: TickRow,
  canonicalUuid: string,
) {
  for (const [provider, externalId] of [
    ['aurora', tick.auroraId],
    ['kilter', tick.kilterId],
    ['moonboard', tick.boardType === 'moonboard' ? tick.uuid : null],
  ] as const) {
    if (!externalId) continue;
    await transaction.insert(accountConsolidationImportAliases).values({
      formerUserId: tick.userId,
      provider,
      kind: 'tick',
      externalId,
      canonicalResourceId: canonicalUuid,
      targetUserId: context.survivorUserId,
      mergeId: context.mergeId,
    });
  }
}
/** Requires preimage validation and session repair by the transaction coordinator. */
export function createConsolidationTickHandler(archive: ConsolidationArchive): ConsolidationDomainHandler {
  return {
    name: 'ticks',
    userReferences: ['public.boardsesh_ticks.user_id'],
    async apply(transaction, context) {
      const allTicks = await transaction
        .select()
        .from(boardseshTicks)
        .where(inArray(boardseshTicks.userId, [context.survivorUserId, ...context.sourceUserIds]))
        .orderBy(boardseshTicks.uuid)
        .for('update');
      await archive.archivePreimages(context, { boardsesh_ticks: allTicks });
      const byUuid = new Map(allTicks.map((tick) => [tick.uuid, tick]));
      const retiredUuids = new Set(context.group.tickMerges.map((merge) => merge.retiredUuid));
      const mutationTime = new Date().toISOString();
      for (const merge of context.group.tickMerges) {
        const retained = byUuid.get(merge.retainedUuid);
        const retired = byUuid.get(merge.retiredUuid);
        if (
          !retained ||
          !retired ||
          retained.id.toString() !== merge.retainedId ||
          retired.id.toString() !== merge.retiredId
        )
          throw new ConsolidationError('INVALID_EVIDENCE');
        if (
          !Number.isSafeInteger(Number(retired.id)) ||
          !Number.isSafeInteger(Number(retained.id)) ||
          (merge.resultingLinkage.boardId !== null && !Number.isSafeInteger(Number(merge.resultingLinkage.boardId)))
        )
          throw new ConsolidationError('UNSAFE_PLAN');
        const policies = await transaction
          .select()
          .from(contentPrivacy)
          .where(
            and(eq(contentPrivacy.entityType, 'tick'), inArray(contentPrivacy.entityId, [retained.uuid, retired.uuid])),
          )
          .for('update');
        await archive.archivePreimages(context, { tick_content_privacy: policies });
        if (policies.length) {
          const audience = policies.some((policy) => policy.audience === 'only_me')
            ? 'only_me'
            : policies.some((policy) => policy.audience === 'followers')
              ? 'followers'
              : 'public';
          const retainedPolicy = policies.find((policy) => policy.entityId === retained.uuid);
          await transaction
            .insert(contentPrivacy)
            .values({
              entityType: 'tick',
              entityId: retained.uuid,
              ownerId: context.survivorUserId,
              audience,
              publicConsentRevision: audience === 'public' ? (retainedPolicy?.publicConsentRevision ?? null) : null,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [contentPrivacy.entityType, contentPrivacy.entityId],
              set: {
                ownerId: context.survivorUserId,
                audience,
                publicConsentRevision: audience === 'public' ? (retainedPolicy?.publicConsentRevision ?? null) : null,
                updatedAt: new Date(),
              },
            });
          await transaction
            .delete(contentPrivacy)
            .where(and(eq(contentPrivacy.entityType, 'tick'), eq(contentPrivacy.entityId, retired.uuid)));
        }
        await refuseUnplannedTickReferences(transaction, retired);
        await preserveImportAliases(transaction, context, retired, retained.uuid);
        await transaction.insert(accountConsolidationTickAliases).values({
          retiredUuid: retired.uuid,
          canonicalUuid: retained.uuid,
          targetUserId: context.survivorUserId,
          mergeId: context.mergeId,
        });
        const auroraRow = allTicks.find(
          (tick) => tick.auroraId !== null && tick.auroraId === merge.resultingLinkage.auroraId,
        );
        const kilterRow = allTicks.find(
          (tick) => tick.kilterId !== null && tick.kilterId === merge.resultingLinkage.kilterId,
        );
        // Free the globally unique provider IDs before assigning retained linkage.
        await transaction.delete(boardseshTicks).where(eq(boardseshTicks.uuid, retired.uuid));
        await transaction
          .update(boardseshTicks)
          .set({
            userId: context.survivorUserId,
            boardId: merge.resultingLinkage.boardId === null ? null : Number(merge.resultingLinkage.boardId),
            auroraId: merge.resultingLinkage.auroraId,
            auroraType: merge.resultingLinkage.auroraType as TickRow['auroraType'],
            kilterId: merge.resultingLinkage.kilterId,
            kilterType: merge.resultingLinkage.kilterType as TickRow['kilterType'],
            auroraSyncedAt: migratedSyncTimestamp(auroraRow, auroraRow?.auroraSyncedAt, mutationTime),
            auroraSyncError: auroraRow?.auroraSyncError ?? null,
            kilterSyncedAt: migratedSyncTimestamp(kilterRow, kilterRow?.kilterSyncedAt, mutationTime),
            kilterSyncError: kilterRow?.kilterSyncError ?? null,
            updatedAt: mutationTime,
          })
          .where(eq(boardseshTicks.uuid, retained.uuid));
      }
      for (const tick of allTicks) {
        if (retiredUuids.has(tick.uuid)) continue;
        await preserveImportAliases(transaction, context, tick, tick.uuid);
      }
      const moved = await transaction
        .update(boardseshTicks)
        .set({
          userId: context.survivorUserId,
          updatedAt: mutationTime,
          auroraSyncedAt: sql`CASE WHEN ${boardseshTicks.auroraSyncedAt} IS NULL THEN NULL WHEN ${boardseshTicks.updatedAt} <= ${boardseshTicks.auroraSyncedAt} THEN ${mutationTime}::timestamp ELSE ${boardseshTicks.auroraSyncedAt} END`,
          kilterSyncedAt: sql`CASE WHEN ${boardseshTicks.kilterSyncedAt} IS NULL THEN NULL WHEN ${boardseshTicks.updatedAt} <= ${boardseshTicks.kilterSyncedAt} THEN ${mutationTime}::timestamp ELSE ${boardseshTicks.kilterSyncedAt} END`,
        })
        .where(inArray(boardseshTicks.userId, [...context.sourceUserIds]))
        .returning({ uuid: boardseshTicks.uuid });
      const retiredIds = context.group.tickMerges.map((merge) => BigInt(merge.retiredId));
      if (retiredIds.length) {
        const remaining = await transaction
          .select({ id: boardSessions.id })
          .from(boardSessions)
          .where(inArray(boardSessions.anchorTickId, retiredIds.map(Number)))
          .limit(1);
        if (remaining.length) throw new ConsolidationError('UNSAFE_PLAN');
      }
      return { retired: retiredUuids.size, moved: moved.length };
    },
  };
}
