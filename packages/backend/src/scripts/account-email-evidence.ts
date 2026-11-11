/**
 * BA-02 PR 3: private evidence report for shared account emails.
 *
 * Read-only. One REPEATABLE READ READ ONLY snapshot, preferably on the DR
 * standby. Writes one private worksheet (addresses, names, user IDs) to the
 * path given with --out and never overwrites a file. Stdout carries counts only.
 *
 *   ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL=<standby url> \
 *     vp exec tsx packages/backend/src/scripts/account-email-evidence.ts \
 *     --out ~/Private/boardsesh-ba02/evidence-$(date +%F).json
 *
 * The URL never comes from DATABASE_URL or a command argument.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { explicitReadOnlyConnectionOptions, type ExplicitConnectionProfile } from '../auth/email-audit/connection';
import {
  ACCOUNT_EMAIL_EVIDENCE_FORMAT_VERSION,
  ACCOUNT_EMAIL_EVIDENCE_LIMITS,
  AccountEmailEvidenceError,
  buildAccountEmailEvidence,
  type AccountEmailEvidenceErrorCode,
  type EvidenceWorksheet,
} from '../auth/email-audit/evidence';
import { collectAccountEmailEvidence } from '../auth/email-audit/evidence-snapshot';
import { PrivateFileError, writePrivateFileExclusively } from '../auth/email-audit/private-file';

export const ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL_VARIABLE = 'ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL';

/** Fixed text only: never the URL, the path or a database message. */
export const ACCOUNT_EMAIL_EVIDENCE_HINTS: Readonly<Record<AccountEmailEvidenceErrorCode, string>> = Object.freeze({
  CONFIGURATION: `Set ${ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL_VARIABLE}, leave DEBUG_SQL off, and pass only --out <file> and optionally --allow-primary.`,
  OUTPUT_EXISTS: 'The worksheet path already exists. Pick a new file name; nothing was overwritten.',
  OUTPUT_INSIDE_REPOSITORY:
    'The worksheet holds private data. Write it outside every git repository and worktree, in ~/Private/boardsesh-ba02.',
  OUTPUT_FOLDER_NOT_PRIVATE:
    'The worksheet folder must be yours with mode 0700. Run: mkdir -p -m 700 ~/Private/boardsesh-ba02 (or chmod 700 it).',
  OUTPUT_UNAVAILABLE: 'The worksheet could not be created. Check that the folder exists and is yours.',
  NOT_READ_ONLY: 'The session was not a REPEATABLE READ READ ONLY snapshot, so nothing was written.',
  PRIMARY_NOT_ALLOWED:
    'That URL is a primary. Use the DR standby, or pass --allow-primary to read the primary on purpose.',
  CATALOG_MISMATCH: 'The users tables or foreign keys are not the shape this report understands.',
  INPUT_LIMIT: 'A size limit was hit. No partial worksheet was written.',
  INVALID_ROW: 'A row had an unexpected shape. No partial worksheet was written.',
  COUNT_MISMATCH: 'Counts did not reconcile inside the snapshot. Rerun.',
  GROUPING_MISMATCH:
    'SQL and the JS normalizer grouped addresses differently (non-ASCII or unusual whitespace). Nothing was written; report this code.',
  TIME_LIMIT: 'A statement hit its 60 s timeout or the run hit its time limit. Rerun when the standby is quiet.',
  LOCK_TIMEOUT: 'Another session held a lock on a table for 5 s, usually a deploy or standby replay. Rerun.',
  STANDBY_CONFLICT: 'Replay on the standby cancelled the snapshot. Rerun.',
  SNAPSHOT_UNAVAILABLE: 'The database could not be read. Check the URL, network and role.',
});

export interface AccountEmailEvidenceArguments {
  readonly out: string;
  readonly allowPrimary: boolean;
}

export function parseAccountEmailEvidenceArguments(arguments_: readonly string[]): AccountEmailEvidenceArguments {
  let out: string | undefined;
  let allowPrimary = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === '--out' && out === undefined && next && !next.startsWith('-')) {
      out = next;
      index += 1;
    } else if (argument === '--allow-primary' && !allowPrimary) {
      allowPrimary = true;
    } else {
      throw new AccountEmailEvidenceError('CONFIGURATION');
    }
  }
  if (out === undefined) throw new AccountEmailEvidenceError('CONFIGURATION');
  return { out, allowPrimary };
}

const EVIDENCE_CONNECTION_PROFILE: ExplicitConnectionProfile = {
  applicationName: 'boardsesh_account_email_evidence',
  // Accepts a hot standby. The snapshot itself then decides standby versus primary.
  targetSessionAttrs: 'read-only',
  statementTimeoutMs: ACCOUNT_EMAIL_EVIDENCE_LIMITS.statementTimeoutMs,
  lockTimeoutMs: 5000,
  idleInTransactionTimeoutMs: 120000,
  maxLifetimeSeconds: 3600,
};

export function accountEmailEvidenceConnectionOptions(databaseUrl: string | undefined, debugSql?: string) {
  try {
    return explicitReadOnlyConnectionOptions(databaseUrl, debugSql, EVIDENCE_CONNECTION_PROFILE);
  } catch {
    throw new AccountEmailEvidenceError('CONFIGURATION');
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw new AccountEmailEvidenceError('OUTPUT_UNAVAILABLE');
  }
}

/**
 * Checked before connecting. Refuses a folder with `.git` (a directory or a
 * worktree's file) in itself or any parent, so `git add -A` in this checkout,
 * a sibling worktree or any other repository can never pick the worksheet up.
 * Then refuses a folder that is not yours with mode 0700, and an existing path.
 */
