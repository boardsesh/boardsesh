/** Transaction coordinator. Only explicit domain handlers may perform data changes. */
import { eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { accountConsolidationBatches, accountConsolidationGroupAudits, users } from '@boardsesh/db/schema/auth';
import { lockAuthorityGateExclusively } from '../current-store/foundation-context';
import { acquireUserTickMutationLock } from '@boardsesh/db/queries';
import { sqlAccountKey } from '../email-audit/evidence-snapshot';
import {
  ConsolidationError,
  consolidationDigest,
  fingerprintConsolidationPlan,
  type AccountConsolidationPlan,
  type ConsolidationGroupPlan,
} from './planner';

export type ConsolidationTransaction = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
export interface ConsolidationContext {
  readonly batchId: string;
  readonly mergeId: string;
  readonly survivorUserId: string;
  readonly sourceUserIds: readonly string[];
  readonly group: ConsolidationGroupPlan;
}
export type ConsolidationDomain = 'profile' | 'ownership' | 'relationships' | 'sessions' | 'ticks' | 'authentication';
export interface ConsolidationDomainHandler {
  readonly name: ConsolidationDomain;
  /** Exact schema.table.column user references this reviewed handler owns. */
  readonly userReferences: readonly string[];
  apply(
    transaction: ConsolidationTransaction,
    context: ConsolidationContext,
  ): Promise<Readonly<Record<string, number>>>;
}
export interface ConsolidationExecutionHooks {
  /** Must verify the actual deployed writer drain; never a caller-supplied boolean. */
  verifyMaintenance(transaction: ConsolidationTransaction): Promise<void>;
  /** Must compare every touched row/session/alias/credential preimage before any mutation. */
  revalidateGroup(transaction: ConsolidationTransaction, context: ConsolidationContext): Promise<void>;
  captureAfterGroupFingerprint(transaction: ConsolidationTransaction, context: ConsolidationContext): Promise<string>;
  finalizeDerivedState(transaction: ConsolidationTransaction, context: ConsolidationContext): Promise<void>;
  readonly domains: readonly ConsolidationDomainHandler[];
}
const ORDER: readonly ConsolidationDomain[] = [
  'profile',
  'ownership',
  'relationships',
  'sessions',
  'ticks',
  'authentication',
];
export async function applyAccountConsolidationGroup(
  database: PostgresJsDatabase,
  options: {
    readonly plan: AccountConsolidationPlan;
    readonly group: ConsolidationGroupPlan;
    readonly expectedPlanSha256: string;
    readonly batchId: string;
    readonly mergeId: string;
  },
  hooks: ConsolidationExecutionHooks,
) {
  if (
    fingerprintConsolidationPlan(options.plan) !== options.expectedPlanSha256 ||
    !options.batchId ||
    !options.mergeId ||
    !options.plan.groups.includes(options.group) ||
    !options.group.survivorUserId ||
    options.group.blockers.length !== 0 ||
    ORDER.some((name) => hooks.domains.filter((handler) => handler.name === name).length !== 1) ||
    hooks.domains.length !== ORDER.length
  )
    throw new ConsolidationError('UNSAFE_PLAN');
  const sourceIds = options.group.memberUserIds.filter((userId) => userId !== options.group.survivorUserId).sort();
  const coveredReferences = hooks.domains.flatMap((handler) => [...handler.userReferences]);
  if (
    sourceIds.length === 0 ||
    JSON.stringify(sourceIds) !== JSON.stringify([...options.group.sourceUserIds].sort()) ||
    new Set(coveredReferences).size !== coveredReferences.length
  )
    throw new ConsolidationError('UNSAFE_PLAN');
  const context: ConsolidationContext = {
    batchId: options.batchId,
    mergeId: options.mergeId,
    survivorUserId: options.group.survivorUserId,
    sourceUserIds: options.group.sourceUserIds,
    group: options.group,
  };
  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_catalog.set_config('lock_timeout','2000ms',true),pg_catalog.set_config('statement_timeout','60000ms',true)`,
      );
      await lockAuthorityGateExclusively(transaction);
      await hooks.verifyMaintenance(transaction);
      const beforeFingerprint = consolidationDigest(JSON.stringify(options.group));
      const [previous] = await transaction
        .select()
        .from(accountConsolidationGroupAudits)
        .where(eq(accountConsolidationGroupAudits.mergeId, options.mergeId));
      if (previous) {
        if (previous.batchId !== options.batchId || previous.beforeFingerprint !== beforeFingerprint)
          throw new ConsolidationError('UNSAFE_PLAN');
        return { status: 'already-applied' as const, counts: previous.counts };
      }
      const [batch] = await transaction
        .select()
        .from(accountConsolidationBatches)
        .where(eq(accountConsolidationBatches.batchId, options.batchId))
        .for('update');
      if (
        !batch ||
        batch.planSha256 !== options.expectedPlanSha256 ||
        batch.policyVersion !== 2 ||
        batch.status !== 'applying'
      )
        throw new ConsolidationError('UNSAFE_PLAN');
      for (const userId of [...options.group.memberUserIds].sort())
        await acquireUserTickMutationLock(transaction, userId);
      const current = await transaction
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, [...options.group.memberUserIds]))
        .orderBy(users.id)
        .for('update');
      if (
        current.length !== options.group.memberUserIds.length ||
        current.some((member) => member.email.trim().toLowerCase() !== options.group.normalizedEmail)
      )
        throw new ConsolidationError('INVALID_EVIDENCE');
      const normalizedOwners = await transaction
        .select({ id: users.id })
        .from(users)
        .where(sql`${sqlAccountKey(sql`${users.email}`)}=${options.group.normalizedEmail}`);
      if (
        normalizedOwners.length !== current.length ||
        normalizedOwners.some((member) => !options.group.memberUserIds.includes(member.id))
      )
        throw new ConsolidationError('INVALID_EVIDENCE');
      const references = await transaction.execute<{
        schema: string;
        table: string;
        column: string;
      }>(sql`SELECT DISTINCT namespace.nspname::text AS schema,relation.relname::text AS table,column_row.attname::text AS column
   FROM pg_catalog.pg_constraint constraint_row JOIN pg_catalog.pg_class relation ON relation.oid=constraint_row.conrelid
   JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
   CROSS JOIN LATERAL ROWS FROM(pg_catalog.unnest(constraint_row.conkey),pg_catalog.unnest(constraint_row.confkey)) pair(attnum,referenced_attnum)
   JOIN pg_catalog.pg_attribute column_row ON column_row.attrelid=constraint_row.conrelid AND column_row.attnum=pair.attnum
   JOIN pg_catalog.pg_attribute target_column ON target_column.attrelid=constraint_row.confrelid AND target_column.attnum=pair.referenced_attnum
   WHERE constraint_row.contype='f' AND constraint_row.confrelid='public.users'::pg_catalog.regclass AND constraint_row.conparentid=0 AND target_column.attname='id'
   ORDER BY 1,2,3 LIMIT 1001`);
      if (references.length > 1000) throw new ConsolidationError('INPUT_LIMIT');
      const handled = new Set(hooks.domains.flatMap((handler) => [...handler.userReferences]));
      for (const reference of references) {
        if (handled.has(`${reference.schema}.${reference.table}.${reference.column}`)) continue;
        const rows = await transaction.execute<{ exists: boolean }>(
          sql`SELECT EXISTS(SELECT 1 FROM ${sql.identifier(reference.schema)}.${sql.identifier(reference.table)} WHERE ${sql.identifier(reference.column)} IN (${sql.join(
            context.sourceUserIds.map((userId) => sql`${userId}`),
            sql`, `,
          )})) AS exists`,
        );
        if (rows[0]?.exists !== false) throw new ConsolidationError('UNSAFE_PLAN');
      }
      await hooks.revalidateGroup(transaction, context);
      const counts: Record<string, number> = {};
      for (const name of ORDER) {
        const handler = hooks.domains.find((entry) => entry.name === name)!;
        const result = await handler.apply(transaction, context);
        for (const [key, count] of Object.entries(result)) {
          if (!Number.isSafeInteger(count) || count < 0) throw new ConsolidationError('UNSAFE_PLAN');
          counts[`${name}.${key}`] = count;
        }
      }
      await hooks.finalizeDerivedState(transaction, context);
      // Group commit evidence precedes the batch final global derived-ranking refresh.
      const afterFingerprint = await hooks.captureAfterGroupFingerprint(transaction, context);
      if (!/^[a-f0-9]{64}$/.test(afterFingerprint)) throw new ConsolidationError('UNSAFE_PLAN');
      await transaction.insert(accountConsolidationGroupAudits).values({
        mergeId: options.mergeId,
        batchId: options.batchId,
        groupReference: consolidationDigest(
          JSON.stringify([options.group.normalizedEmail, options.group.memberUserIds]),
        ),
        beforeFingerprint,
        afterFingerprint,
        counts,
      });
      return { status: 'applied' as const, counts };
    },
    { isolationLevel: 'read committed' },
  );
}
