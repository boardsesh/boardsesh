import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { accountConsolidationSessionAliases } from '@boardsesh/db/schema/auth';
import { boardSessions } from '@boardsesh/db/schema/app';
import * as schema from '@boardsesh/db/schema/app';
import { ConsolidationError } from './planner';

type AliasStore = Pick<PostgresJsDatabase, 'select' | 'insert' | 'update'>;

/** Legacy reconciliation does not preserve these fields/references; applied history must survive. */
async function assertDisposableAliasedSessions(transaction: AliasStore, sessionIds: readonly string[]): Promise<void> {
  const sessions = await transaction
    .select({
      name: boardSessions.name,
      goal: boardSessions.goal,
      notes: boardSessions.notes,
      userEdited: boardSessions.userEdited,
    })
    .from(boardSessions)
    .where(inArray(boardSessions.id, [...sessionIds]))
    .for('share');
  if (sessions.some((session) => session.userEdited || session.name || session.goal || session.notes))
    throw new ConsolidationError('UNSAFE_PLAN');
  for (const table of [
    schema.comments,
    schema.votes,
    schema.voteCounts,
    schema.feedItems,
    schema.notifications,
    schema.contentPrivacy,
  ] as const) {
    const existing = await transaction
      .select({ present: sql<number>`1` })
      .from(table)
      .where(and(eq(table.entityType, 'session'), inArray(table.entityId, [...sessionIds])))
      .limit(1);
    if (existing.length) throw new ConsolidationError('UNSAFE_PLAN');
  }
  for (const table of [
    schema.boardSessionParticipants,
    schema.sessionHealthKitWorkouts,
    schema.sessionBoards,
    schema.boardSessionQueues,
    schema.sessionWorkouts,
    schema.integrationExports,
    schema.boardClimbEvents,
  ] as const) {
    const existing = await transaction
      .select({ present: sql<number>`1` })
      .from(table)
      .where(inArray(table.sessionId, [...sessionIds]))
      .limit(1);
    if (existing.length) throw new ConsolidationError('UNSAFE_PLAN');
  }
  for (const table of [schema.resourcePrivacy, schema.resourceGrants] as const) {
    const existing = await transaction
      .select({ present: sql<number>`1` })
      .from(table)
      .where(and(eq(table.kind, 'session'), inArray(table.resourceId, [...sessionIds])))
      .limit(1);
    if (existing.length) throw new ConsolidationError('UNSAFE_PLAN');
  }
}

/** Preserve previously applied routing when ordinary inferred reconciliation merges again. */
export async function retargetConsolidatedSessionAliases(
  transaction: AliasStore,
  fromSessionId: string,
  toSessionId: string,
  userId: string,
): Promise<void> {
  if (fromSessionId === toSessionId) throw new ConsolidationError('UNSAFE_PLAN');
  const incoming = await transaction
    .select()
    .from(accountConsolidationSessionAliases)
    .where(eq(accountConsolidationSessionAliases.canonicalSessionId, fromSessionId))
    .limit(100001)
    .for('update');
  if (!incoming.length) return;
  if (incoming.length > 100000 || incoming.some((alias) => alias.targetUserId !== userId || alias.tombstoned))
    throw new ConsolidationError('UNSAFE_PLAN');
  const endpoints = await transaction
    .select({ id: boardSessions.id, ownerId: boardSessions.createdByUserId, origin: boardSessions.origin })
    .from(boardSessions)
    .where(inArray(boardSessions.id, [fromSessionId, toSessionId]))
    .orderBy(boardSessions.id)
    .for('share');
  if (
    endpoints.length !== 2 ||
    endpoints.some((endpoint) => endpoint.ownerId !== userId || endpoint.origin !== 'inferred')
  )
    throw new ConsolidationError('UNSAFE_PLAN');
  await assertDisposableAliasedSessions(transaction, [fromSessionId]);
  const [existing] = await transaction
    .select()
    .from(accountConsolidationSessionAliases)
    .where(eq(accountConsolidationSessionAliases.retiredSessionId, fromSessionId))
    .limit(1)
    .for('update');
  if (
    existing &&
    (existing.targetUserId !== userId || existing.canonicalSessionId !== toSessionId || existing.tombstoned)
  )
    throw new ConsolidationError('UNSAFE_PLAN');
  await transaction
    .update(accountConsolidationSessionAliases)
    .set({ canonicalSessionId: toSessionId })
    .where(
      and(
        eq(accountConsolidationSessionAliases.canonicalSessionId, fromSessionId),
        eq(accountConsolidationSessionAliases.targetUserId, userId),
      ),
    );
  if (!existing)
    await transaction.insert(accountConsolidationSessionAliases).values({
      retiredSessionId: fromSessionId,
      canonicalSessionId: toSessionId,
      targetUserId: userId,
      mergeId: incoming[0].mergeId,
    });
}

/** An emptied session has no inferred destination; old addresses remain durable tombstones. */
export async function tombstoneConsolidatedSessionAliases(
  transaction: AliasStore,
  sessionIds: readonly string[],
  userId: string,
): Promise<void> {
  if (!sessionIds.length) return;
  const incoming = await transaction
    .select()
    .from(accountConsolidationSessionAliases)
    .where(inArray(accountConsolidationSessionAliases.canonicalSessionId, [...sessionIds]))
    .limit(100001)
    .for('update');
  if (incoming.length > 100000 || incoming.some((alias) => alias.targetUserId !== userId))
    throw new ConsolidationError('UNSAFE_PLAN');
  const destinations = [
    ...new Set(incoming.flatMap((alias) => (alias.canonicalSessionId ? [alias.canonicalSessionId] : []))),
  ];
  if (destinations.length) {
    const sessions = await transaction
      .select({ id: boardSessions.id, ownerId: boardSessions.createdByUserId, origin: boardSessions.origin })
      .from(boardSessions)
      .where(inArray(boardSessions.id, destinations))
      .orderBy(boardSessions.id)
      .for('share');
    if (
      sessions.length !== destinations.length ||
      sessions.some((session) => session.ownerId !== userId || session.origin !== 'inferred')
    )
      throw new ConsolidationError('UNSAFE_PLAN');
  }
  if (destinations.length) await assertDisposableAliasedSessions(transaction, destinations);
  await transaction
    .update(accountConsolidationSessionAliases)
    .set({ canonicalSessionId: null, tombstoned: true })
    .where(
      and(
        inArray(accountConsolidationSessionAliases.canonicalSessionId, [...sessionIds]),
        eq(accountConsolidationSessionAliases.targetUserId, userId),
      ),
    );
}
