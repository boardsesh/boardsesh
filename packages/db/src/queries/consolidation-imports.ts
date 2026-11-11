import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  accountConsolidationImportAliases,
  accountConsolidationMembers,
  accountConsolidationTickAliases,
} from '../schema/auth/consolidation';

type ImportDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export interface ConsolidationImportHistory {
  formerUserIds: readonly string[];
  /** Returns undefined for a new resource, null for a deletion tombstone. */
  resolve(
    provider: string,
    kind: 'tick' | 'playlist' | 'climb',
    externalIds: readonly string[],
  ): string | null | undefined;
}

/** Batch lookup of explicit applied mappings. This never changes authenticated ownership. */
export async function loadConsolidationImportHistory(
  database: ImportDatabase,
  userId: string,
): Promise<ConsolidationImportHistory> {
  const members = await database
    .select({ sourceUserId: accountConsolidationMembers.sourceUserId })
    .from(accountConsolidationMembers)
    .where(
      and(eq(accountConsolidationMembers.canonicalUserId, userId), eq(accountConsolidationMembers.status, 'applied')),
    );
  if (!members.length) return { formerUserIds: [], resolve: () => undefined };
  const aliases = await database
    .select()
    .from(accountConsolidationImportAliases)
    .where(eq(accountConsolidationImportAliases.targetUserId, userId));
  const tickAliases = await database
    .select()
    .from(accountConsolidationTickAliases)
    .where(eq(accountConsolidationTickAliases.targetUserId, userId));
  const byKey = new Map<string, Set<string | null>>();
  const add = (key: string, resourceId: string | null) => {
    const matches = byKey.get(key) ?? new Set<string | null>();
    matches.add(resourceId);
    byKey.set(key, matches);
  };
  for (const alias of aliases)
    add(`${alias.provider}:${alias.kind}:${alias.externalId}`, alias.tombstoned ? null : alias.canonicalResourceId);
  for (const alias of tickAliases)
    add(`moonboard:tick:${alias.retiredUuid}`, alias.tombstoned ? null : alias.canonicalUuid);
  return {
    formerUserIds: members.map((member) => member.sourceUserId).sort(),
    resolve(provider, kind, externalIds) {
      const matches = new Set<string | null>();
      for (const externalId of externalIds)
        for (const resourceId of byKey.get(`${provider}:${kind}:${externalId}`) ?? []) matches.add(resourceId);
      // Distinct imported resources remain distinct. An ambiguous export cannot choose one by name.
      if (matches.size > 1) throw new Error('Ambiguous consolidated import identity');
      return matches.size ? [...matches][0] : undefined;
    },
  };
}
