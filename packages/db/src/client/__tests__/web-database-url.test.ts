import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Its own file on purpose: marking the web process is process-wide, and
// node:test runs each file in a separate process. The cases below run in order:
// everything before "once applied" runs on an unmarked process.
const contentUrl = 'postgres://boardsesh_runtime:runtime-secret@localhost:5432/main';
const webUrl = 'postgres://boardsesh_web:web-secret@db.example.com:5432/main';
const NO_BLOCKERS: readonly string[] = [];

async function withVariables(variables: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(variables)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const { closePool } = await import('../postgres');
  await closePool();
  try {
    await run();
  } finally {
    await closePool();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

void describe('applyWebDatabaseUrl', () => {
  void it('leaves a process that never called it on DATABASE_URL, even with WEB_DATABASE_URL set', async () => {
    await withVariables({ DATABASE_URL: contentUrl, WEB_DATABASE_URL: webUrl }, async () => {
      const { getConnectionConfig, isPrivateDatabaseTarget } = await import('../config');
      const { createPool } = await import('../postgres');
      assert.equal(getConnectionConfig().connectionString, contentUrl);
      assert.equal(createPool().options.user, 'boardsesh_runtime');
      assert.equal(isPrivateDatabaseTarget(), true, 'hostname still comes from DATABASE_URL');
    });
  });

  void it('refuses a set WEB_DATABASE_URL while the web still writes identity tables', async () => {
    await withVariables({ DATABASE_URL: contentUrl, WEB_DATABASE_URL: webUrl }, async () => {
      const { applyWebDatabaseUrl } = await import('../postgres');
      const { getConnectionConfig, markWebDatabaseUrlProcess, WEB_DATABASE_LOGIN_BLOCKERS } = await import('../config');
      assert.deepEqual(WEB_DATABASE_LOGIN_BLOCKERS, ['LEGACY_WEB_IDENTITY_WRITERS']);
      assert.throws(() => applyWebDatabaseUrl(), { message: 'WEB_DATABASE_LOGIN_BLOCKED' });
      // The instrumentation boot path refuses the same way.
      assert.throws(() => markWebDatabaseUrlProcess(), { message: 'WEB_DATABASE_LOGIN_BLOCKED' });
      assert.equal(getConnectionConfig().connectionString, contentUrl);
    });
  });

  void it('refuses to switch logins under a pool that already exists', async () => {
    await withVariables({ DATABASE_URL: contentUrl, WEB_DATABASE_URL: webUrl }, async () => {
      const { applyWebDatabaseUrl, createPool } = await import('../postgres');
      const { getConnectionConfig } = await import('../config');
      createPool();
      assert.throws(() => applyWebDatabaseUrl(NO_BLOCKERS), /before anything that calls createDb/);
      assert.equal(getConnectionConfig().connectionString, contentUrl);
    });
  });

  void it('once applied with no blockers, builds the pool and reads the hostname from WEB_DATABASE_URL', async () => {
    await withVariables({ DATABASE_URL: contentUrl, WEB_DATABASE_URL: webUrl }, async () => {
      const { applyWebDatabaseUrl, createPool } = await import('../postgres');
      const { getConnectionConfig, isPrivateDatabaseTarget } = await import('../config');
      applyWebDatabaseUrl(NO_BLOCKERS);
      assert.equal(getConnectionConfig().connectionString, webUrl);
      assert.equal(createPool().options.user, 'boardsesh_web');
      assert.equal(isPrivateDatabaseTarget(), false, 'Sentry follows the same resolution as the pool');
      // Next.js re-evaluates db.ts in development; the pool already matches.
      assert.doesNotThrow(() => applyWebDatabaseUrl(NO_BLOCKERS));
      // A blocker still refuses on every call, even after the process is marked.
      assert.throws(() => applyWebDatabaseUrl(), { message: 'WEB_DATABASE_LOGIN_BLOCKED' });
    });
  });

  void it('keeps working with DATABASE_URL removed from the web service', async () => {
    await withVariables({ DATABASE_URL: undefined, WEB_DATABASE_URL: webUrl }, async () => {
      const { createPool } = await import('../postgres');
      const { getConnectionConfig } = await import('../config');
      assert.equal(getConnectionConfig().connectionString, webUrl);
      assert.equal(createPool().options.user, 'boardsesh_web');
    });
  });

  void it('falls back to DATABASE_URL when WEB_DATABASE_URL is unset or blank, with blockers in place', async () => {
    for (const unsetValue of [undefined, '', '   ']) {
      await withVariables({ DATABASE_URL: contentUrl, WEB_DATABASE_URL: unsetValue }, async () => {
        const { applyWebDatabaseUrl, createPool } = await import('../postgres');
        const { getConnectionConfig } = await import('../config');
        // Production today: blockers present, variable unset, nothing refused.
        assert.doesNotThrow(() => applyWebDatabaseUrl());
        assert.equal(getConnectionConfig().connectionString, contentUrl);
        assert.equal(createPool().options.user, 'boardsesh_runtime');
      });
    }
  });

  void it('keeps the read replica on READ_REPLICA_URL', async () => {
    const replicaUrl = 'postgres://boardsesh_reader:reader-secret@localhost:5432/main';
    await withVariables(
      { DATABASE_URL: contentUrl, WEB_DATABASE_URL: webUrl, READ_REPLICA_URL: replicaUrl },
      async () => {
        const { createReadPool, closeReadPool } = await import('../postgres');
        try {
          assert.equal(createReadPool().options.user, 'boardsesh_reader');
        } finally {
          await closeReadPool();
        }
      },
    );
  });
});
