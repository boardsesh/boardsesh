import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { assertAuthorityActivationGates } from './auth-authority';
import { assertIdentityMirrorActivationConfiguration } from '../auth/authority/mirror-configuration';
import { operatorClient, operatorConnectionOptions, parseOperatorArguments } from './auth-fence/operator';
import { checkpoints, digestKey, keyedDigest } from './auth-identities/private-state';
import { importIdentityBatch } from './auth-identities/operations';

export function identityArguments(arguments_: readonly string[], importing: boolean) {
  const parsed = parseOperatorArguments(
    arguments_,
    [importing ? 'import' : 'reconcile'],
    importing ? ['--batch', '--pause-ms', '--checkpoint', '--key-file'] : ['--key-file'],
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
  return { confirmHost: parsed.confirmHost, batch, pauseMs, keyFile, checkpoint };
}

export async function runImportIdentities(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const options = identityArguments(arguments_, true);
  const connection = operatorConnectionOptions(environment, options.confirmHost, true);
  const key = digestKey(options.keyFile);
  const checkpoint = checkpoints(
    options.checkpoint!,
    keyedDigest(key, [connection.host, connection.port, connection.database]),
  );
  // Backfill cannot be safe while legacy writers can change rows behind its cursor.
  // These are code gates, not operator overrides or evidence of mirror coverage.
  assertAuthorityActivationGates();
  if (environment.AUTH_IDENTITY_MIRROR !== 'on') throw new Error('IDENTITY_MIRROR_REQUIRED');
  assertIdentityMirrorActivationConfiguration(environment);
  const client = operatorClient(environment, options.confirmHost, true);
  let imported = 0;
  try {
    let lastUserId = checkpoint.lastUserId;
    for (;;) {
      const batch = await importIdentityBatch(client, lastUserId, options.batch);
      if (!batch.lastUserId) break;
      checkpoint.save(batch.lastUserId);
      lastUserId = batch.lastUserId;
      imported += batch.count;
      if (batch.count < options.batch) break;
      await pause(options.pauseMs);
    }
    return { status: 'import-pass-complete-reconcile-required', processed: imported };
  } finally {
    await client.end({ timeout: 5 });
  }
}
async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await runImportIdentities(process.argv.slice(2)))}\n`);
  } catch {
    process.stderr.write('Identity import refused; configuration, private state, and activation gates must pass.\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
