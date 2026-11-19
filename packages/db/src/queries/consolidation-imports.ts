import { and, eq, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  accountConsolidationImportAliases,
  accountConsolidationMembers,
  accountConsolidationTickAliases,
} from '../schema/auth/consolidation';

type ImportDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export interface ConsolidationImportHistory {
  formerUserIds: readonly string[];
  /** Original import UUIDs that an applied repair mapped to this climb. */
  formerClimbUuids(canonicalClimbUuid: string): readonly string[];
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
    .select({ sourceUserId: accountConsolidationMembers.sourceUserId, mergeId: accountConsolidationMembers.mergeId })
    .from(accountConsolidationMembers)
    .where(
      and(eq(accountConsolidationMembers.canonicalUserId, userId), eq(accountConsolidationMembers.status, 'applied')),
    );
  if (!members.length) return { formerUserIds: [], formerClimbUuids: () => [], resolve: () => undefined };
  const sourcesByMerge = new Map<string, Set<string>>();
  for (const member of members) {
    const sources = sourcesByMerge.get(member.mergeId) ?? new Set<string>();
    sources.add(member.sourceUserId);
    sourcesByMerge.set(member.mergeId, sources);
  }
  const appliedMergeIds = [...sourcesByMerge.keys()];
  const aliases = await database
    .select()
    .from(accountConsolidationImportAliases)
    .where(
      and(
        eq(accountConsolidationImportAliases.targetUserId, userId),
        inArray(accountConsolidationImportAliases.mergeId, appliedMergeIds),
      ),
    );
  const tickAliases = await database
    .select()
    .from(accountConsolidationTickAliases)
    .where(
      and(
        eq(accountConsolidationTickAliases.targetUserId, userId),
        inArray(accountConsolidationTickAliases.mergeId, appliedMergeIds),
      ),
    );
  const byKey = new Map<string, Set<string | null>>();
  const formerClimbsByCanonical = new Map<string, Set<string>>();
  const add = (key: string, resourceId: string | null) => {
    const matches = byKey.get(key) ?? new Set<string | null>();
    matches.add(resourceId);
    byKey.set(key, matches);
  };
  for (const alias of aliases) {
    if (alias.formerUserId !== userId && !sourcesByMerge.get(alias.mergeId)?.has(alias.formerUserId)) continue;
    add(`${alias.provider}:${alias.kind}:${alias.externalId}`, alias.tombstoned ? null : alias.canonicalResourceId);
    if (alias.provider === 'aurora' && alias.kind === 'climb' && !alias.tombstoned && alias.canonicalResourceId) {
      const formerUuids = formerClimbsByCanonical.get(alias.canonicalResourceId) ?? new Set<string>();
      formerUuids.add(alias.externalId);
      formerClimbsByCanonical.set(alias.canonicalResourceId, formerUuids);
    }
  }
  for (const alias of tickAliases)
    add(`moonboard:tick:${alias.retiredUuid}`, alias.tombstoned ? null : alias.canonicalUuid);
  return {
    formerUserIds: members.map((member) => member.sourceUserId).sort(),
    formerClimbUuids(canonicalClimbUuid) {
      const formerUuids = [...(formerClimbsByCanonical.get(canonicalClimbUuid) ?? [])];
      for (const formerUuid of formerUuids)
        if ((byKey.get(`aurora:climb:${formerUuid}`)?.size ?? 0) > 1)
          throw new Error('Ambiguous consolidated import identity');
      return formerUuids;
    },
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
