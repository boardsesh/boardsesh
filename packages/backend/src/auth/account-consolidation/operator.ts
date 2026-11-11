/** Bounded operator batch execution; every group commits independently and can be resumed. */
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PgBoss } from 'pg-boss';
import { randomUUID, createHash } from 'node:crypto';
import { openSync, writeFileSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountConsolidationBatches } from '@boardsesh/db/schema/auth';
import { writePrivateFileExclusively } from '../email-audit/private-file';
import { resolveWorksheetPath } from '../../scripts/account-email-evidence';
import { applyAccountConsolidationGroup, type ConsolidationContext } from './executor';
import {
  ConsolidationError,
  consolidationDigest,
  fingerprintConsolidationPlan,
  type AccountConsolidationPlan,
} from './planner';
import { createConsolidationRuntime } from './runtime';
import { verifyPostgresMaintenanceFence } from './maintenance';

export async function applyConsolidationBatch(
  database: PostgresJsDatabase,
  boss: PgBoss,
  options: {
    readonly plan: AccountConsolidationPlan;
    readonly expectedPlanSha256: string;
    readonly batchId: string;
    readonly receiptPath: string;
  },
) {
  const { plan, batchId } = options;
  if (
    !/^[a-f0-9]{64}$/.test(options.expectedPlanSha256) ||
    fingerprintConsolidationPlan(plan) !== options.expectedPlanSha256 ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(batchId) ||
    plan.document !== 'boardsesh-account-consolidation-plan' ||
    plan.formatVersion !== 1 ||
    plan.policyVersion !== 'lowercase-consolidation-v1' ||
    !plan.groups.length ||
    plan.groups.length > 1000 ||
    plan.groups.some((group) => !group.referenceState || group.blockers.length || !group.survivorUserId)
  )
    throw new ConsolidationError('UNSAFE_PLAN');
  // The private output directory and exclusive final receipt are checked before any transaction.
  const receiptPath = resolveWorksheetPath(options.receiptPath);
  const receiptDescriptor = openSync(receiptPath, 'wx', 0o600);
  const startedReceipt = `${JSON.stringify({ formatVersion: 1, batchId, status: 'started', planSha256: options.expectedPlanSha256 })}\n`;
  writeFileSync(receiptDescriptor, startedReceipt);
  fsyncSync(receiptDescriptor);
  const attemptId = randomUUID();
  const archives: { filename: string; sha256: string; bytes: number }[] = [];
  let archiveBytes = 0;
  const archivePreimages = async (
    context: ConsolidationContext,
    domain: string,
    preimages: Readonly<Record<string, unknown>>,
  ) => {
    const bytes = `${JSON.stringify({ batchId, mergeId: context.mergeId, domain, preimages }, (_, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry))}\n`;
    archiveBytes += Buffer.byteLength(bytes);
    if (archiveBytes > 67108864 || archives.length >= 10000) throw new ConsolidationError('INPUT_LIMIT');
    const filename = join(dirname(receiptPath), `${attemptId}-${archives.length}.preimage.json`);
    const artifact = writePrivateFileExclusively(filename, [bytes], 16777216);
    archives.push({ filename, ...artifact });
  };
  const hooks = createConsolidationRuntime({ boss, archivePreimages });
  const applied: { mergeId: string; status: string; counts: Readonly<Record<string, number>> }[] = [];
  const startedAt = Date.now();
  let failure: unknown;
  try {
    await database.transaction(async (transaction) => {
      await verifyPostgresMaintenanceFence(transaction);
      const [existing] = await transaction
        .select()
        .from(accountConsolidationBatches)
        .where(eq(accountConsolidationBatches.batchId, batchId))
        .for('update');
      if (existing && (existing.planSha256 !== options.expectedPlanSha256 || existing.policyVersion !== 1))
        throw new ConsolidationError('UNSAFE_PLAN');
      if (!existing)
        await transaction
          .insert(accountConsolidationBatches)
          .values({ batchId, planSha256: options.expectedPlanSha256, policyVersion: 1, status: 'applying' });
      else if (existing.status !== 'applied')
        await transaction
          .update(accountConsolidationBatches)
          .set({ status: 'applying' })
          .where(eq(accountConsolidationBatches.batchId, batchId));
    });
    for (const group of plan.groups) {
      if (Date.now() - startedAt > 300000) throw new ConsolidationError('INPUT_LIMIT');
      const mergeId = consolidationDigest(JSON.stringify([batchId, [...group.memberUserIds].sort()]));
      const result = await applyAccountConsolidationGroup(
        database,
        { plan, group, expectedPlanSha256: options.expectedPlanSha256, batchId, mergeId },
        hooks,
      );
      applied.push({ mergeId, ...result });
    }
    await database.transaction(async (transaction) => {
      await verifyPostgresMaintenanceFence(transaction);
      await transaction
        .update(accountConsolidationBatches)
        .set({ status: 'applied', completedAt: new Date() })
        .where(eq(accountConsolidationBatches.batchId, batchId));
    });
  } catch (error) {
    failure = error;
  }
  const receipt = {
    formatVersion: 1,
    batchId,
    planSha256: options.expectedPlanSha256,
    status: failure ? 'incomplete' : 'applied',
    applied,
    archives,
  };
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    writeFileSync(receiptDescriptor, receiptBytes);
    fsyncSync(receiptDescriptor);
  } finally {
    closeSync(receiptDescriptor);
  }
  const artifact = {
    sha256: createHash('sha256').update(startedReceipt).update(receiptBytes).digest('hex'),
    bytes: Buffer.byteLength(startedReceipt) + Buffer.byteLength(receiptBytes),
  };
  if (failure) throw failure instanceof ConsolidationError ? failure : new ConsolidationError('DATABASE');
  return { batchId, status: 'applied' as const, groups: applied.length, receipt: artifact };
}
