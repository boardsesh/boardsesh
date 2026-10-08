/**
 * The export-board-snapshots family's grants, proven: the per-layout exporter
 * and the catalogue exporter run under a real LOGIN role that holds only
 * `WORKER_ROLE_DATA_GRANTS.batch` plus `pg_read_all_stats` (which the admin
 * grants at provisioning). A LOGIN role rather than `SET ROLE`, because the
 * deletion replay observer keys on the session's own user: only a real login
 * shows that the observer sees the writers' transactions across roles.
 *
 * S3 is mocked at the storage/s3 boundary; Postgres is the worker test DB.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_SNAPSHOT_TABLES } from '@boardsesh/db/catalog-snapshot';
import type { DbInstance } from '@boardsesh/db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';

vi.mock('../../storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  getPublicUrl: vi.fn((_bucket: string, key: string) => `https://cdn.example/${key}`),
  uploadToS3: vi.fn(async (_bucket: string, _buffer: Buffer, key: string) => ({ key })),
  getFromS3Strict: vi.fn(async () => null),
  deleteFromS3: vi.fn(async () => {}),
  listS3Objects: vi.fn(async () => []),
}));

const { db } = await import('../../db/client');
const { getFromS3Strict, uploadToS3 } = await import('../../storage/s3');
const { exportLayoutSnapshot, runExportWithOptions } = await import('../../scripts/export-board-snapshots');
const { catalogColumnsFor, runCatalogExportWithOptions } = await import('../../scripts/export-board-catalog');
const { exportBoardSnapshotsFamily } = await import('../../workers/families/export-board-snapshots');

const BOARD = 'kilter';
// Far from every other fixture's layout ids, so a shared worker DB never mixes them.
const LAYOUT = 987_654;
const CLIMBS = ['snapshot-grants-a', 'snapshot-grants-b'];
const LIVE_PREFIX = 'board-snapshots/v1-gzip';
const LIVE_MANIFEST_KEY = `${LIVE_PREFIX}/manifest.json`;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function uploadedKeys(): string[] {
  return vi.mocked(uploadToS3).mock.calls.map(([, , key]) => key);
}

function lastUploadOf(key: string): Buffer {
  const call = vi
    .mocked(uploadToS3)
    .mock.calls.filter(([, , uploadedKey]) => uploadedKey === key)
    .at(-1);
  if (!call) throw new Error(`nothing uploaded at ${key}`);
  return call[1];
}

async function seedLayout(): Promise<void> {
  for (const uuid of CLIMBS) {
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, updated_at)
      VALUES (${uuid}, ${BOARD}, ${LAYOUT}, ${'Climb ' + uuid}, true, false, '{5}'::int[], '2026-05-01T00:00:00Z')
    `);
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, updated_at)
      VALUES (${BOARD}, ${uuid}, 40, 20, '2026-05-01T00:00:00Z')
    `);
    await db.execute(sql`
      INSERT INTO board_climb_grades
        (board_type, climb_uuid, angle, local_grade, universal_grade, confidence,
         ascensionist_count, model_version, coeff_version, computed_at)
      VALUES (${BOARD}, ${uuid}, 40, 20, 19, 'high', 100, 'test-model', 'test-coeff', '2026-05-01T00:00:00Z')
    `);
  }
}

async function clearLayout(): Promise<void> {
  await db.execute(
    sql`DELETE FROM board_climb_grades WHERE board_type = ${BOARD} AND climb_uuid LIKE 'snapshot-grants-%'`,
  );
  await db.execute(
    sql`DELETE FROM board_climb_stats WHERE board_type = ${BOARD} AND climb_uuid LIKE 'snapshot-grants-%'`,
  );
  await db.execute(sql`DELETE FROM board_climbs WHERE board_type = ${BOARD} AND layout_id = ${LAYOUT}`);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(uploadToS3).mockImplementation(async (_bucket, _buffer: Buffer, key: string) => ({
    key,
    url: `https://cdn.example/${key}`,
  }));
  vi.mocked(getFromS3Strict).mockResolvedValue(null);
  vi.stubEnv('SNAPSHOT_PUBLIC_BASE_URL', 'https://snapshots.example');
  await clearLayout();
  await seedLayout();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await clearLayout();
});

describe('export-board-snapshots under the batch login', () => {
  it('publishes every pass with only the batch grants plus pg_read_all_stats', async () => {
    const login = `batch_snapshots_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    const owner = postgres(process.env.DATABASE_URL!, { max: 1 });
    const loginUrl = new URL(process.env.DATABASE_URL!);
    loginUrl.username = login;
    loginUrl.password = password;
    // The worker's budget: the export transaction plus the replay observer.
    const restricted = postgres(loginUrl.toString(), { max: 2 });
    // createPool's guarantee: drizzle's timestamp parsers on the raw pool.
    drizzle(restricted);
    const workDir = mkdtempSync(join(tmpdir(), 'snapshot-grants-'));
    try {
      // Test-worker databases are built from schema-sql.ts, which has no ledger.
      const [ledger] = await owner`SELECT to_regclass('public.background_job_runs') AS present`;
      if (!ledger.present) {
        for (const migration of ['0241_background_job_runs.sql', '0243_background_job_families.sql']) {
          await owner.unsafe(readFileSync(new URL(`../../../../db/drizzle/${migration}`, import.meta.url), 'utf8'));
        }
      }
      await owner.unsafe(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}'`);
      await initializeJobQueueSchema(drizzle(owner), undefined, undefined, [`batch=${login}`]);

      // Before the admin grants pg_read_all_stats, the observer sees no other
      // role's session, so a worker export must refuse to stamp a boundary...
      const [before] = await restricted`SELECT pg_has_role('pg_read_all_stats', 'USAGE') AS reads_all_stats`;
      expect(before.reads_all_stats).toBe(false);
      const blind = await exportLayoutSnapshot({
        sqlClient: restricted,
        boardType: BOARD,
        layoutId: LAYOUT,
        filePath: join(workDir, 'blind.db'),
        builtAt: new Date().toISOString(),
        requireAllRolesVisible: true,
      });
      expect(blind.deletionsReplayFrom).toBeNull();
      expect(blind.deletionsReplayFallbackReason).toBe('activity-visibility-incomplete');
      // ...and the live pass then publishes no artifact for the layout.
      await expect(
        runExportWithOptions(
          { dryRun: false, gzip: true, keyPrefix: LIVE_PREFIX, boardFilter: BOARD, layoutFilter: LAYOUT },
          { sqlClient: restricted, log: quiet, requireAllRolesVisible: true },
        ),
      ).rejects.toThrow(/Export failed for 1 layout/);
      expect(uploadedKeys().filter((key) => key !== LIVE_MANIFEST_KEY)).toEqual([]);

      // The admin's provisioning step (docs/background-workers.md).
      await owner.unsafe(`GRANT pg_read_all_stats TO "${login}"`);

      // A writer on another role holds a transaction open: the boundary must
      // reach back to its start, or a tombstone it commits later is never
      // replayed.
      const writer = postgres(process.env.DATABASE_URL!, { max: 1 });
      let releaseWriter = (): void => {};
      const writerReleased = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let writerStarted!: (startedAt: string) => void;
      const writerStartedAt = new Promise<string>((resolve) => {
        writerStarted = resolve;
      });
      const writerTransaction = writer
        .begin(async (transaction) => {
          await transaction`UPDATE board_climbs SET name = name WHERE uuid = ${CLIMBS[0]}`;
          const [start] = await transaction`SELECT transaction_timestamp() AS started_at`;
          writerStarted(new Date(start.started_at as Date).toISOString());
          await writerReleased;
          throw new Error('roll back the fixture write');
        })
        .catch(() => {});
      try {
        const startedAt = await writerStartedAt;
        const observed = await exportLayoutSnapshot({
          sqlClient: restricted,
          boardType: BOARD,
          layoutId: LAYOUT,
          filePath: join(workDir, 'observed.db'),
          builtAt: new Date().toISOString(),
          stabilityWindowSeconds: 0,
          requireAllRolesVisible: true,
        });
        expect(observed.deletionsReplayFallbackReason).toBeNull();
        expect(observed.deletionsReplayFrom).toBe(startedAt);
        expect(observed.tables.board_climbs.rowCount).toBe(CLIMBS.length);
      } finally {
        releaseWriter();
        await writerTransaction;
        await writer.end();
      }

      // The nightly's identity and live passes, filtered to the fixture layout.
      vi.clearAllMocks();
      const dependencies = { sqlClient: restricted, log: quiet, requireAllRolesVisible: true };
      await runExportWithOptions(
        { dryRun: false, gzip: false, keyPrefix: 'board-snapshots/v1', boardFilter: BOARD, layoutFilter: LAYOUT },
        dependencies,
      );
      await runExportWithOptions(
        { dryRun: false, gzip: true, keyPrefix: LIVE_PREFIX, boardFilter: BOARD, layoutFilter: LAYOUT },
        dependencies,
      );
      expect(uploadedKeys().filter((key) => key.endsWith('manifest.json'))).toEqual([
        'board-snapshots/v1/manifest.json',
        LIVE_MANIFEST_KEY,
      ]);
      // Identity whole-layout, live whole-layout, live grades.
      expect(uploadedKeys().filter((key) => !key.endsWith('manifest.json'))).toHaveLength(3);

      // The live scan's threshold probes, against the manifest just published.
      const liveManifest = lastUploadOf(LIVE_MANIFEST_KEY);
      vi.mocked(getFromS3Strict).mockResolvedValue({
        stream: Readable.from([liveManifest]),
        contentType: 'application/json',
        contentLength: undefined,
      });
      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, updated_at)
        VALUES (${BOARD}, ${CLIMBS[1]}, 45, 21, '2026-06-01T00:00:00Z')
      `);
      vi.mocked(uploadToS3).mockClear();
      await runExportWithOptions(
        {
          dryRun: false,
          gzip: true,
          keyPrefix: LIVE_PREFIX,
          refreshThreshold: 1,
          boardFilter: BOARD,
          layoutFilter: LAYOUT,
        },
        dependencies,
      );
      expect(uploadedKeys().filter((key) => key.includes(`/${BOARD}/${LAYOUT}/`))).toHaveLength(2);
      expect(uploadedKeys()).toContain(LIVE_MANIFEST_KEY);

      // The catalogue: every contract table, with exactly the owner's columns.
      vi.mocked(uploadToS3).mockClear();
      await runCatalogExportWithOptions(
        { dryRun: false, keyPrefix: 'board-snapshots/v1-catalog' },
        { sqlClient: restricted, log: quiet },
      );
      expect(uploadedKeys().at(-1)).toBe('board-snapshots/v1-catalog/manifest.json');
      for (const { name } of CATALOG_SNAPSHOT_TABLES) {
        expect(await catalogColumnsFor(restricted, name)).toEqual(await catalogColumnsFor(owner, name));
      }

      // The family's own ledger reads, under the same login: a scan yields to a
      // running snapshot run, and a stale retry fails instead of succeeding.
      const familyDatabase = drizzle(restricted, { schema: dbSchema }) as unknown as DbInstance;
      const runRow = (overrides: Partial<typeof dbSchema.backgroundJobRuns.$inferInsert>) => ({
        id: randomUUID(),
        queue: 'background-batch',
        role: 'batch' as const,
        family: 'export-board-snapshots',
        payload: { mode: 'live-scan' },
        deadlineAt: new Date(Date.now() + 60 * 60 * 1000),
        ...overrides,
      });
      const familyContext = (runId: string) => ({
        runId,
        family: 'export-board-snapshots' as const,
        signal: new AbortController().signal,
        expiresAt: Date.now() + 60 * 60 * 1000,
        database: familyDatabase,
        transaction: () => Promise.reject(new Error('no fenced statement expected')),
        enqueue: () => Promise.reject(new Error('enqueue not expected')),
      });
      // Its last touch is past one heartbeat window (120 s) but inside three:
      // a stall, not a dead worker, so it still counts as running.
      const stalled = new Date(Date.now() - 200 * 1000);
      const running = runRow({ status: 'running', attemptNumber: 0, startedAt: stalled, heartbeatAt: stalled });
      const waitingScan = runRow({ status: 'running', attemptNumber: 0 });
      const staleRetry = runRow({
        status: 'running',
        attemptNumber: 1,
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      });
      const ownerDatabase = drizzle(owner, { schema: dbSchema });
      await ownerDatabase.insert(dbSchema.backgroundJobRuns).values([running, waitingScan, staleRetry]);
      try {
        vi.mocked(uploadToS3).mockClear();
        await exportBoardSnapshotsFamily.execute(familyContext(waitingScan.id), { mode: 'live-scan' });
        expect(uploadToS3).not.toHaveBeenCalled();
        await expect(
          exportBoardSnapshotsFamily.execute(familyContext(waitingScan.id), { mode: 'nightly' }),
        ).rejects.toMatchObject({ code: 'SNAPSHOT_RUN_ACTIVE' });
        await expect(
          exportBoardSnapshotsFamily.execute(familyContext(staleRetry.id), { mode: 'live-scan' }),
        ).rejects.toMatchObject({ code: 'LIVE_SCAN_STALE' });
      } finally {
        await owner`DELETE FROM background_job_runs WHERE id IN ${owner([running.id, waitingScan.id, staleRetry.id])}`;
      }

      // Origin reads enforce public-only output; catalogue writes remain denied.
      // Origin columns are needed to exclude personal beta from public artifacts.
      await expect(
        restricted`SELECT created_by_user_id, tick_uuid, board_id FROM board_beta_links LIMIT 1`,
      ).resolves.toBeDefined();
      await expect(restricted`UPDATE board_layouts SET name = name WHERE false`).rejects.toThrow('permission denied');
      await expect(restricted`DELETE FROM board_climb_stats WHERE false`).rejects.toThrow('permission denied');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      await restricted.end();
      await owner.unsafe(`DROP OWNED BY "${login}"`);
      await owner.unsafe(`DROP ROLE "${login}"`);
      await owner.end();
    }
  }, 90_000);
});