export function resolveWorksheetPath(out: string): string {
  const absolute = resolve(out);
  let folder: string;
  try {
    folder = realpathSync(dirname(absolute));
  } catch {
    throw new AccountEmailEvidenceError('OUTPUT_UNAVAILABLE');
  }
  for (let ancestor = folder; ; ancestor = dirname(ancestor)) {
    if (pathExists(join(ancestor, '.git'))) throw new AccountEmailEvidenceError('OUTPUT_INSIDE_REPOSITORY');
    if (dirname(ancestor) === ancestor) break;
  }
  const metadata = statSync(folder);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700)
    throw new AccountEmailEvidenceError('OUTPUT_FOLDER_NOT_PRIVATE');
  const target = join(folder, basename(absolute));
  if (pathExists(target)) throw new AccountEmailEvidenceError('OUTPUT_EXISTS');
  return target;
}

/** Writes the worksheet exclusively. Any failure removes the file this call created, so a rerun can reuse the path. */
export function writeEvidenceWorksheet(
  worksheetPath: string,
  worksheet: EvidenceWorksheet,
  maxBytes: number = ACCOUNT_EMAIL_EVIDENCE_LIMITS.maxWorksheetBytes,
) {
  try {
    return writePrivateFileExclusively(worksheetPath, [`${JSON.stringify(worksheet, null, 2)}\n`], maxBytes, {
      removeOnFailure: true,
    });
  } catch (error) {
    if (error instanceof PrivateFileError && error.code === 'EXISTS')
      throw new AccountEmailEvidenceError('OUTPUT_EXISTS');
    if (error instanceof PrivateFileError && error.code === 'LIMIT') throw new AccountEmailEvidenceError('INPUT_LIMIT');
    throw new AccountEmailEvidenceError('OUTPUT_UNAVAILABLE');
  }
}

export async function runAccountEmailEvidence(
  arguments_: AccountEmailEvidenceArguments,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: { readonly maximumMs?: number } = {},
) {
  const maximumMs = options.maximumMs ?? ACCOUNT_EMAIL_EVIDENCE_LIMITS.maximumMs;
  if (!Number.isSafeInteger(maximumMs) || maximumMs < 1 || maximumMs > ACCOUNT_EMAIL_EVIDENCE_LIMITS.maximumMs)
    throw new AccountEmailEvidenceError('CONFIGURATION');
  const connectionOptions = accountEmailEvidenceConnectionOptions(
    environment[ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL_VARIABLE],
    environment.DEBUG_SQL,
  );
  const worksheetPath = resolveWorksheetPath(arguments_.out);
  const client = postgres(connectionOptions);
  let timedOut = false;
  let interruptedClose: Promise<void> | undefined;
  let interruptedCloseFailed = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    // This CLI owns its one read-only client; ending it settles in-flight work.
    interruptedClose = client.end({ timeout: 1 }).catch(() => {
      interruptedCloseFailed = true;
    });
  }, maximumMs);
  let collected: Awaited<ReturnType<typeof collectAccountEmailEvidence>> | undefined;
  let failure: AccountEmailEvidenceError | undefined;
  try {
    collected = await collectAccountEmailEvidence(client, { allowPrimary: arguments_.allowPrimary, maximumMs });
  } catch (error) {
    failure =
      error instanceof AccountEmailEvidenceError ? error : new AccountEmailEvidenceError('SNAPSHOT_UNAVAILABLE');
  }
  clearTimeout(deadline);
  try {
    if (interruptedClose) await interruptedClose;
    else await client.end({ timeout: 5 });
  } catch {
    failure ??= new AccountEmailEvidenceError('SNAPSHOT_UNAVAILABLE');
  }
  if (timedOut) failure = new AccountEmailEvidenceError('TIME_LIMIT');
  if (interruptedCloseFailed) failure = new AccountEmailEvidenceError('SNAPSHOT_UNAVAILABLE');
  if (failure) throw failure;
  if (!collected) throw new AccountEmailEvidenceError('SNAPSHOT_UNAVAILABLE');

  // The connection is closed before any private byte is written.
  const { worksheet, summary } = buildAccountEmailEvidence(collected);
  const written = writeEvidenceWorksheet(worksheetPath, worksheet);
  return {
    formatVersion: ACCOUNT_EMAIL_EVIDENCE_FORMAT_VERSION,
    status: 'complete' as const,
    snapshot: collected.snapshot,
    ...summary,
    worksheet: written,
    connectionClosed: true,
    completedAt: new Date().toISOString(),
  };
}

/** Writes exactly one JSON document and returns the exit code. */
export async function runAccountEmailEvidenceCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  write: (text: string) => void,
): Promise<number> {
  try {
    const summary = await runAccountEmailEvidence(parseAccountEmailEvidenceArguments(arguments_), environment);
    write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code: AccountEmailEvidenceErrorCode =
      error instanceof AccountEmailEvidenceError ? error.code : 'SNAPSHOT_UNAVAILABLE';
    write(
      `${JSON.stringify({ formatVersion: ACCOUNT_EMAIL_EVIDENCE_FORMAT_VERSION, status: 'incomplete', code, hint: ACCOUNT_EMAIL_EVIDENCE_HINTS[code] }, null, 2)}\n`,
    );
    return 1;
  }
}

async function main() {
  let output = '';
  const exitCode = await runAccountEmailEvidenceCli(process.argv.slice(2), process.env, (text) => {
    output += text;
  });
  // Flush the single record, then end only this CLI.
  const outputDeadline = setTimeout(() => process.exit(exitCode), 1000);
  process.stdout.write(output, () => {
    clearTimeout(outputDeadline);
    process.exit(exitCode);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
