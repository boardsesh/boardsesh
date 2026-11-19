/** Read-only merge planning. No apply mode, no secrets selected, no automatic survivor. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { explicitReadOnlyConnectionOptions } from '../auth/email-audit/connection';
import {
  ACCOUNT_EMAIL_EVIDENCE_LIMITS,
  AccountEmailEvidenceError,
  type AccountEmailEvidenceErrorCode,
} from '../auth/email-audit/evidence';
import { buildAccountEmailMergePreview } from '../auth/email-audit/merge-preview';
import { collectAccountEmailMergePreview } from '../auth/email-audit/merge-snapshot';
import { PrivateFileError, writePrivateFileExclusively } from '../auth/email-audit/private-file';
import {
  ACCOUNT_EMAIL_EVIDENCE_HINTS,
  parseAccountEmailEvidenceArguments,
  resolveWorksheetPath,
  type AccountEmailEvidenceArguments,
} from './account-email-evidence';

export const ACCOUNT_EMAIL_MERGE_PREVIEW_DATABASE_URL_VARIABLE = 'ACCOUNT_EMAIL_MERGE_PREVIEW_DATABASE_URL';

export async function runAccountEmailMergePreview(
  arguments_: AccountEmailEvidenceArguments,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const worksheetPath = resolveWorksheetPath(arguments_.out);
  let connectionOptions: ReturnType<typeof explicitReadOnlyConnectionOptions>;
  try {
    connectionOptions = explicitReadOnlyConnectionOptions(
      environment[ACCOUNT_EMAIL_MERGE_PREVIEW_DATABASE_URL_VARIABLE],
      environment.DEBUG_SQL,
      {
        applicationName: 'boardsesh_account_email_merge_preview',
        targetSessionAttrs: 'read-only',
        statementTimeoutMs: ACCOUNT_EMAIL_EVIDENCE_LIMITS.statementTimeoutMs,
        lockTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 120000,
        maxLifetimeSeconds: 3600,
      },
    );
  } catch {
    throw new AccountEmailEvidenceError('CONFIGURATION');
  }
  const client = postgres(connectionOptions);
  let collected: Awaited<ReturnType<typeof collectAccountEmailMergePreview>> | undefined;
  let failure: AccountEmailEvidenceError | undefined;
  let timedOut = false;
  let interruptedClose: Promise<void> | undefined;
  let closeFailed = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    interruptedClose = client.end({ timeout: 1 }).catch(() => {
      closeFailed = true;
    });
  }, ACCOUNT_EMAIL_EVIDENCE_LIMITS.maximumMs);
  try {
    collected = await collectAccountEmailMergePreview(client, { allowPrimary: arguments_.allowPrimary });
  } catch (error) {
    failure =
      error instanceof AccountEmailEvidenceError ? error : new AccountEmailEvidenceError('SNAPSHOT_UNAVAILABLE');
  }
  clearTimeout(deadline);
  try {
    if (interruptedClose) await interruptedClose;
    else await client.end({ timeout: 5 });
  } catch {
    closeFailed = true;
  }
  if (timedOut) failure = new AccountEmailEvidenceError('TIME_LIMIT');
  if (closeFailed) failure = new AccountEmailEvidenceError('SNAPSHOT_UNAVAILABLE');
  if (failure) throw failure;
  if (!collected) throw new AccountEmailEvidenceError('SNAPSHOT_UNAVAILABLE');
  const report = buildAccountEmailMergePreview(collected.evidence, collected.conflicts);
  let written: { readonly sha256: string; readonly bytes: number };
  try {
    written = writePrivateFileExclusively(
      worksheetPath,
      [`${JSON.stringify(report, null, 2)}\n`],
      ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxWorksheetBytes,
      { removeOnFailure: true },
    );
  } catch (error) {
    if (error instanceof PrivateFileError && error.code === 'EXISTS')
      throw new AccountEmailEvidenceError('OUTPUT_EXISTS');
    if (error instanceof PrivateFileError && error.code === 'LIMIT') throw new AccountEmailEvidenceError('INPUT_LIMIT');
    throw new AccountEmailEvidenceError('OUTPUT_UNAVAILABLE');
  }
  return {
    formatVersion: 1,
    status: 'complete' as const,
    snapshot: report.snapshot,
    ...report.summary,
    worksheet: written,
    connectionClosed: true,
    completedAt: new Date().toISOString(),
  };
}

export async function runAccountEmailMergePreviewCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  write: (text: string) => void,
): Promise<number> {
  try {
    const receipt = await runAccountEmailMergePreview(parseAccountEmailEvidenceArguments(arguments_), environment);
    write(`${JSON.stringify(receipt, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code: AccountEmailEvidenceErrorCode =
      error instanceof AccountEmailEvidenceError ? error.code : 'SNAPSHOT_UNAVAILABLE';
    const hint =
      code === 'CONFIGURATION'
        ? `Set ${ACCOUNT_EMAIL_MERGE_PREVIEW_DATABASE_URL_VARIABLE}, leave DEBUG_SQL off, and pass only --out <file> and optionally --allow-primary.`
        : ACCOUNT_EMAIL_EVIDENCE_HINTS[code];
    write(`${JSON.stringify({ formatVersion: 1, status: 'incomplete', code, hint }, null, 2)}\n`);
    return 1;
  }
}

async function main() {
  let output = '';
  const exitCode = await runAccountEmailMergePreviewCli(process.argv.slice(2), process.env, (text) => {
    output += text;
  });
  const outputDeadline = setTimeout(() => process.exit(exitCode), 1000);
  process.stdout.write(output, () => {
    clearTimeout(outputDeadline);
    process.exit(exitCode);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
