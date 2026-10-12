/// <reference types="node" />
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';

const adminUrl = process.env.SYNC_CUTOFF_TEST_ADMIN_DATABASE_URL;
const developerScript = new URL('./bootstrap-sync-deletions-cutoff-development.ts', import.meta.url).pathname;
const adminScript = new URL('./bootstrap-sync-deletions-cutoff.ts', import.meta.url).pathname;
const run = (script: string, environment: NodeJS.ProcessEnv, arguments_: string[] = []) =>
  execFileSync('vp', ['exec', 'tsx', script, ...arguments_], { env: environment, encoding: 'utf8', stdio: 'pipe' });

void test('development bootstrap rejects remote targets before making any connection', () => {
  assert.throws(
    () =>
      run(
        developerScript,
        {
          ...process.env,
          SYNC_CUTOFF_DEVELOPMENT_BOOTSTRAP: 'true',
          SYNC_CUTOFF_ADMIN_DATABASE_URL: 'postgres://unused:unused@example.invalid/test',
        },
        ['--apply'],
      ),
    /isolated local PostgreSQL host/,
  );
});

void test('admin plan never connects through an implicit DATABASE_URL', () => {
  assert.match(
    run(adminScript, {
      ...process.env,
      DATABASE_URL: 'postgres://unused:unused@example.invalid/test',
      SYNC_CUTOFF_ADMIN_DATABASE_URL: '',
    }),
    /Plan: install one timestamp-only helper/,
  );
});

void test(
  'isolated bootstrap installs exact privileges, replays safely, and rejects a wrong existing helper',
  {
    skip: !adminUrl,
  },
  async () => {
    const parsedUrl = new URL(adminUrl!);
    assert.ok(['localhost', '127.0.0.1', 'postgres'].includes(parsedUrl.hostname));
    const suffix = randomUUID().replaceAll('-', '');
    const databaseName = `cutoff_bootstrap_${suffix}`;
    const runtimeRole = `cutoff_runtime_${suffix}`;
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    const [ownerBefore] = await admin<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'boardsesh_sync_cutoff_owner') AS exists
  `;
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    parsedUrl.pathname = `/${databaseName}`;
    const environment = {
      ...process.env,
      SYNC_CUTOFF_DEVELOPMENT_BOOTSTRAP: 'true',
      SYNC_CUTOFF_ADMIN_DATABASE_URL: parsedUrl.toString(),
      SYNC_CUTOFF_RUNTIME_ROLE: runtimeRole,
    };
    const scratch = postgres(parsedUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      assert.match(run(developerScript, environment, ['--apply']), /Installed the cutoff helper/);
      const contractSql = readFileSync(
        new URL('./sync-deletions-cutoff-contract.sql', import.meta.url),
        'utf8',
      ).replaceAll('__SYNC_RUNTIME_ROLE__', runtimeRole);
      const [contract] = await scratch.unsafe<{ matches: boolean }[]>(contractSql);
      assert.equal(contract.matches, true);
      assert.match(run(developerScript, environment, ['--apply']), /Installed the cutoff helper/);
      await scratch.unsafe('ALTER FUNCTION public.sync_deletions_safe_cutoff(double precision) OWNER TO postgres');
      assert.throws(() => run(adminScript, environment, ['--apply']), /Existing cutoff helper has unsafe/);
    } finally {
      await scratch.end();
      await admin.unsafe(`DROP DATABASE "${databaseName}"`);
      await admin.unsafe(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      if (!ownerBefore.exists) await admin.unsafe('DROP ROLE boardsesh_sync_cutoff_owner');
      await admin.end();
    }
  },
);
