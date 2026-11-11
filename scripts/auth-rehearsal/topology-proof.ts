import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { buildRuntimeImage } from './runtime-image';
import { createIsolatedTarget, requireCreatedIsolatedTarget } from './isolated-target';
import { requireNamespaceReceipt } from './namespace-guard';
import { RehearsalSafetyError } from './target-guard';

/** Explicit pre-SQL developer proof, no target/image/URL inputs or activation override. */
async function main() {
  if (process.argv.length !== 2) throw new RehearsalSafetyError('TOPOLOGY_PROOF_ARGUMENTS_REFUSED');
  const image = await buildRuntimeImage();
  const target = await createIsolatedTarget(image);
  let failure: unknown;
  try {
    requireCreatedIsolatedTarget(target);
    const receipt = await target.attest();
    requireNamespaceReceipt(receipt);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'docker',
        [
          '--host',
          image.identity.endpoint,
          'exec',
          '--interactive',
          '--workdir',
          '/app/packages/backend',
          target.expected.runtime.id,
          'node',
          '--import',
          'tsx',
          '/app/scripts/auth-rehearsal/topology-entry.ts',
        ],
        {
          env: { PATH: process.env.PATH, HOME: homedir() },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new RehearsalSafetyError('TOPOLOGY_PROBE_TIMEOUT'));
      }, 15000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < 1024) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 1024) stderr += chunk.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timeout);
        reject(new RehearsalSafetyError('TOPOLOGY_PROBE_FAILED'));
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 && stdout.trim() === 'ISOLATED_TOPOLOGY_PROBE_PASS') resolve();
        else
          reject(
            new RehearsalSafetyError(/^[A-Z_]{1,100}$/.test(stderr.trim()) ? stderr.trim() : 'TOPOLOGY_PROBE_FAILED'),
          );
      });
      child.stdin.end(
        JSON.stringify({
          ...receipt,
          postgresPassword: target.secrets.postgresPassword,
          redisPassword: target.secrets.redisPassword,
        }),
      );
    });
  } catch (error) {
    failure = error;
  }
  await target.dispose();
  if (failure) throw failure;
  console.log('ISOLATED_TOPOLOGY_PROBE_PASS');
}
void main().catch((error: unknown) => {
  console.error(error instanceof RehearsalSafetyError ? error.code : 'TOPOLOGY_PROBE_FAILED');
  process.exitCode = 1;
});
