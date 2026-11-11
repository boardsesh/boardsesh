import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { GraphQLError } from 'graphql';
import {
  accountConsolidationImportAliases,
  accountConsolidationMembers,
  accountConsolidationTickAliases,
} from '@boardsesh/db/schema/auth';
import { boardseshTicks } from '@boardsesh/db/schema/app';

type AliasDatabase = Pick<PostgresJsDatabase, 'select' | 'insert' | 'update'>;
/** A retired UUID is an address alias, never permission to access another owner's tick. */
export async function resolveConsolidatedTickAddress(
  database: AliasDatabase,
  requestedUuid: string,
  userId: string,
  options: { readonly mutation?: 'update' | 'delete' } = {},
): Promise<string> {
  const [alias] = await database
    .select({
      canonicalUuid: accountConsolidationTickAliases.canonicalUuid,
      targetUserId: accountConsolidationTickAliases.targetUserId,
      tombstoned: accountConsolidationTickAliases.tombstoned,
      actualOwner: boardseshTicks.userId,
      changedAfterMerge: sql<
        boolean | null
      >`${boardseshTicks.updatedAt} > (SELECT pg_catalog.min(consolidation_member.applied_at AT TIME ZONE 'UTC') FROM public.account_consolidation_members consolidation_member WHERE consolidation_member.merge_id = ${accountConsolidationTickAliases.mergeId} AND consolidation_member.canonical_user_id = ${userId} AND consolidation_member.status = 'applied')`,
    })
    .from(accountConsolidationTickAliases)
    .leftJoin(boardseshTicks, eq(boardseshTicks.uuid, accountConsolidationTickAliases.canonicalUuid))
    .where(eq(accountConsolidationTickAliases.retiredUuid, requestedUuid))
    .limit(1);
  if (!alias) return requestedUuid;
  if (alias.targetUserId !== userId || alias.actualOwner !== userId || alias.tombstoned || !alias.canonicalUuid)
    throw new GraphQLError('Tick not found', { extensions: { code: 'NOT_FOUND' } });
  if (options.mutation && alias.changedAfterMerge !== false)
    throw new GraphQLError('This tick changed after the accounts were combined', { extensions: { code: 'CONFLICT' } });
  return alias.canonicalUuid;
}

/** Same transaction as DELETE: stale creates addressed to either UUID cannot resurrect the ascent. */
export async function tombstoneConsolidatedTicks(
  database: AliasDatabase,
  userId: string,
  uuids: string[],
): Promise<void> {
  if (uuids.length === 0) return;
  const aliases = await database
    .update(accountConsolidationTickAliases)
    .set({ tombstoned: true })
    .where(
      and(
        eq(accountConsolidationTickAliases.targetUserId, userId),
        eq(accountConsolidationTickAliases.tombstoned, false),
        inArray(accountConsolidationTickAliases.canonicalUuid, uuids),
      ),
    )
    .returning({
      canonicalUuid: accountConsolidationTickAliases.canonicalUuid,
      mergeId: accountConsolidationTickAliases.mergeId,
    });
  const canonical = new Map(
    aliases.flatMap((alias) => (alias.canonicalUuid ? [[alias.canonicalUuid, alias.mergeId] as const] : [])),
  );
  const imported = await database
    .update(accountConsolidationImportAliases)
    .set({ tombstoned: true })
    .where(
      and(
        eq(accountConsolidationImportAliases.targetUserId, userId),
        eq(accountConsolidationImportAliases.kind, 'tick'),
        inArray(accountConsolidationImportAliases.canonicalResourceId, uuids),
      ),
    )
    .returning({
      canonicalUuid: accountConsolidationImportAliases.canonicalResourceId,
      mergeId: accountConsolidationImportAliases.mergeId,
    });
  for (const alias of imported)
    if (alias.canonicalUuid && !canonical.has(alias.canonicalUuid)) canonical.set(alias.canonicalUuid, alias.mergeId);
  // A moved native tick can have neither an upstream ID nor a duplicate UUID alias.
  // Protect every deleted UUID for an applied canonical owner, including that case.
  const [membership] = await database
    .select({ mergeId: accountConsolidationMembers.mergeId })
    .from(accountConsolidationMembers)
    .where(
      and(eq(accountConsolidationMembers.canonicalUserId, userId), eq(accountConsolidationMembers.status, 'applied')),
    )
    .orderBy(accountConsolidationMembers.sourceUserId)
    .limit(1);
  if (membership) for (const uuid of uuids) if (!canonical.has(uuid)) canonical.set(uuid, membership.mergeId);
  for (const [retiredUuid, mergeId] of canonical) {
    const inserted = await database
      .insert(accountConsolidationTickAliases)
      .values({ retiredUuid, canonicalUuid: null, targetUserId: userId, mergeId, tombstoned: true })
      .onConflictDoNothing()
      .returning({ retiredUuid: accountConsolidationTickAliases.retiredUuid });
    if (inserted.length) continue;
    const [existing] = await database
      .select()
      .from(accountConsolidationTickAliases)
      .where(eq(accountConsolidationTickAliases.retiredUuid, retiredUuid))
      .limit(1);
    if (!existing || existing.targetUserId !== userId || !existing.tombstoned || existing.canonicalUuid !== null)
      throw new GraphQLError('Tick changed while deleting', { extensions: { code: 'SERVICE_UNAVAILABLE' } });
  }
}
