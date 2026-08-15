import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createPool } from '@boardsesh/db/client';
import { db } from '../db/client';
import { toIso } from '../graphql/resolvers/sync/row-normalize';
import {
  createIsolatedSnapshotPool,
  exportLayoutSnapshot,
  waitForReplicaReplay,
} from '../scripts/export-board-snapshots';
import { getWorkerDatabaseUrl } from './worker-db';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error('deferred promise was not initialized');
      resolvePromise();
    },
  };
}

function artifactRows(filePath: string): Array<{ uuid: string }> {
  const artifact = new DatabaseSync(filePath);
  try {
    return artifact.prepare('SELECT uuid FROM board_climbs ORDER BY uuid').all() as Array<{ uuid: string }>;
  } finally {
    artifact.close();
  }
}

function artifactWatermark(filePath: string): { updatedAt: string; syncSeq: string } {
  const artifact = new DatabaseSync(filePath);
  try {
    const row = artifact
      .prepare(
        `SELECT watermark_updated_at, watermark_sync_seq
         FROM snapshot_meta
         WHERE table_name = 'board_climbs'`,
      )
      .get() as { watermark_updated_at: string; watermark_sync_seq: string };
    return { updatedAt: row.watermark_updated_at, syncSeq: row.watermark_sync_seq };
  } finally {
    artifact.close();
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'snapshot-replica-fence-'));
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades RESTART IDENTITY CASCADE`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('replica snapshot fence', () => {
  it('keeps timestamp microseconds and wall-clock values on an isolated replica pool', async () => {
    const replicaPool = createIsolatedSnapshotPool(getWorkerDatabaseUrl(), 1);
    const replicaConnection = await replicaPool.reserve();
    try {
      await replicaConnection.unsafe("SET TIME ZONE 'Australia/Brisbane'");
      const rows = await replicaConnection.unsafe(
        `SELECT '2026-08-15 12:34:56.123456'::timestamp AS timestamp_value,
                '2026-08-15 12:34:56.123456+00'::timestamptz AS timestamptz_value,
                '2026-08-15'::date AS date_value`,
      );
      expect(rows).toEqual([
        {
          timestamp_value: '2026-08-15 12:34:56.123456',
          timestamptz_value: '2026-08-15 22:34:56.123456+10',
          date_value: '2026-08-15',
        },
      ]);
    } finally {
      await replicaConnection.unsafe('RESET TIME ZONE').catch(() => {});
      replicaConnection.release();
      await replicaPool.end({ timeout: 5 });
    }
  });

  it('rejects pg_read_all_stats membership when privileges are not inherited', async () => {
    const pool = createPool();
    const testSuffix = `w${process.env.VITEST_POOL_ID ?? '0'}_p${process.pid}`;
    const roleName = `boardsesh_snapshot_noinherit_${testSuffix}`;
    const functionName = `acquire_board_snapshot_fence_noinherit_${testSuffix}`;
    const quotedRole = quoteIdentifier(roleName);
    const quotedFunction = quoteIdentifier(functionName);
    await pool.unsafe(`DROP FUNCTION IF EXISTS ops.${quotedFunction}(integer)`);
    await pool.unsafe(`DROP ROLE IF EXISTS ${quotedRole}`);
    await pool.unsafe(`CREATE ROLE ${quotedRole} NOLOGIN NOINHERIT`);
    await pool.unsafe(`GRANT pg_read_all_stats TO ${quotedRole}`);
    try {
      const visibilityRows = await pool.unsafe(
        `SELECT pg_has_role($1, 'pg_read_all_stats', 'MEMBER') AS member,
                pg_has_role($1, 'pg_read_all_stats', 'USAGE') AS usage`,
        [roleName],
      );
      expect(visibilityRows).toMatchObject([{ member: true, usage: false }]);

      const definitionRows = await pool.unsafe(
        `SELECT pg_get_functiondef('ops.acquire_board_snapshot_fence(integer)'::regprocedure) AS definition`,
      );
      const productionDefinition = String((definitionRows[0] as unknown as { definition: unknown }).definition);
      const clonedDefinition = productionDefinition.replace(
        'FUNCTION ops.acquire_board_snapshot_fence(',
        `FUNCTION ops.${quotedFunction}(`,
      );
      expect(clonedDefinition).not.toBe(productionDefinition);
      await pool.unsafe(clonedDefinition);
      await pool.unsafe(`ALTER FUNCTION ops.${quotedFunction}(integer) OWNER TO ${quotedRole}`);
      await expect(pool.unsafe(`SELECT * FROM ops.${quotedFunction}(0)`)).rejects.toThrow(
        'effective USAGE of pg_read_all_stats',
      );
    } finally {
      // The clone exercises the exact production body without ever changing
      // the shared function's owner while another test or connection uses it.
      await pool.unsafe(`DROP FUNCTION IF EXISTS ops.${quotedFunction}(integer)`).catch(() => {});
      await pool.unsafe(`REVOKE pg_read_all_stats FROM ${quotedRole}`).catch(() => {});
      await pool.unsafe(`DROP ROLE IF EXISTS ${quotedRole}`).catch(() => {});
    }
  });

  it('keeps an old-starting late commit behind the same cutoff as a newer early commit', async () => {
    const pool = createPool();
    await pool.unsafe(
      `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, updated_at)
       VALUES ('baseline', 'kilter', 1, '{5}'::int[], '2026-01-01T00:00:00Z'::timestamp)`,
    );

    const oldTransactionStarted = deferred();
    const allowOldTransactionCommit = deferred();
    const oldWriter = await pool.reserve();
    const coordinator = await pool.reserve();
    let oldTransaction: Promise<unknown> | null = null;
    let fenceHeld = false;
    try {
      oldTransaction = (async () => {
        await oldWriter.unsafe("SET boardsesh.snapshot_cursor_restore = 'off'");
        await oldWriter.unsafe('BEGIN');
        try {
          await oldWriter.unsafe(
            `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, updated_at)
             VALUES ('old-start-late-commit', 'kilter', 1, '{5}'::int[], '2000-01-01'::timestamp)`,
          );
          // Every explicit timestamp tries to violate the proof. Migration 0200
          // must replace each one with this transaction's UTC start time.
          await oldWriter.unsafe(
            `INSERT INTO board_climb_stats
               (board_type, climb_uuid, angle, updated_at)
             VALUES ('kilter', 'old-start-late-commit', 40, '2000-01-01'::timestamp);
             INSERT INTO board_climb_grades
               (board_type, climb_uuid, angle, confidence, model_version, coeff_version, computed_at)
             VALUES ('kilter', 'old-start-late-commit', 40, 'provisional', 'test', 'test', '2000-01-01'::timestamp);
             INSERT INTO sync_deletions (table_name, record_id, deleted_at)
             VALUES ('board_climbs', 'backdated-tombstone-attempt', '2000-01-01'::timestamp)`,
          );
          oldTransactionStarted.resolve();
          await allowOldTransactionCommit.promise;
          await oldWriter.unsafe('COMMIT');
        } catch (error) {
          await oldWriter.unsafe('ROLLBACK').catch(() => {});
          throw error;
        }
      })();
      await oldTransactionStarted.promise;

      // This transaction starts later but commits before the old writer. A
      // replica can make this row visible first, which is the original race.
      await pool.unsafe(
        `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids)
         VALUES ('new-start-early-commit', 'kilter', 1, '{5}'::int[])`,
      );

      const fenceRows = await coordinator.unsafe(
        `SELECT stable_before, target_lsn::text, primary_system_identifier, primary_timeline_id
         FROM ops.acquire_board_snapshot_fence(0)`,
      );
      fenceHeld = true;
      const fence = fenceRows[0] as unknown as {
        stable_before: unknown;
        target_lsn: unknown;
        primary_system_identifier: unknown;
        primary_timeline_id: unknown;
      };
      const stableBefore = toIso(fence.stable_before);
      expect(String(fence.target_lsn)).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
      expect(fence.primary_system_identifier).toMatch(/^\d+$/);
      expect(Number(fence.primary_timeline_id)).toBeGreaterThan(0);
      await expect(coordinator.unsafe('SELECT ops.board_snapshot_fence_held() AS held')).resolves.toMatchObject([
        { held: true },
      ]);

      const competingCoordinator = await pool.reserve();
      try {
        await expect(
          competingCoordinator.unsafe('SELECT * FROM ops.acquire_board_snapshot_fence(0)'),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        competingCoordinator.release();
      }

      allowOldTransactionCommit.resolve();
      await oldTransaction;

      // Compare in PostgreSQL rather than lexicographically: its timestamp
      // text omits trailing fractional zeroes, so `.505751Z` sorts before
      // `.50575Z` as text even though it is one microsecond later.
      const cursorChecks = await pool.unsafe(
        `SELECT
           (SELECT updated_at FROM board_climbs WHERE uuid = 'old-start-late-commit') > $1::timestamp
             AS climb_after_cutoff,
           (SELECT updated_at FROM board_climb_stats WHERE climb_uuid = 'old-start-late-commit') > $1::timestamp
             AS stats_after_cutoff,
           (SELECT computed_at FROM board_climb_grades WHERE climb_uuid = 'old-start-late-commit') > $1::timestamp
             AS grade_after_cutoff,
           (SELECT deleted_at FROM sync_deletions WHERE record_id = 'backdated-tombstone-attempt') > $1::timestamp
             AS deletion_after_cutoff`,
        [stableBefore],
      );
      expect(cursorChecks).toMatchObject([
        {
          climb_after_cutoff: true,
          stats_after_cutoff: true,
          grade_after_cutoff: true,
          deletion_after_cutoff: true,
        },
      ]);

      const filePath = join(workDir, 'artifact.db');
      await exportLayoutSnapshot({
        sqlClient: pool,
        boardType: 'kilter',
        layoutId: 1,
        filePath,
        builtAt: '2026-08-15T00:00:00.000Z',
        stableBefore,
      });

      expect(artifactRows(filePath)).toEqual([{ uuid: 'baseline' }]);
      const watermark = artifactWatermark(filePath);
      const laterRows = await pool.unsafe(
        `SELECT uuid
         FROM board_climbs
         WHERE (updated_at, sync_seq) > ($1::timestamp, $2::bigint)
         ORDER BY uuid`,
        [watermark.updatedAt, watermark.syncSeq],
      );
      expect(laterRows.map((row) => String(row.uuid))).toEqual(['new-start-early-commit', 'old-start-late-commit']);
    } finally {
      allowOldTransactionCommit.resolve();
      if (oldTransaction) await oldTransaction.catch(() => {});
      if (fenceHeld) await coordinator.unsafe('SELECT ops.release_board_snapshot_fence()');
      coordinator.release();
      oldWriter.release();
    }
  });

  it('uses an exclusive cutoff for rows exactly at stable_before', async () => {
    const pool = createPool();
    const coordinator = await pool.reserve();
    let fenceHeld = false;
    try {
      const rows = await coordinator.unsafe(
        `SELECT stable_before, target_lsn::text
         FROM ops.acquire_board_snapshot_fence(30)`,
      );
      fenceHeld = true;
      const stableBefore = toIso((rows[0] as unknown as { stable_before: unknown }).stable_before);
      await pool.unsafe(
        `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, updated_at)
         VALUES ('at-cutoff', 'kilter', 1, '{5}'::int[], $1::timestamp)`,
        [stableBefore],
      );

      const filePath = join(workDir, 'exact-cutoff.db');
      await exportLayoutSnapshot({
        sqlClient: pool,
        boardType: 'kilter',
        layoutId: 1,
        filePath,
        builtAt: '2026-08-15T00:00:00.000Z',
        stableBefore,
      });
      expect(artifactRows(filePath)).toEqual([]);
    } finally {
      if (fenceHeld) await coordinator.unsafe('SELECT ops.release_board_snapshot_fence()');
      coordinator.release();
    }
  });

  it('refuses a writable primary when asked to wait for replica replay', async () => {
    await expect(
      waitForReplicaReplay({
        sqlClient: createPool(),
        targetLsn: '0/0',
        maxLagSeconds: 30,
        timeoutSeconds: 1,
        expectedSystemIdentifier: 'test-system',
        expectedTimelineId: 1,
        pollMilliseconds: 1,
      }),
    ).rejects.toThrow('not in recovery');
  });

  it('fails closed when replay is paused, too far behind, or misses the deadline', async () => {
    const baseStatus = {
      inRecovery: true,
      replayPaused: false,
      replayLsn: '0/1',
      reachedTarget: false,
      replayLagSeconds: 1,
      systemIdentifier: 'test-system',
      timelineId: 1,
      receiverStatus: 'streaming',
      receiverTimelineId: 1,
    };

    await expect(
      waitForReplicaReplay({
        sqlClient: createPool(),
        targetLsn: '0/2',
        maxLagSeconds: 30,
        timeoutSeconds: 1,
        expectedSystemIdentifier: 'test-system',
        expectedTimelineId: 1,
        readStatus: async () => ({ ...baseStatus, replayPaused: true }),
      }),
    ).rejects.toThrow('replay is paused');

    await expect(
      waitForReplicaReplay({
        sqlClient: createPool(),
        targetLsn: '0/2',
        maxLagSeconds: 30,
        timeoutSeconds: 1,
        expectedSystemIdentifier: 'test-system',
        expectedTimelineId: 1,
        readStatus: async () => ({ ...baseStatus, replayLagSeconds: 31 }),
      }),
    ).rejects.toThrow('maximum is 30s');

    await expect(
      waitForReplicaReplay({
        sqlClient: createPool(),
        targetLsn: '0/2',
        maxLagSeconds: 30,
        timeoutSeconds: 0,
        expectedSystemIdentifier: 'test-system',
        expectedTimelineId: 1,
        readStatus: async () => baseStatus,
      }),
    ).rejects.toThrow('did not replay target');
  });

  it('returns only after the target LSN is reported replayed', async () => {
    let polls = 0;
    const reached = await waitForReplicaReplay({
      sqlClient: createPool(),
      targetLsn: '0/2',
      maxLagSeconds: 30,
      timeoutSeconds: 1,
      expectedSystemIdentifier: 'test-system',
      expectedTimelineId: 1,
      pollMilliseconds: 0,
      sleep: async () => {},
      readStatus: async () => {
        polls += 1;
        return {
          inRecovery: true,
          replayPaused: false,
          replayLsn: polls === 1 ? '0/1' : '0/2',
          reachedTarget: polls > 1,
          replayLagSeconds: polls === 1 ? 1 : 0,
          systemIdentifier: 'test-system',
          timelineId: 1,
          receiverStatus: 'streaming',
          receiverTimelineId: 1,
        };
      },
    });
    expect(polls).toBe(2);
    expect(reached).toMatchObject({ reachedTarget: true, replayLsn: '0/2' });
  });

  it('rejects a streaming standby from a different PostgreSQL system or timeline', async () => {
    const status = {
      inRecovery: true,
      replayPaused: false,
      replayLsn: '0/2',
      reachedTarget: true,
      replayLagSeconds: 0,
      systemIdentifier: 'wrong-system',
      timelineId: 1,
      receiverStatus: 'streaming',
      receiverTimelineId: 1,
    };
    await expect(
      waitForReplicaReplay({
        sqlClient: createPool(),
        targetLsn: '0/2',
        maxLagSeconds: 30,
        timeoutSeconds: 1,
        expectedSystemIdentifier: 'expected-system',
        expectedTimelineId: 1,
        readStatus: async () => status,
      }),
    ).rejects.toThrow('different PostgreSQL system');

    await expect(
      waitForReplicaReplay({
        sqlClient: createPool(),
        targetLsn: '0/2',
        maxLagSeconds: 30,
        timeoutSeconds: 1,
        expectedSystemIdentifier: 'wrong-system',
        expectedTimelineId: 2,
        readStatus: async () => status,
      }),
    ).rejects.toThrow('timeline does not match');
  });
});
