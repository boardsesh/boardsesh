/** BA-02 owner tool. Default plan mode reads only; apply requires the exact private plan SHA-256. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { explicitReadOnlyConnectionOptions } from '../auth/email-audit/connection';
import { writePrivateFileExclusively } from '../auth/email-audit/private-file';
import { resolveWorksheetPath } from './account-email-evidence';
import {
  applyResolutionPlan,
  buildResolutionPlan,
  digest,
  EmailResolutionError,
  parseDecisions,
  parseWorksheet,
  type ResolutionPlan,
} from '../auth/email-resolution/resolution';

const privateText = z.string().min(1).max(4096);
const memberSchema = z
  .object({
    userId: privateText,
    before: privateText,
    after: privateText,
    action: z.enum(['keep', 'retire', 'normalize']),
  })
  .strict();
const planSchema = z
  .object({
    formatVersion: z.literal(1),
    document: z.literal('boardsesh-account-email-resolution'),
    batchId: z.string().uuid(),
    unselectedGroups: z.number().int().nonnegative().max(2000),
    targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    decisionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    groups: z
      .array(
        z
          .object({
            label: z.string().regex(/^(?:G|S)\d{1,6}$/),
            reference: z.string().regex(/^[a-f0-9]{64}$/),
            address: privateText,
            evidenceKind: z.enum(['owner-knows', 'batch-approved', 'mailbox-reply', 'no-reply-14-days']),
            members: z.array(memberSchema).min(1).max(2000),
            status: z.enum(['ready', 'skipped', 'deferred']),
          })
          .strict(),
      )
      .max(100000),
  })
  .strict();

export interface ResolutionArguments {
  readonly apply: boolean;
  readonly planFile: string;
  readonly confirmHost: string;
  readonly evidence?: string;
  readonly decisions?: string;
  readonly planSha256?: string;
  readonly swapKeeper?: string;
}

export function parseResolutionArguments(arguments_: readonly string[]): ResolutionArguments {
  const options = new Map<string, string>();
  let mode: 'plan' | 'apply' | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === '--plan' || flag === '--apply') {
      if (mode) throw new EmailResolutionError('CONFIGURATION');
      mode = flag === '--apply' ? 'apply' : 'plan';
    } else {
      if (
        !['--plan-file', '--confirm-host', '--evidence', '--decisions', '--plan-sha256', '--swap-keeper'].includes(
          flag,
        ) ||
        options.has(flag) ||
        !arguments_[index + 1] ||
        arguments_[index + 1].startsWith('-')
      )
        throw new EmailResolutionError('CONFIGURATION');
      options.set(flag, arguments_[index + 1]);
      index += 1;
    }
  }
  const planFile = options.get('--plan-file');
  const confirmHost = options.get('--confirm-host');
  const evidence = options.get('--evidence');
  const decisions = options.get('--decisions');
  const planSha256 = options.get('--plan-sha256');
  const swapKeeper = options.get('--swap-keeper');
  if (
    !planFile ||
    !confirmHost ||
    (mode === 'apply'
      ? !planSha256 || !!evidence || !!decisions || !!swapKeeper
      : !evidence || !decisions || !!planSha256) ||
    (planSha256 && !/^[0-9a-f]{64}$/.test(planSha256)) ||
    (swapKeeper && !/^G\d{2,4}$/.test(swapKeeper))
  )
    throw new EmailResolutionError('CONFIGURATION');
  return { apply: mode === 'apply', planFile, confirmHost, evidence, decisions, planSha256, swapKeeper };
}

/** Input and output have the same repository exclusion and private-folder rules. Never prints paths. */
export function readResolutionPrivateFile(path: string): string {
  let descriptor: number | undefined;
  try {
    const absolute = resolve(path);
    const folder = realpathSync(dirname(absolute));
    for (let ancestor = folder; ; ancestor = dirname(ancestor)) {
      try {
        lstatSync(join(ancestor, '.git'));
        throw new EmailResolutionError('PRIVATE_FILE');
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (dirname(ancestor) === ancestor) break;
    }
    const folderMetadata = statSync(folder);
    if (
      !folderMetadata.isDirectory() ||
      folderMetadata.uid !== process.getuid?.() ||
      (folderMetadata.mode & 0o777) !== 0o700
    )
      throw new EmailResolutionError('PRIVATE_FILE');
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > 16777216
    )
      throw new EmailResolutionError('PRIVATE_FILE');
    return readFileSync(descriptor, 'utf8');
  } catch {
    throw new EmailResolutionError('PRIVATE_FILE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function resolutionConnectionOptions(
  databaseUrl: string | undefined,
  debugSql: string | undefined,
  confirmHost: string,
  apply: boolean,
) {
  if (debugSql !== undefined && debugSql !== '' && debugSql !== 'false' && debugSql !== '0')
    throw new EmailResolutionError('CONFIGURATION');
  try {
    const options = explicitReadOnlyConnectionOptions(databaseUrl, debugSql, {
      applicationName: 'boardsesh_account_email_resolution',
      targetSessionAttrs: 'primary',
      statementTimeoutMs: 10000,
      lockTimeoutMs: 2000,
      idleInTransactionTimeoutMs: 15000,
      maxLifetimeSeconds: 900,
    });
    if (options.host !== confirmHost) throw new EmailResolutionError('CONFIGURATION');
    return { ...options, connection: { ...options.connection, default_transaction_read_only: !apply } };
  } catch {
    throw new EmailResolutionError('CONFIGURATION');
  }
}

export async function runResolutionCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  write: (contents: string) => void,
): Promise<number> {
  let client: ReturnType<typeof postgres> | undefined;
  try {
    const argumentsParsed = parseResolutionArguments(arguments_);
    const connectionOptions = resolutionConnectionOptions(
      environment.ACCOUNT_EMAIL_RESOLVE_DATABASE_URL,
      environment.DEBUG_SQL,
      argumentsParsed.confirmHost,
      argumentsParsed.apply,
    );
    const targetFingerprint = digest(
      `${connectionOptions.host}:${connectionOptions.port}/${connectionOptions.database}`,
    );
    let plan: ResolutionPlan;
    let planText: string;
    let outputPath: string | undefined;
    if (argumentsParsed.apply) {
      planText = readResolutionPrivateFile(argumentsParsed.planFile);
      if (digest(planText) !== argumentsParsed.planSha256) throw new EmailResolutionError('PLAN_HASH');
      plan = planSchema.parse(JSON.parse(planText));
      if (plan.targetFingerprint !== targetFingerprint) throw new EmailResolutionError('CONFIGURATION');
    } else {
      const evidenceText = readResolutionPrivateFile(argumentsParsed.evidence!);
      const decisionsText = readResolutionPrivateFile(argumentsParsed.decisions!);
      const evidenceSha256 = digest(evidenceText);
      const worksheet = parseWorksheet(JSON.parse(evidenceText));
      const decisions = parseDecisions(JSON.parse(decisionsText), evidenceSha256);
      outputPath = resolveWorksheetPath(argumentsParsed.planFile);
      client = postgres(connectionOptions);
      plan = await buildResolutionPlan(drizzle(client), worksheet, decisions, {
        evidenceSha256,
        decisionsSha256: digest(decisionsText),
        targetFingerprint,
        swapKeeper: argumentsParsed.swapKeeper,
      });
      planText = `${JSON.stringify(plan, null, 2)}\n`;
    }
    let counts: { applied?: number; ready?: number; skipped: number; deferred: number };
    if (argumentsParsed.apply) {
      client = postgres(connectionOptions);
      counts = await applyResolutionPlan(drizzle(client), plan);
    } else
      counts = {
        ready: plan.groups.filter((group) => group.status === 'ready').length,
        skipped: plan.groups.filter((group) => group.status === 'skipped').length,
        deferred: plan.groups.filter((group) => group.status === 'deferred').length,
      };
    await client?.end({ timeout: 5 });
    client = undefined;
    if (outputPath) writePrivateFileExclusively(outputPath, [planText], 16777216, { removeOnFailure: true });
    write(
      `${JSON.stringify({
        status: 'complete',
        mode: argumentsParsed.apply ? 'apply' : 'plan',
        unselected: plan.unselectedGroups,
        ...counts,
        planSha256: digest(planText),
        connectionClosed: true,
      })}\n`,
    );
    return 0;
  } catch (error) {
    await client?.end({ timeout: 1 }).catch(() => {});
    write(
      `${JSON.stringify({ status: 'refused', code: error instanceof EmailResolutionError ? error.code : 'DATABASE' })}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runResolutionCli(process.argv.slice(2), process.env, (contents) => process.stdout.write(contents)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
  );
}
