import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import postgres from 'postgres';
import { ExplicitConnectionConfigurationError } from '../auth/email-audit/connection';
import { CurrentStoreFoundationError } from '../auth/current-store/foundation-context';
import { qualifyIdentityImport } from '../auth/authority/identity-copy-preconditions';
import { assertAuthorityActivationGates } from '../auth/authority/activation-gates';
import { operatorConnectionOptions, parseOperatorArguments } from './auth-fence/operator';
import { checkpoints, digestKey, keyedDigest } from './auth-identities/private-state';
import { countUsersAfter, importIdentityBatch } from './auth-identities/operations';

/**
 * `plan` (the default) is read-only: it checks every precondition and counts the
 * users the next pass would visit. Only the named `import` verb writes; the
 * shared parser never defaults a write mode.
 */
export function identityArguments(arguments_: readonly string[], importing: boolean) {
  const parsed = parseOperatorArguments(
    arguments_,
    importing ? ['plan', 'import'] : ['reconcile'],
    importing ? ['--batch', '--pause-ms', '--checkpoint', '--key-file'] : ['--key-file'],
    // `vp run auth:import-identities -- import …` writes; reconcile is read-only.
    importing ? ['import'] : [],
  );
  if (parsed.projectionId || parsed.planSha256) throw new Error('INVALID_ARGUMENTS');
  const batch = Number(parsed.options.get('--batch') ?? '200');
  const pauseMs = Number(parsed.options.get('--pause-ms') ?? '100');
  const keyFile = parsed.options.get('--key-file');
  const checkpoint = parsed.options.get('--checkpoint');
  if (
    !keyFile ||
    (importing && !checkpoint) ||
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 200 ||
    !Number.isInteger(pauseMs) ||
    pauseMs < 0 ||
    pauseMs > 60000
  )
    throw new Error('INVALID_ARGUMENTS');
  return { command: parsed.command, confirmHost: parsed.confirmHost, batch, pauseMs, keyFile, checkpoint };
}

export async function runImportIdentities(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const options = identityArguments(arguments_, true);
  const writing = options.command === 'import';
  // The only connection is the dedicated credential LOGIN, read-only for plan.
  const connection = operatorConnectionOptions(environment, options.confirmHost, writing, 'identity-writer');
  const key = digestKey(options.keyFile);
  const checkpoint = checkpoints(
    options.checkpoint!,
    keyedDigest(key, [connection.host, connection.port, connection.database]),
  );
  // The operator states every backend runs the live mirror. The database checks
  // below prove what a catalog can; this one only the deployment can.
  if (environment.AUTH_IDENTITY_MIRROR !== 'on') throw new Error('IDENTITY_MIRROR_REQUIRED');
  const client = postgres(connection);
  try {
    // Read-only checks first, so `plan` names the first database precondition that fails.
    const authority = await qualifyIdentityImport(client, connection.database, environment);
    // `enforced` is database state anyone with the admin login could set by hand; the
    // code gates `activate` refuses on are checked again here, never by flag or variable.
    assertAuthorityActivationGates();
    if (!writing)
      return {
        mode: 'plan',
        status: 'ready',
        writerEpoch: authority.epoch,
        remainingUsers: await countUsersAfter(client, checkpoint.lastUserId),
        batch: options.batch,
      };
    let imported = 0;
    let lastUserId = checkpoint.lastUserId;
    for (;;) {
      const batch = await importIdentityBatch(client, lastUserId, options.batch, authority);
      if (!batch.lastUserId) break;
      checkpoint.save(batch.lastUserId);
      lastUserId = batch.lastUserId;
      imported += batch.count;
      if (batch.count < options.batch) break;
      await pause(options.pauseMs);
    }
    return {
      mode: 'import',
      status: 'import-pass-complete-reconcile-required',
      writerEpoch: authority.epoch,
      processed: imported,
    };
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * The one thing a refusal prints. Fixed upper-case codes come from this tool,
 * its preconditions and the copy primitive; a SQLSTATE names a database
 * condition without its message. Driver text can carry SQL, parameters or
 * connection details, so anything else collapses to one word.
 */
export function identityRefusalCode(error: unknown): string {
  if (error instanceof ExplicitConnectionConfigurationError) return 'CONNECTION_CONFIGURATION_REJECTED';
  if (error instanceof CurrentStoreFoundationError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)) return error.message;
  const sqlState = (error as { code?: unknown } | null)?.code;
  if (typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState)) return `SQLSTATE_${sqlState}`;
  return 'UNEXPECTED_ERROR';
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await runImportIdentities(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`Identity import refused (${identityRefusalCode(error)}).\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
