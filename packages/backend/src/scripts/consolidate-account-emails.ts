/** Private planning and separately SHA-approved maintenance-window execution. */
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import { jobQueueTransactionAdapter } from '@boardsesh/db/background-jobs';
import { applyConsolidationBatch } from './account-consolidation/operator';
import { verifyPostgresMaintenanceFence } from './account-consolidation/maintenance';
import { fingerprintConsolidationPlan, type AccountConsolidationPlan } from './account-consolidation/planner';
import { z } from 'zod';
import { explicitReadOnlyConnectionOptions } from '../auth/email-audit/connection';
import { writePrivateFileExclusively } from '../auth/email-audit/private-file';
import { resolveWorksheetPath } from './account-email-evidence';
import {
  buildAccountConsolidationPlan,
  consolidationDigest,
  ConsolidationError,
  type ApprovedConsolidationException,
} from './account-consolidation/planner';
import { collectAccountConsolidationSnapshot } from './account-consolidation/snapshot';

export const ACCOUNT_CONSOLIDATION_DATABASE_URL_VARIABLE = 'ACCOUNT_CONSOLIDATION_DATABASE_URL';
export interface ConsolidationArguments {
  readonly out: string;
  readonly allowPrimary: boolean;
  readonly exceptionsFile?: string;
  readonly priorPlanFile?: string;
}
export function parseConsolidationArguments(arguments_: readonly string[]): ConsolidationArguments {
  let out: string | undefined;
  let exceptionsFile: string | undefined;
  let priorPlanFile: string | undefined;
  let allowPrimary = false;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === '--plan') continue;
    if (argument === '--out' && !out && next && !next.startsWith('-')) {
      out = next;
      index++;
    } else if (argument === '--exceptions' && !exceptionsFile && next && !next.startsWith('-')) {
      exceptionsFile = next;
      index++;
    } else if (argument === '--prior-plan' && !priorPlanFile && next && !next.startsWith('-')) {
      priorPlanFile = next;
      index++;
    } else if (argument === '--allow-primary' && !allowPrimary) allowPrimary = true;
    else throw new ConsolidationError('CONFIGURATION');
  }
  if (!out || Boolean(exceptionsFile) !== Boolean(priorPlanFile)) throw new ConsolidationError('CONFIGURATION');
  return {
    out,
    allowPrimary,
    ...(exceptionsFile ? { exceptionsFile } : {}),
    ...(priorPlanFile ? { priorPlanFile } : {}),
  };
}
const exceptionSchema = z
  .object({
    formatVersion: z.literal(1),
    sourceEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    priorPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
    groups: z
      .array(
        z
          .object({
            normalizedEmail: z.string().min(1).max(4096),
            survivorUserId: z.string().min(1).max(4096),
            memberUserIds: z.array(z.string().min(1).max(4096)).min(2).max(1000),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
function readExceptions(filename: string, priorPlanFile: string): readonly ApprovedConsolidationException[] {
  let descriptor: number | undefined;
  let priorDescriptor: number | undefined;
  try {
    priorDescriptor = openSync(resolve(priorPlanFile), constants.O_RDONLY | constants.O_NOFOLLOW);
    const priorMetadata = fstatSync(priorDescriptor);
    if (
      !priorMetadata.isFile() ||
      priorMetadata.uid !== process.getuid?.() ||
      (priorMetadata.mode & 0o777) !== 0o600 ||
      priorMetadata.size > 16777216
    )
      throw new ConsolidationError('PRIVATE_FILE');
    const priorBytes = readFileSync(priorDescriptor, 'utf8');
    const prior = z
      .object({
        document: z.literal('boardsesh-account-consolidation-plan'),
        sourceEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
        groups: z
          .array(
            z.object({
              normalizedEmail: z.string().max(4096),
              memberUserIds: z.array(z.string().max(4096)).min(2).max(1000),
            }),
          )
          .max(1000),
      })
      .safeParse(JSON.parse(priorBytes));
    if (!prior.success) throw new ConsolidationError('INVALID_EVIDENCE');
    descriptor = openSync(resolve(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > 1048576
    )
      throw new ConsolidationError('PRIVATE_FILE');
    const parsed = exceptionSchema.safeParse(JSON.parse(readFileSync(descriptor, 'utf8')));
    if (
      !parsed.success ||
      parsed.data.sourceEvidenceSha256 !== prior.data.sourceEvidenceSha256 ||
      parsed.data.priorPlanSha256 !== consolidationDigest(priorBytes)
    )
      throw new ConsolidationError('INVALID_EVIDENCE');
    for (const approval of parsed.data.groups) {
      const original = prior.data.groups.find((group) => group.normalizedEmail === approval.normalizedEmail);
      if (
        !original ||
        JSON.stringify([...original.memberUserIds].sort()) !== JSON.stringify([...approval.memberUserIds].sort())
      )
        throw new ConsolidationError('INVALID_EVIDENCE');
    }
    return parsed.data.groups;
  } catch (error) {
    if (error instanceof ConsolidationError) throw error;
    throw new ConsolidationError('PRIVATE_FILE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (priorDescriptor !== undefined) closeSync(priorDescriptor);
  }
}
export async function runAccountConsolidationPlan(
  arguments_: ConsolidationArguments,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const destination = resolveWorksheetPath(arguments_.out);
  let options: ReturnType<typeof explicitReadOnlyConnectionOptions>;
  try {
    options = explicitReadOnlyConnectionOptions(
      environment[ACCOUNT_CONSOLIDATION_DATABASE_URL_VARIABLE],
      environment.DEBUG_SQL,
      {
        applicationName: 'boardsesh_account_consolidation_plan',
        targetSessionAttrs: 'read-only',
        statementTimeoutMs: 60000,
        lockTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 120000,
        maxLifetimeSeconds: 3600,
      },
    );
  } catch {
    throw new ConsolidationError('CONFIGURATION');
  }
  const client = postgres(options);
  let timedOut = false;
  let forcedClose: Promise<void> | undefined;
  let forcedCloseFailed = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    forcedClose = client.end({ timeout: 1 }).catch(() => {
      forcedCloseFailed = true;
    });
  }, 900000);
  let snapshot: Awaited<ReturnType<typeof collectAccountConsolidationSnapshot>> | undefined;
  let failed = false;
  try {
    snapshot = await collectAccountConsolidationSnapshot(client, arguments_.allowPrimary);
  } catch {
    failed = true;
  }
  clearTimeout(deadline);
  try {
    if (forcedClose) await forcedClose;
    else await client.end({ timeout: 5 });
  } catch {
    failed = true;
  }
  if (failed || timedOut || forcedCloseFailed || !snapshot) throw new ConsolidationError('DATABASE');
  const sourceEvidenceSha256 = consolidationDigest(JSON.stringify(snapshot.worksheet));
  const approvedExceptions = arguments_.exceptionsFile
    ? readExceptions(arguments_.exceptionsFile, arguments_.priorPlanFile!)
    : [];
  const plan = buildAccountConsolidationPlan(snapshot.worksheet, snapshot.ticks, {
    evidenceSha256: sourceEvidenceSha256,
    approvedExceptions,
    referenceStates: snapshot.referenceStates,
  });
  const bytes = `${JSON.stringify(plan, null, 2)}\n`;
  let artifact: ReturnType<typeof writePrivateFileExclusively>;
  try {
    artifact = writePrivateFileExclusively(destination, [bytes], 16777216, { removeOnFailure: true });
  } catch {
    throw new ConsolidationError('PRIVATE_FILE');
  }
  return {
    formatVersion: 1,
    status: 'complete' as const,
    snapshot: plan.snapshot,
    ...plan.summary,
    codeAvailable: true,
    executionAvailable: false,
    sourceEvidenceSha256,
    plan: artifact,
    connectionClosed: true,
  };
}
export interface ConsolidationApplyArguments {
  readonly planFile: string;
  readonly expectedPlanSha256: string;
  readonly batchId: string;
  readonly out: string;
}
export function parseConsolidationApplyArguments(arguments_: readonly string[]): ConsolidationApplyArguments {
  const parsed = new Map<string, string>();
  if (arguments_[0] !== '--apply') throw new ConsolidationError('CONFIGURATION');
  for (let index = 1; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const argument = arguments_[index + 1];
    if (
      !['--plan-file', '--expected-plan-sha256', '--batch-id', '--out'].includes(key) ||
      parsed.has(key) ||
      !argument ||
      argument.startsWith('-')
    )
      throw new ConsolidationError('CONFIGURATION');
    parsed.set(key, argument);
  }
  if (parsed.size !== 4 || !/^[a-f0-9]{64}$/.test(parsed.get('--expected-plan-sha256')!))
    throw new ConsolidationError('CONFIGURATION');
  return {
    planFile: parsed.get('--plan-file')!,
    expectedPlanSha256: parsed.get('--expected-plan-sha256')!,
    batchId: parsed.get('--batch-id')!,
    out: parsed.get('--out')!,
  };
}
function readApprovedPlan(arguments_: ConsolidationApplyArguments): AccountConsolidationPlan {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(resolve(arguments_.planFile), constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > 16777216
    )
      throw new ConsolidationError('PRIVATE_FILE');
    const bytes = readFileSync(descriptor, 'utf8');
    if (consolidationDigest(bytes) !== arguments_.expectedPlanSha256) throw new ConsolidationError('INVALID_EVIDENCE');
    const parsed: unknown = JSON.parse(bytes);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('document' in parsed) ||
      parsed.document !== 'boardsesh-account-consolidation-plan'
    )
      throw new ConsolidationError('INVALID_EVIDENCE');
    // The exact SHA is separately approved, and the coordinator validates all mutation preconditions.
    const plan = parsed as AccountConsolidationPlan;
    if (fingerprintConsolidationPlan(plan) !== arguments_.expectedPlanSha256)
      throw new ConsolidationError('INVALID_EVIDENCE');
    return plan;
  } catch (error) {
    throw error instanceof ConsolidationError ? error : new ConsolidationError('INVALID_EVIDENCE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export async function runAccountConsolidationApply(
  arguments_: ConsolidationApplyArguments,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const plan = readApprovedPlan(arguments_);
  resolveWorksheetPath(arguments_.out);
  const profile = explicitReadOnlyConnectionOptions(
    environment[ACCOUNT_CONSOLIDATION_DATABASE_URL_VARIABLE],
    environment.DEBUG_SQL,
    {
      applicationName: 'boardsesh_account_consolidation_apply',
      targetSessionAttrs: 'primary',
      statementTimeoutMs: 60000,
      lockTimeoutMs: 2000,
      idleInTransactionTimeoutMs: 120000,
      maxLifetimeSeconds: 600,
    },
  );
  const client = postgres({ ...profile, connection: { ...profile.connection, default_transaction_read_only: false } });
  const database = drizzle(client);
  // Reuse the single explicit operator connection; no ambient pool or background queue maintenance.
  const boss = new PgBoss({
    db: jobQueueTransactionAdapter(database),
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    reindex: false,
  });
  boss.on('error', () => {});
  try {
    await database.transaction(verifyPostgresMaintenanceFence);
    await boss.start();
    return await applyConsolidationBatch(database, boss, {
      plan,
      expectedPlanSha256: arguments_.expectedPlanSha256,
      batchId: arguments_.batchId,
      receiptPath: arguments_.out,
    });
  } finally {
    try {
      await boss.stop({ graceful: false, close: false });
    } finally {
      await client.end({ timeout: 5 });
    }
  }
}
export async function runAccountConsolidationCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  write: (text: string) => void,
): Promise<number> {
  try {
    const receipt =
      arguments_[0] === '--apply'
        ? await runAccountConsolidationApply(parseConsolidationApplyArguments(arguments_), environment)
        : await runAccountConsolidationPlan(parseConsolidationArguments(arguments_), environment);
    write(`${JSON.stringify(receipt, null, 2)}\n`);
    return 0;
  } catch (error) {
    write(
      `${JSON.stringify({ formatVersion: 1, status: 'incomplete', code: error instanceof ConsolidationError ? error.code : 'DATABASE' }, null, 2)}\n`,
    );
    return 1;
  }
}
async function main() {
  let output = '';
  const code = await runAccountConsolidationCli(process.argv.slice(2), process.env, (chunk) => {
    output += chunk;
  });
  const timeout = setTimeout(() => process.exit(code), 1000);
  process.stdout.write(output, () => {
    clearTimeout(timeout);
    process.exit(code);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
