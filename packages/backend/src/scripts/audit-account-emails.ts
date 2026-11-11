/** Point-in-time observation only. There is deliberately no apply mode. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { auditAccountEmailSnapshot } from '../auth/email-audit/snapshot';
import { explicitReadOnlyConnectionOptions, type ExplicitConnectionProfile } from '../auth/email-audit/connection';
import { PrivateFileError, writePrivateFileExclusively } from '../auth/email-audit/private-file';
import { EmailAuditError, EMAIL_AUDIT_LIMITS, type EmailAuditGroup } from '../auth/email-audit/report';

export function parseEmailAuditArguments(arguments_: readonly string[]) {
  if (arguments_.length === 0) return {};
  if (arguments_.length === 2 && arguments_[0] === '--details-file' && arguments_[1] && !arguments_[1].startsWith('-'))
    return { detailsFile: arguments_[1] };
  throw new EmailAuditError('CONFIGURATION');
}

const EMAIL_AUDIT_CONNECTION_PROFILE: ExplicitConnectionProfile = {
  applicationName: 'boardsesh_account_email_audit',
  targetSessionAttrs: 'primary',
  statementTimeoutMs: 5000,
  lockTimeoutMs: 1000,
  idleInTransactionTimeoutMs: 10000,
  maxLifetimeSeconds: 40,
};

/** Explicit fields avoid postgres.js URI/startup and ambient PG* precedence. */
export function emailAuditConnectionOptions(databaseUrl: string | undefined, debugSql?: string) {
  try {
    return explicitReadOnlyConnectionOptions(databaseUrl, debugSql, EMAIL_AUDIT_CONNECTION_PROFILE);
  } catch {
    throw new EmailAuditError('CONFIGURATION');
  }
}

function* emailAuditDetailChunks(auditId: string, groups: readonly EmailAuditGroup[]) {
  // Serialize one bounded member at a time; even a single huge collision
  // group cannot allocate an unbounded JSON string before the output cap.
  yield `{"formatVersion":1,"status":"detail-only","auditId":${JSON.stringify(auditId)},"groups":[`;
  for (const [groupIndex, group] of groups.entries()) {
    yield `${groupIndex ? ',' : ''}{"normalizedEmail":${JSON.stringify(group.normalizedEmail)},"members":[`;
    for (const [memberIndex, member] of group.members.entries())
      yield `${memberIndex ? ',' : ''}${JSON.stringify(member)}`;
    yield ']}';
  }
  yield ']}\n';
}

export function writeEmailAuditDetails(filename: string, auditId: string, groups: readonly EmailAuditGroup[]) {
  try {
    // This artifact alone does not assert completion. Only the final summary,
    // emitted after actual file/client closure, binds its completed bytes.
    return writePrivateFileExclusively(
      filename,
      emailAuditDetailChunks(auditId, groups),
      EMAIL_AUDIT_LIMITS.maxDetailBytes,
    );
  } catch (error) {
    if (error instanceof PrivateFileError && error.code === 'LIMIT') throw new EmailAuditError('INPUT_LIMIT');
    throw new EmailAuditError('OUTPUT_UNAVAILABLE');
  }
}

export async function runEmailAudit(
  options: { readonly detailsFile?: string; readonly maximumMs?: number },
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const maximumMs = options.maximumMs ?? EMAIL_AUDIT_LIMITS.maximumMs;
  if (!Number.isSafeInteger(maximumMs) || maximumMs < 1 || maximumMs > EMAIL_AUDIT_LIMITS.maximumMs)
    throw new EmailAuditError('CONFIGURATION');
  const connectionOptions = emailAuditConnectionOptions(
    environment.ACCOUNT_EMAIL_AUDIT_DATABASE_URL,
    environment.DEBUG_SQL,
  );
  const client = postgres(connectionOptions);
  let timedOut = false;
  let interruptedClose: Promise<void> | undefined;
  let interruptedCloseFailed = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    // This CLI owns this one client. Read-only query/COMMIT uncertainty cannot
    // leave a credential mutation behind; end's hard bound settles the actual
    // driver work instead of merely racing and abandoning a pending promise.
    interruptedClose = client.end({ timeout: 1 }).catch(() => {
      interruptedCloseFailed = true;
    });
  }, maximumMs);
  let report: Awaited<ReturnType<typeof auditAccountEmailSnapshot>> | undefined;
  let failure: EmailAuditError | undefined;
  try {
    report = await auditAccountEmailSnapshot(client, { maximumMs });
  } catch (error) {
    failure = error instanceof EmailAuditError ? error : new EmailAuditError('SNAPSHOT_UNAVAILABLE');
  }
  clearTimeout(deadline);
  try {
    if (interruptedClose) await interruptedClose;
    else await client.end({ timeout: 5 });
  } catch {
    failure ??= new EmailAuditError('SNAPSHOT_UNAVAILABLE');
  }
  if (timedOut) failure = new EmailAuditError('TIME_LIMIT');
  if (interruptedCloseFailed) failure = new EmailAuditError('SNAPSHOT_UNAVAILABLE');
  if (failure) throw failure;
  if (!report) throw new EmailAuditError('SNAPSHOT_UNAVAILABLE');
  const auditId = randomUUID();
  const detail = options.detailsFile ? writeEmailAuditDetails(options.detailsFile, auditId, report.groups) : undefined;
  return {
    formatVersion: 1,
    status: 'complete',
    auditId,
    normalizerVersion: report.normalizerVersion,
    snapshot: report.snapshot,
    counts: report.counts,
    completedAt: new Date().toISOString(),
    limits: EMAIL_AUDIT_LIMITS,
    connectionClosed: true,
    ...(detail ? { detail } : {}),
  };
}

async function main() {
  try {
    const summary = await runEmailAudit(parseEmailAuditArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const code = error instanceof EmailAuditError ? error.code : 'SNAPSHOT_UNAVAILABLE';
    // A failed standalone read-only audit must not wait indefinitely on a
    // half-closed driver socket or blocked stdout. Flush the fixed failure
    // record, then end only this CLI. The imported service never exits callers.
    const outputDeadline = setTimeout(() => process.exit(1), 1000);
    process.stdout.write(`${JSON.stringify({ formatVersion: 1, status: 'incomplete', code })}\n`, () => {
      clearTimeout(outputDeadline);
      process.exit(1);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
