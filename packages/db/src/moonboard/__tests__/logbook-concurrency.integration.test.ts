import assert from 'node:assert/strict';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { acquireUserTickMutationLock } from '../../queries/ticks/user-tick-mutation-lock.js';
import { applyMoonBoardLogbook } from '../logbook.js';

const adminUrl = process.env.MIGRATION_REPLAY_DB_URL;
const snapshot = {
  accountId: 'fixture-account',
  schemaVersion: 1,
  scope: 'authenticated_account_own_logbook',
  count: 0,
  observedAppCount: 0,
  response: { gyms: [], logbook: [] },
};

void test(
  'MoonBoard imports share the current user tick gate and checkpoint transaction',
  { skip: !adminUrl },
  async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    const databaseName = `bs_moonboard_daemon_gate_${process.pid}`;
    let first: postgres.Sql | undefined;
    let second: postgres.Sql | undefined;
    let inspector: postgres.Sql | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${databaseName}`);
      const url = new URL(adminUrl!);
      url.pathname = `/${databaseName}`;
      first = postgres(url.toString(), { max: 1, max_lifetime: null, onnotice: () => {} });
      second = postgres(url.toString(), { max: 1, max_lifetime: null, onnotice: () => {} });
      inspector = postgres(url.toString(), { max: 1, onnotice: () => {} });
      await inspector`CREATE TABLE board_climb_aliases (board_type text, alias_uuid text, canonical_uuid text)`;
      await inspector`CREATE TABLE fixture_checkpoints (source text)`;
      const [{ pid: firstPid }] = await first<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const [{ pid: secondPid }] = await second<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const waitForGate = async (pid: number) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const waiting =
            await inspector!`SELECT 1 FROM pg_locks WHERE pid=${pid} AND locktype='advisory' AND NOT granted`;
          if (waiting.length) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail('Writer did not wait on the shared user tick advisory gate');
      };
      const asDatabase = (connection: postgres.TransactionSql, client: postgres.Sql) =>
        drizzle(Object.assign(connection, { options: client.options }) as unknown as postgres.Sql);
      let importPromise: ReturnType<typeof applyMoonBoardLogbook> | undefined;
      await first.begin(async (connection) => {
        await acquireUserTickMutationLock(asDatabase(connection, first!), 'fixture-user');
        importPromise = applyMoonBoardLogbook(second!, 'fixture-user', 'fixture-account', snapshot);
        await waitForGate(secondPid);
      });
      assert.deepEqual(await importPromise, { count: 0, inserted: 0, claimed: 0 });

      let releaseImport!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseImport = resolve;
      });
      let notifyImportEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        notifyImportEntered = resolve;
      });
      const heldImport = applyMoonBoardLogbook(second, 'fixture-user', 'fixture-account', snapshot, {
        beforeCommit: async () => {
          notifyImportEntered();
          await release;
        },
      });
      await entered;
      const editPromise = first.begin(async (connection) => {
        await acquireUserTickMutationLock(asDatabase(connection, first!), 'fixture-user');
      });
      try {
        await waitForGate(firstPid);
      } finally {
        releaseImport();
      }
      await Promise.all([heldImport, editPromise]);

      await assert.rejects(
        () =>
          applyMoonBoardLogbook(second!, 'fixture-user', 'fixture-account', snapshot, {
            beforeCommit: async (connection) => {
              await connection`INSERT INTO fixture_checkpoints (source) VALUES ('rolled-back-import')`;
              throw new Error('Synthetic checkpoint failure');
            },
          }),
        /Synthetic checkpoint failure/,
      );
      assert.equal((await inspector`SELECT * FROM fixture_checkpoints`).length, 0);
    } finally {
      await first?.end();
      await second?.end();
      await inspector?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  },
);
