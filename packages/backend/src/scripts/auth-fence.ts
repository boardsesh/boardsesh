import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExplicitConnectionConfigurationError } from '../auth/email-audit/connection';
import {
  WEB_FENCE_LOCK_SQL,
  WEB_FENCE_LOCK_TIMEOUT,
  fencePlan,
  readFenceCatalog,
  verifyFence,
} from './auth-fence/catalog';
import { operatorClient, parseOperatorArguments } from './auth-fence/operator';

/**
 * `plan` (the default) and `verify` open a read-only transaction. Only `apply`
 * writes, and only with the `planSha256` printed by a fresh `plan`. Two hashes
 * appear and are never comparable: `planSha256` names the SQL `plan` printed;
 * `catalogSha256` (in verify/apply evidence) names the plan the catalogue would
 * produce at that moment, which no longer creates the role once it exists.
 */
export async function runAuthFence(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const options = parseOperatorArguments(arguments_, ['plan', 'apply', 'verify'], [], ['apply']);
  if (options.projectionId) throw new Error('INVALID_ARGUMENTS');
  // A plan hash only means something to apply; anywhere else it is a mistyped command.
  if (options.command !== 'apply' && options.planSha256) throw new Error('INVALID_ARGUMENTS');
  if (options.command === 'apply' && !options.planSha256) throw new Error('PLAN_SHA256_REQUIRED');
  const write = options.command === 'apply';
  const client = operatorClient(environment, options.confirmHost, write);
  try {
    return await client.begin(
      write ? 'isolation level read committed' : 'isolation level repeatable read read only',
      async (transaction) => {
        if (options.command === 'verify') return { mode: 'verify' as const, ...(await verifyFence(transaction)) };
        if (write) {
          // Bounded wait, then hold the lock every migration's web reconcile takes,
          // so no reconcile interleaves between this catalogue read and commit.
          await transaction`SELECT set_config('lock_timeout', ${WEB_FENCE_LOCK_TIMEOUT}, true)`;
          await transaction.unsafe(WEB_FENCE_LOCK_SQL);
        }
        const { sql, rollbackSql, sha256: planSha256 } = fencePlan(await readFenceCatalog(transaction));
        if (options.command === 'plan') return { mode: 'plan' as const, sql, rollbackSql, planSha256 };
        if (options.planSha256 !== planSha256) throw new Error('PLAN_CHANGED');
        await transaction.unsafe(sql);
        const evidence = await verifyFence(transaction);
        return { mode: 'applied' as const, planSha256, evidence };
      },
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * The one thing a refusal may print. Fixed upper-case codes come from this tool
 * and the fence verifier; a SQLSTATE names a database condition without its
 * message. Driver messages can carry SQL, parameters or connection details, so
 * anything else collapses to one fixed word.
 */
export function authFenceRefusalCode(error: unknown): string {
  if (error instanceof ExplicitConnectionConfigurationError) return 'CONNECTION_CONFIGURATION_REJECTED';
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)) return error.message;
  const sqlState = (error as { code?: unknown } | null)?.code;
  if (typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState)) return `SQLSTATE_${sqlState}`;
  return 'UNEXPECTED_ERROR';
}

async function main() {
  try {
    const result = await runAuthFence(process.argv.slice(2));
    if (result.mode === 'plan') {
      process.stdout.write(
        `-- planSha256: ${result.planSha256}\n${result.sql}\n${result.rollbackSql
          .split('\n')
          .map((line) => `-- ROLLBACK: ${line}`)
          .join('\n')}\n`,
      );
    } else process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `Auth fence refused (${authFenceRefusalCode(error)}); inspect configuration and live catalog using plan.\n`,
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
