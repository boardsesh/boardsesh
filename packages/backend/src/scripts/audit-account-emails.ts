/** Point-in-time observation only. There is deliberately no apply mode. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { auditAccountEmailSnapshot } from '../auth/email-audit/snapshot';
import { EmailAuditError, EMAIL_AUDIT_LIMITS, type EmailAuditGroup } from '../auth/email-audit/report';

export function parseEmailAuditArguments(arguments_: readonly string[]) {
  if (arguments_.length === 0) return {};
  if (arguments_.length === 2 && arguments_[0] === '--details-file' && arguments_[1] && !arguments_[1].startsWith('-'))
    return { detailsFile: arguments_[1] };
  throw new EmailAuditError('CONFIGURATION');
}

/** Explicit fields avoid postgres.js URI/startup and ambient PG* precedence. */
export function emailAuditConnectionOptions(databaseUrl: string | undefined, debugSql?: string) {
  try {
    if (!databaseUrl || debugSql === 'true' || databaseUrl !== databaseUrl.trim() || /\p{Cc}/u.test(databaseUrl))
      throw new EmailAuditError('CONFIGURATION');
    const address = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(address.protocol) ||
      address.hash ||
      !/^[a-zA-Z0-9.-]+$/.test(address.hostname) ||
      !address.username ||
      !address.pathname.startsWith('/') ||
      address.pathname.length < 2
    )
      throw new EmailAuditError('CONFIGURATION');
    const entries = [...address.searchParams.entries()];
    const isLoopback = address.hostname === 'localhost' || address.hostname === '127.0.0.1';
    if (
      entries.length > 1 ||
      entries.some(
        ([key, mode]) => key !== 'sslmode' || (mode !== 'verify-full' && !(isLoopback && mode === 'disable')),
      )
    )
      throw new EmailAuditError('CONFIGURATION');
    const username = decodeURIComponent(address.username);
    const password = decodeURIComponent(address.password);
    const database = decodeURIComponent(address.pathname.slice(1));
    const port = address.port ? Number(address.port) : 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EmailAuditError('CONFIGURATION');
    if ([username, database].some((part) => !part || /\p{Cc}/u.test(part)) || password.includes('\0'))
      throw new EmailAuditError('CONFIGURATION');
    return {
      host: address.hostname,
      port,
      database,
      username,
      // An empty string would fall through to PGPASSWORD in postgres.js 3.4.9.
      password: () => password,
      ssl: isLoopback && entries[0]?.[1] !== 'verify-full' ? (false as const) : { rejectUnauthorized: true },
      sslnegotiation: null,
      max: 1,
      max_pipeline: 1,
      prepare: false,
      debug: false,
      fetch_types: false,
      target_session_attrs: 'primary',
      connect_timeout: 10,
      idle_timeout: 5,
      max_lifetime: 130,
      keep_alive: 30,
      backoff: () => 0.1,
      publications: 'alltables',
      onnotice: () => {},
      connection: {
        application_name: 'boardsesh_account_email_audit',
        default_transaction_read_only: true,
        statement_timeout: 5000,
        lock_timeout: 1000,
        idle_in_transaction_session_timeout: 10000,
      },
      // postgres.js 3.4.9 implements this default but omits its type declaration.
    } satisfies postgres.Options<{}> & { readonly sslnegotiation: null; readonly max_pipeline: 1 };
  } catch {
    throw new EmailAuditError('CONFIGURATION');
  }
}

export function writeEmailAuditDetails(filename: string, auditId: string, groups: readonly EmailAuditGroup[]) {
  let descriptor: number | undefined;
  try {
    // This artifact alone does not assert completion. Only the final summary,
    // emitted after actual file/client closure, binds its completed bytes.
    const ownedDescriptor = openSync(filename, 'wx', 0o600);
    descriptor = ownedDescriptor;
    fchmodSync(ownedDescriptor, 0o600);
    const metadata = fstatSync(ownedDescriptor);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600)
      throw new EmailAuditError('OUTPUT_UNAVAILABLE');
    const hash = createHash('sha256');
    let totalBytes = 0;
    const writeChunk = (chunk: string) => {
      const bytes = Buffer.from(chunk);
      if (totalBytes + bytes.length > EMAIL_AUDIT_LIMITS.maxDetailBytes) throw new EmailAuditError('INPUT_LIMIT');
      writeFileSync(ownedDescriptor, bytes);
      hash.update(bytes);
      totalBytes += bytes.length;
    };
    // Serialize one bounded member at a time; even a single huge collision
    // group cannot allocate an unbounded JSON string before the output cap.
    writeChunk(`{"formatVersion":1,"status":"detail-only","auditId":${JSON.stringify(auditId)},"groups":[`);
    groups.forEach((group, groupIndex) => {
      writeChunk(`${groupIndex ? ',' : ''}{"normalizedEmail":${JSON.stringify(group.normalizedEmail)},"members":[`);
      group.members.forEach((member, memberIndex) => writeChunk(`${memberIndex ? ',' : ''}${JSON.stringify(member)}`));
      writeChunk(']}');
    });
    writeChunk(']}\n');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return { sha256: hash.digest('hex'), bytes: totalBytes };
  } catch (error) {
    if (error instanceof EmailAuditError) throw error;
    throw new EmailAuditError('OUTPUT_UNAVAILABLE');
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* Completion is already rejected. */
      }
    }
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
  let observedCloses = 0;
  const client = postgres({
    ...connectionOptions,
    onclose: () => {
      observedCloses += 1;
    },
  });
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
  const closesBeforeCleanup = observedCloses;
  const cleanupExpiresAt = performance.now() + 5000;
  try {
    if (interruptedClose) await interruptedClose;
    else await client.end({ timeout: 5 });
  } catch {
    failure ??= new EmailAuditError('SNAPSHOT_UNAVAILABLE');
  }
  if (timedOut) failure = new EmailAuditError('TIME_LIMIT');
  if (interruptedCloseFailed) failure = new EmailAuditError('SNAPSHOT_UNAVAILABLE');
  while (!failure && observedCloses === closesBeforeCleanup && performance.now() < cleanupExpiresAt)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  // end({timeout}) can resolve its force-close branch before a socket closes.
  // Only a new public onclose event during this successful operation's cleanup
  // permits positive completion; an earlier reconnect cannot supply this proof.
  if (!failure && observedCloses === closesBeforeCleanup) failure = new EmailAuditError('SNAPSHOT_UNAVAILABLE');
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
