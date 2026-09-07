import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { prepareResidualReplay } from '../src/testing/moonboard-residual-dedup-replay.js';
import { queryReconciliationReport } from './report-moonboard-reconciliation.js';
import type { CatalogEntry } from './moonboard-reconciliation-report.js';

const replayUrl = process.env.MIGRATION_REPLAY_DB_URL;

void test(
  'report predictions match actual SQL winners and counts in a read-only snapshot',
  { skip: !replayUrl },
  async () => {
    const admin = postgres(replayUrl!, { max: 1, onnotice: () => {} });
    const databaseName = `bs_moonboard_report_${process.pid}`;
    let db: postgres.Sql | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${databaseName}`);
      const connection = new URL(replayUrl!);
      connection.pathname = `/${databaseName}`;
      db = postgres(connection.toString(), { max: 1, onnotice: () => {} });
      const replay = db;
      const catalog: CatalogEntry[] = [
        {
          layoutId: 1,
          problem: {
            id: 5253,
            name: 'Q',
            moves: 's~J1~|e~K1~',
            configurations: [{ apiId: 1, grade: '7A', configuration: '25°', repeats: 1 }],
          },
        },
      ];
      let before: Awaited<ReturnType<typeof queryReconciliationReport>> | undefined;
      await prepareResidualReplay(replay, async () => {
        before = await queryReconciliationReport(replay, catalog, catalog);
      });
      assert.ok(before);
      const after = await queryReconciliationReport(replay, catalog, catalog);
      assert.equal(before.counts.ambiguous, 1);
      assert.deepEqual(after.counts, before.projectedCounts);
      assert.equal(after.skipped.length, 0);
      for (const group of before.groups.filter((group) => group.eligible)) {
        const stats =
          await replay`SELECT angle,upstream_ascensionist_count FROM board_climb_stats WHERE climb_uuid=${group.canonicalUuid} ORDER BY angle`;
        assert.deepEqual(
          stats.map((stat) => [stat.angle, Number(stat.upstream_ascensionist_count)]),
          group.stats.map((stat) => [stat.angle, stat.upstream]),
        );
        const losers = group.memberUuids.filter((uuid) => uuid !== group.canonicalUuid);
        const redirects =
          await replay`SELECT canonical_uuid FROM board_climb_aliases WHERE board_type='moonboard' AND alias_uuid IN ${replay(losers)}`;
        assert.equal(redirects.length, losers.length);
        assert.ok(redirects.every((alias) => alias.canonical_uuid === group.canonicalUuid));
      }
    } finally {
      if (db) await db.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  },
);
