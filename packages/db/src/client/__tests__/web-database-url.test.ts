import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Its own file on purpose: applyWebDatabaseUrl() marks the whole process, and
// node:test runs each file in a separate process. The cases below run in order.
const contentUrl = 'postgres://boardsesh_runtime:runtime-secret@localhost:5432/main';
const webUrl = 'postgres://boardsesh_web:web-secret@localhost:5432/main';

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
      const { getConnectionConfig } = await import('../config');
      const { createPool } = await import('../postgres');
      assert.equal(getConnectionConfig().connectionString, contentUrl);
      assert.equal(createPool().options.user, 'boardsesh_runtime');
    });
  });

  void it('refuses to switch logins under a pool that already exists', async () => {
    await withVariables({ DATABASE_URL: contentUrl, WEB_DATABASE_URL: webUrl }, async () => {
      const { applyWebDatabaseUrl, createPool } = await import('../postgres');
      const { getConnectionConfig } = await import('../config');
      createPool();
      assert.throws(() => applyWebDatabaseUrl(), /before anything that calls createDb/);
      assert.equal(getConnectionConfig().connectionString, contentUrl);
    });
  });

  void it('builds the shared pool on WEB_DATABASE_URL once applied, and tolerates a re-evaluation', async () => {
    await withVariables({ DATABASE_URL: contentUrl, WEB_DATABASE_URL: webUrl }, async () => {
      const { applyWebDatabaseUrl, createPool } = await import('../postgres');
      const { getConnectionConfig } = await import('../config');
      applyWebDatabaseUrl();
      assert.equal(getConnectionConfig().connectionString, webUrl);
      assert.equal(createPool().options.user, 'boardsesh_web');
      // Next.js re-evaluates db.ts in development; the pool already matches.
      assert.doesNotThrow(() => applyWebDatabaseUrl());
    });
  });

  void it('falls back to DATABASE_URL when WEB_DATABASE_URL is unset or blank', async () => {
    for (const unsetValue of [undefined, '', '   ']) {
      await withVariables({ DATABASE_URL: contentUrl, WEB_DATABASE_URL: unsetValue }, async () => {
        const { createPool } = await import('../postgres');
        const { getConnectionConfig } = await import('../config');
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
