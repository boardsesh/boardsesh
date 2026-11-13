import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeImage } from './runtime-image';
import { createIsolatedTarget, requireCreatedIsolatedTarget } from './isolated-target';
import { requireNamespaceReceipt } from './namespace-guard';
import { rehearsalArguments, RehearsalSafetyError } from './target-guard';

/** Host process does ownership inspection/build only; all SQL and auth processes run inside the namespace. */
export async function runSyntheticRehearsal(): Promise<unknown> {
  const image = await buildRuntimeImage();
  const target = await createIsolatedTarget(image);
  let report: unknown;
  let failure: unknown;
  try {
    requireCreatedIsolatedTarget(target);
    const receipt = await target.attest();
    requireNamespaceReceipt(receipt);
    report = await new Promise<unknown>((resolveReport, reject) => {
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
          '/app/scripts/auth-rehearsal/isolated-entry.ts',
        ],
        {
          env: { PATH: process.env.PATH, HOME: homedir() },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new RehearsalSafetyError('ISOLATED_EXECUTION_TIMEOUT'));
      }, 180000);
      child.on('error', () => {
        clearTimeout(timer);
        reject(new RehearsalSafetyError('ISOLATED_EXECUTION_FAILED'));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 1024 * 1024) child.kill();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 1024) stderr += chunk.toString('utf8');
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const fixedCode = stderr.trim();
          reject(new RehearsalSafetyError(/^[A-Z_]{1,100}$/.test(fixedCode) ? fixedCode : 'ISOLATED_EXECUTION_FAILED'));
          return;
        }
        try {
          resolveReport(JSON.parse(stdout));
        } catch {
          reject(new RehearsalSafetyError('ISOLATED_REPORT_REFUSED'));
        }
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
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const { command } = rehearsalArguments(process.argv.slice(2));
    if (command === 'help') {
      console.log('Usage: vp exec tsx scripts/auth-rehearsal/index.ts [full|synthetic|help]');
      console.log(
        'Default/full refuses: full rehearsal is not ready. Explicit synthetic runs a bounded partial proof.',
      );
      return;
    }
    if (command === 'full') {
      console.log(
        JSON.stringify({
          ready: false,
          qualification: 'not-ready',
          missing: [
            'restored-copy',
            'switch-stop-rollback',
            'cross-tab-order',
            'host-controller-egress',
            'test-watch-queue-key-qa',
          ],
        }),
      );
      throw new RehearsalSafetyError('FULL_AUTH_REHEARSAL_NOT_READY');
    }
    console.log(JSON.stringify(await runSyntheticRehearsal()));
  })().catch((error: unknown) => {
    console.error(error instanceof RehearsalSafetyError ? error.code : 'OWNED_REHEARSAL_FAILED');
    process.exitCode = 1;
  });
}
