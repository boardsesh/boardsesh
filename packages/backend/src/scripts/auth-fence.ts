import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fencePlan, readFenceCatalog, verifyFence } from './auth-fence/catalog';
import { operatorClient, parseOperatorArguments } from './auth-fence/operator';

export async function runAuthFence(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const options = parseOperatorArguments(arguments_, ['plan', 'apply']);
  if (options.projectionId) throw new Error('INVALID_ARGUMENTS');
  const client = operatorClient(environment, options.confirmHost, options.command === 'apply');
  try {
    return await client.begin(
      options.command === 'plan' ? 'isolation level repeatable read read only' : 'isolation level read committed',
      async (transaction) => {
        const plan = fencePlan(await readFenceCatalog(transaction));
        if (options.command === 'plan') return { mode: 'plan', ...plan };
        if (!options.planSha256 || options.planSha256 !== plan.sha256) throw new Error('PLAN_CHANGED');
        await transaction.unsafe("SET LOCAL lock_timeout = '2000ms'");
        await transaction.unsafe(plan.sql);
        const evidence = await verifyFence(transaction);
        return { mode: 'applied', sha256: plan.sha256, evidence };
      },
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main() {
  try {
    const result = await runAuthFence(process.argv.slice(2));
    if ('sql' in result) {
      process.stdout.write(
        `-- SHA-256: ${result.sha256}\n${result.sql}\n${result.rollbackSql
          .split('\n')
          .map((line) => `-- ROLLBACK: ${line}`)
          .join('\n')}\n`,
      );
    } else process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Auth fence refused; inspect configuration and live catalog using plan.\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
