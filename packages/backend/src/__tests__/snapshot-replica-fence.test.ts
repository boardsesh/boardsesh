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
  reservedSnapshotClient,
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

      // The pinned Drizzle postgres-js driver deliberately installs a
      // transparent parser for numeric[] (OID 1231), not time[] (OID 1183).
      // Isolated pools must match that exact, slightly non-obvious contract.
      const parserParityQuery = `SELECT ARRAY[1.25, 2.50]::numeric[] AS numeric_array,
                                        ARRAY['12:34:56.123456'::time] AS time_array`;
      const isolatedParserRows = await replicaConnection.unsafe(parserParityQuery);
      const drizzleParserRows = await createPool().unsafe(parserParityQuery);
      expect(isolatedParserRows).toEqual(drizzleParserRows);
    } finally {
      await replicaConnection.unsafe('RESET TIME ZONE').catch(() => {});
      replicaConnection.release();
      await replicaPool.end({ timeout: 5 });
    }
  });

  it('runs commit and rollback transactions on the exact reserved snapshot backend', async () => {
    const snapshotPool = createIsolatedSnapshotPool(getWorkerDatabaseUrl(), 1);
    const reservedConnection = await snapshotPool.reserve();
    const snapshotClient = reservedSnapshotClient(reservedConnection);
    try {
      const reservedPidRows = await reservedConnection.unsafe('SELECT pg_backend_pid() AS pid');
      const reservedPid = Number((reservedPidRows[0] as unknown as { pid: unknown }).pid);

      await snapshotClient.begin(async (transaction) => {
        const transactionPidRows = await transaction.unsafe('SELECT pg_backend_pid() AS pid');
        expect(Number((transactionPidRows[0] as unknown as { pid: unknown }).pid)).toBe(reservedPid);
        await transaction.unsafe(
          `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids)
           VALUES ('reserved-commit', 'kilter', 1, '{5}'::int[])`,
        );
      });
      await expect(
        reservedConnection.unsafe("SELECT count(*)::int AS count FROM board_climbs WHERE uuid = 'reserved-commit'"),
      ).resolves.toMatchObject([{ count: 1 }]);

      await expect(
        snapshotClient.begin(async (transaction) => {
          await transaction.unsafe(
            `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids)
             VALUES ('reserved-rollback', 'kilter', 1, '{5}'::int[])`,
          );
          throw new Error('force reserved snapshot rollback');
        }),
      ).rejects.toThrow('force reserved snapshot rollback');
      await expect(
        reservedConnection.unsafe("SELECT count(*)::int AS count FROM board_climbs WHERE uuid = 'reserved-rollback'"),
      ).resolves.toMatchObject([{ count: 0 }]);
    } finally {
      reservedConnection.release();
      await snapshotPool.end({ timeout: 5 });
    }
  });

  it('requires certificate and hostname verification for every non-local database URL', async () => {
    const remotePool = createIsolatedSnapshotPool('postgresql://snapshot@example.test:5432/boardsesh', 1);
    const dockerServicePool = createIsolatedSnapshotPool('postgresql://snapshot@postgres:5432/boardsesh', 1);
    const dockerTestServicePool = createIsolatedSnapshotPool('postgresql://snapshot@postgres-test:5432/boardsesh', 1);
    const loopbackPool = createIsolatedSnapshotPool('postgresql://snapshot@127.0.0.1:5432/boardsesh', 1);
    try {
      expect(remotePool.options.ssl).toBe('verify-full');
      expect(dockerServicePool.options.ssl).toBe('verify-full');
      expect(dockerTestServicePool.options.ssl).toBe('verify-full');
      expect(loopbackPool.options.ssl).toBe(false);
    } finally {
      await remotePool.end({ timeout: 0 });
      await dockerServicePool.end({ timeout: 0 });
      await dockerTestServicePool.end({ timeout: 0 });
      await loopbackPool.end({ timeout: 0 });
    }
  });

  it('preserves restored grade cursors on insert but stamps later updates', async () => {
    const pool = createPool();
    await pool.begin(async (transaction) => {
      await transaction.unsafe("SET LOCAL boardsesh.snapshot_cursor_restore = 'on'");
      await transaction.unsafe(
        `INSERT INTO board_climb_grades
           (board_type, climb_uuid, angle, confidence, model_version, coeff_version, computed_at, sync_seq)
         VALUES ('kilter', 'restore-grade', 40, 'provisional', 'test', 'test',
                 '2000-01-01'::timestamp, 41)`,
      );
      const insertedRows = await transaction.unsafe(
        `SELECT computed_at, sync_seq::text
         FROM board_climb_grades
         WHERE board_type = 'kilter' AND climb_uuid = 'restore-grade' AND angle = 40`,
      );
      expect(insertedRows).toMatchObject([{ computed_at: '2000-01-01 00:00:00', sync_seq: '41' }]);

      await transaction.unsafe(
        `UPDATE board_climb_grades
         SET confidence = 'confirmed', computed_at = '2001-01-01'::timestamp, sync_seq = 42
         WHERE board_type = 'kilter' AND climb_uuid = 'restore-grade' AND angle = 40`,
      );
      const updatedRows = await transaction.unsafe(
        `SELECT computed_at, sync_seq::text
         FROM board_climb_grades
         WHERE board_type = 'kilter' AND climb_uuid = 'restore-grade' AND angle = 40`,
      );
      const updated = updatedRows[0] as unknown as { computed_at: unknown; sync_seq: unknown };
      expect(toIso(updated.computed_at)).not.toBe('2001-01-01T00:00:00.000Z');
      expect(String(updated.sync_seq)).not.toBe('42');
    });
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

  it('uses SECURITY DEFINER owner visibility for a narrow caller with only EXECUTE', async () => {
    const pool = createPool();
    const testSuffix = `w${process.env.VITEST_POOL_ID ?? '0'}_p${process.pid}`;
    const roleName = `boardsesh_snapshot_caller_${testSuffix}`;
    const quotedRole = quoteIdentifier(roleName);
    await pool.unsafe(`DROP ROLE IF EXISTS ${quotedRole}`);
    await pool.unsafe(`CREATE ROLE ${quotedRole} NOLOGIN`);
    await pool.unsafe(`GRANT USAGE ON SCHEMA ops TO ${quotedRole}`);
    await pool.unsafe(`GRANT EXECUTE ON FUNCTION ops.acquire_board_snapshot_fence(integer) TO ${quotedRole}`);
    await pool.unsafe(`GRANT EXECUTE ON FUNCTION ops.release_board_snapshot_fence() TO ${quotedRole}`);

    const caller = await pool.reserve();
    let fenceHeld = false;
    try {
      const visibilityRows = await pool.unsafe(`SELECT pg_has_role($1, 'pg_read_all_stats', 'USAGE') AS usage`, [
        roleName,
      ]);
      expect(visibilityRows).toMatchObject([{ usage: false }]);

      await caller.unsafe(`SET SESSION AUTHORIZATION ${quotedRole}`);
      const fenceRows = await caller.unsafe('SELECT * FROM ops.acquire_board_snapshot_fence(0)');
      fenceHeld = true;
      expect(fenceRows).toHaveLength(1);
      expect(fenceRows[0]).toMatchObject({ primary_system_identifier: expect.stringMatching(/^\d+$/) });
    } finally {
      if (fenceHeld) await caller.unsafe('SELECT ops.release_board_snapshot_fence()').catch(() => {});
      await caller.unsafe('RESET SESSION AUTHORIZATION').catch(() => {});
      caller.release();
      await pool
        .unsafe(`REVOKE EXECUTE ON FUNCTION ops.acquire_board_snapshot_fence(integer) FROM ${quotedRole}`)
        .catch(() => {});
      await pool
        .unsafe(`REVOKE EXECUTE ON FUNCTION ops.release_board_snapshot_fence() FROM ${quotedRole}`)
        .catch(() => {});
      await pool.unsafe(`REVOKE USAGE ON SCHEMA ops FROM ${quotedRole}`).catch(() => {});
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

  it('rejects a non-streaming receiver and every non-positive receiver timeline', async () => {
    const baseStatus = {
      inRecovery: true,
      replayPaused: false,
      replayLsn: '0/2',
      reachedTarget: true,
      replayLagSeconds: 0,
      systemIdentifier: 'test-system',
      timelineId: 1,
      receiverStatus: 'streaming',
      receiverTimelineId: 1,
    };
    const wait = (status: typeof baseStatus) =>
      waitForReplicaReplay({
        sqlClient: createPool(),
        targetLsn: '0/2',
        maxLagSeconds: 30,
        timeoutSeconds: 1,
        expectedSystemIdentifier: 'test-system',
        expectedTimelineId: 1,
        readStatus: async () => status,
      });

    await expect(wait({ ...baseStatus, receiverStatus: 'catchup' })).rejects.toThrow(
      'WAL receiver is catchup, expected streaming',
    );
    await expect(wait({ ...baseStatus, receiverTimelineId: 0 })).rejects.toThrow('invalid PostgreSQL timeline');
    await expect(wait({ ...baseStatus, receiverTimelineId: -1 })).rejects.toThrow('invalid PostgreSQL timeline');
  });

  it('never sleeps past the replica replay deadline', async () => {
    let nowMs = 1000;
    let polls = 0;
    const sleeps: number[] = [];
    const status = {
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
        pollMilliseconds: 5000,
        now: () => nowMs,
        readStatus: async () => {
          polls += 1;
          return status;
        },
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          nowMs += milliseconds;
        },
      }),
    ).rejects.toThrow('did not replay target');
    expect(sleeps).toEqual([1000]);
    expect(polls).toBe(1);
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
