import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { GraphQLError } from 'graphql';
import { accountConsolidationSessionAliases } from '@boardsesh/db/schema/auth';
import { boardSessions } from '@boardsesh/db/schema/app';

type AliasReader = Pick<PostgresJsDatabase, 'select'>;

/** Address routing only. Every caller must still apply the resolved session's normal privacy/ownership checks. */
export async function resolveConsolidatedSessionAddress(
  database: AliasReader,
  sessionId: string,
  userId: string | null | undefined,
): Promise<string | null> {
  const [alias] = await database
    .select({
      canonicalSessionId: accountConsolidationSessionAliases.canonicalSessionId,
      targetUserId: accountConsolidationSessionAliases.targetUserId,
      tombstoned: accountConsolidationSessionAliases.tombstoned,
      actualOwner: boardSessions.createdByUserId,
      origin: boardSessions.origin,
    })
    .from(accountConsolidationSessionAliases)
    .leftJoin(boardSessions, eq(boardSessions.id, accountConsolidationSessionAliases.canonicalSessionId))
    .where(eq(accountConsolidationSessionAliases.retiredSessionId, sessionId))
    .limit(1);
  if (!alias) return sessionId;
  if (
    !userId ||
    alias.targetUserId !== userId ||
    alias.actualOwner !== userId ||
    alias.origin !== 'inferred' ||
    alias.tombstoned ||
    !alias.canonicalSessionId
  )
    return null;
  return alias.canonicalSessionId;
}

/** Old full-document edits must never replace the combined metadata or external workout mapping. */
export async function rejectConsolidatedSessionEdit(
  database: AliasReader,
  sessionId: string,
  userId: string,
): Promise<void> {
  const [alias] = await database
    .select({ targetUserId: accountConsolidationSessionAliases.targetUserId })
    .from(accountConsolidationSessionAliases)
    .where(eq(accountConsolidationSessionAliases.retiredSessionId, sessionId))
    .limit(1);
  if (!alias) return;
  if (alias.targetUserId !== userId) throw new GraphQLError('Session not found', { extensions: { code: 'NOT_FOUND' } });
  throw new GraphQLError('This session was combined; refresh before editing', { extensions: { code: 'CONFLICT' } });
}
