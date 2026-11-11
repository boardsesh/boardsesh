import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identityArguments } from './auth-import-identities';
import { operatorClient, operatorConnectionOptions } from './auth-fence/operator';
import { digestKey } from './auth-identities/private-state';
import { reconcileIdentities } from './auth-identities/operations';
import { AUTHORITY_ACTIVATION_BLOCKERS } from './auth-authority';

export async function runReconcileIdentities(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const options = identityArguments(arguments_, false);
  operatorConnectionOptions(environment, options.confirmHost, false);
  const key = digestKey(options.keyFile);
  const client = operatorClient(environment, options.confirmHost, false);
  try {
    return {
      status: 'not-ready-activation-and-mirror-proof-required',
      activationBlockers: AUTHORITY_ACTIVATION_BLOCKERS,
      ...(await reconcileIdentities(client, key)),
    };
  } finally {
    await client.end({ timeout: 5 });
  }
}
async function main() {
  try {
    const result = await runReconcileIdentities(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.missing || result.different || result.unexpected) process.exitCode = 2;
  } catch {
    process.stderr.write('Identity reconciliation refused; check explicit connection and private key configuration.\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
