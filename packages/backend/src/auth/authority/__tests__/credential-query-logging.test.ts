import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vite-plus/test';

const executeFile = promisify(execFile);
const syntheticParameter = 'owned-synthetic-private-query-parameter';
const clientSource = new URL('../../../../../db/src/client/postgres.ts', import.meta.url).href;
const drizzleSource = new URL('../../../../../db/package.json', import.meta.url).href;

async function queryInFreshProcess(privateLogger: boolean) {
  const target = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
    target.pathname !== '/postgres' ||
    target.search
  )
    throw new Error('Query logging proof requires its owned localhost fixture');
  return executeFile(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
      import { createRequire } from 'node:module';
      import { createDedicatedPoolFromUrl, createDbOnPool } from ${JSON.stringify(clientSource)};
      const { sql } = createRequire(${JSON.stringify(drizzleSource)})('drizzle-orm');
      const pool = createDedicatedPoolFromUrl(process.env.OWNED_QUERY_LOGGING_DATABASE_URL, 1, { connect_timeout: 2 });
      try {
        const database = createDbOnPool(pool, ${privateLogger ? '{ logger: false }' : '{}'});
        await database.execute(sql\`SELECT \${${JSON.stringify(syntheticParameter)}}::text AS probe\`);
        process.stdout.write('OWNED_QUERY_COMPLETED');
      } finally { await pool.end({ timeout: 3 }); }
    `,
    ],
    {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        DEBUG_SQL: 'true',
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
        OWNED_QUERY_LOGGING_DATABASE_URL: target.href,
      },
    },
  );
}

describe('credential statement privacy with process-wide SQL diagnostics enabled', () => {
  it('suppresses real query text and parameters on the explicitly private handle', async () => {
    const { stdout, stderr } = await queryInFreshProcess(true);
    expect(stdout).toBe('OWNED_QUERY_COMPLETED');
    expect(stderr).not.toContain(syntheticParameter);
  });

  it('keeps the existing shared logger enabled as the positive control', async () => {
    const { stdout } = await queryInFreshProcess(false);
    expect(stdout).toContain('[SQL ');
    expect(stdout).toContain(syntheticParameter);
    expect(stdout).toContain('OWNED_QUERY_COMPLETED');
  });
});
