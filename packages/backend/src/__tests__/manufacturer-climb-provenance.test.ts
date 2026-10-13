import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { createPool, rowsFromResult } from '@boardsesh/db/client';
import { privateSafeFirstAscentName, recomputeClimbStats, recomputeClimbStatsBulk } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { syncSharedData, upsertClimbStats, upsertTableData } from '@boardsesh/aurora-sync/sync';
import { reconcileDeletions } from '@boardsesh/kilter-sync/sync';
import type { Climb } from '@boardsesh/aurora-sync/api';
import { db } from '../db/client';
import { withdrawDeletedAccountContent } from '../graphql/resolvers/users/delete-account-privacy';
import { exportLayoutSnapshot } from '../scripts/export-board-snapshots';
import { pullAllDocuments } from './helpers/sync-audience-fixture';

// ---------------------------------------------------------------------------
// A manufacturer climb keeps the manufacturer's stats when it has an owner
// (real Postgres).
//
// The linked-account draft import stamps the importing account on an Aurora
// draft, because a draft goes to its owner alone, and the owner backfill gives
// older drafts and unlisted climbs one. The owner is for visibility only: the
// climb is still the manufacturer's. When upstream publishes it and a climber
// logs a send here, its first ascent, quality and grade stay upstream's, and
// the first-ascent credit still ships in the REFERENCE stream, the snapshot
// artifact and the online read. A climb set in Boardsesh is unchanged: its
// stats come from ticks and its first-ascent name never ships.
// ---------------------------------------------------------------------------

const { mockSharedSync } = vi.hoisted(() => ({ mockSharedSync: vi.fn() }));

// The only network call in syncSharedData; every write behind it is real.
vi.mock('../../../aurora-sync/src/api/shared-sync-api', () => ({ sharedSync: mockSharedSync }));

const BOARD = 'tension';
const LAYOUT_ID = 9;
const ANGLE = 40;
const AURORA_USER_ID = 880_101;
const IMPORTER = 'provenance-importer';
const CLIMBER = 'provenance-climber';
const SETTER = 'provenance-boardsesh-setter';
const USERS = [IMPORTER, CLIMBER, SETTER];
const UPSTREAM_FIRST_ASCENT = 'aurora-first-ascent';
const UPSTREAM_FIRST_ASCENT_AT = '2026-06-03 10:00:00';
const UPSTREAM_GRADE = 20;
const TICKED_GRADE = 26;

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

type RecomputeDb = Parameters<typeof recomputeClimbStatsBulk>[0];
const recomputeDb = db as unknown as RecomputeDb;
const userSyncDb = db as unknown as Parameters<typeof upsertTableData>[0];
const sharedSyncDb = db as unknown as Parameters<typeof upsertClimbStats>[0];

type StoredStats = {
  fa_username: string | null;
  fa_at: string | null;
  display_difficulty: number | null;
  boardsesh_quality_count: number | null;
  tick_graded_at: string | null;
};

async function storedStats(uuid: string): Promise<StoredStats> {
  const [row] = rowsFromResult<StoredStats>(
    await db.execute(sql`
      SELECT fa_username, fa_at::text AS fa_at, display_difficulty, boardsesh_quality_count, tick_graded_at::text AS tick_graded_at
        FROM board_climb_stats
       WHERE board_type = ${BOARD} AND climb_uuid = ${uuid} AND angle = ${ANGLE}`),
  );
  if (!row) throw new Error(`no stats row for ${uuid}`);
  return row;
}

let uuidCounter = 0;
function uniqueUuid(label: string): string {
  uuidCounter += 1;
  return `provenance-${process.pid}-${uuidCounter}-${label}`;
}

/** One row of Aurora's `draft_climbs` user-sync table, as the API sends it: every value a string. */
function auroraDraft(uuid: string): Record<string, string> {
  return {
    uuid,
    layout_id: String(LAYOUT_ID),
    setter_username: 'upstream-setter',
    name: 'Imported idea',
    description: '',
    hsm: '1',
    edge_left: '0',
    edge_right: '100',
    edge_bottom: '0',
    edge_top: '100',
    angle: String(ANGLE),
    frames_count: '1',
    frames_pace: '0',
    frames: 'p1r5',
    created_at: '2026-06-01 10:00:00',
  };
}

/** The same climb in Aurora's shared `climbs` table once its setter publishes it. */
function publishedUpstream(uuid: string): Climb {
  return {
    uuid,
    name: 'Imported idea',
    description: '',
    hsm: 1,
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    frames_count: 1,
    frames_pace: 0,
    frames: 'p1r5',
    setter_id: AURORA_USER_ID,
    setter_username: 'upstream-setter',
    layout_id: LAYOUT_ID,
    is_draft: false,
    is_listed: true,
    created_at: '2026-06-01 10:00:00',
    updated_at: '2026-06-02 10:00:00',
    angle: ANGLE,
  };
}

/**
 * The full path the finding names: the importing account's draft import, the
 * catalogue sync publishing it, and Aurora's stats for it.
 */
async function importPublishedManufacturerClimb(uuid: string): Promise<void> {
  await upsertTableData(userSyncDb, BOARD, 'draft_climbs', AURORA_USER_ID, IMPORTER, [auroraDraft(uuid)], () => {});
  mockSharedSync.mockReset();
  mockSharedSync.mockResolvedValue({ _complete: true, climbs: [publishedUpstream(uuid)] });
  await syncSharedData(db, BOARD, 'token', () => {});
  await upsertClimbStats(sharedSyncDb, BOARD, [
    {
      climb_uuid: uuid,
      angle: ANGLE,
      display_difficulty: UPSTREAM_GRADE,
      benchmark_difficulty: null,
      ascensionist_count: 40,
      difficulty_average: UPSTREAM_GRADE,
      quality_average: 2.5,
      fa_username: UPSTREAM_FIRST_ASCENT,
      fa_at: UPSTREAM_FIRST_ASCENT_AT,
    },
  ]);
}

/** A climber here logs a rated, graded send of the climb. */
async function logLocalSend(uuid: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks
      (uuid, user_id, board_type, climb_uuid, angle, status, origin, attempt_count, quality, difficulty, climbed_at)
    VALUES
      (${`${uuid}-tick`}, ${CLIMBER}, ${BOARD}, ${uuid}, ${ANGLE}, 'send', 'native', 1, 1, ${TICKED_GRADE},
       '2026-06-05 10:00:00')
  `);
}

async function removeFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE climb_uuid LIKE 'provenance-%'`);
  await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE 'provenance-%'`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'provenance-%'`);
  await db.execute(sql`DELETE FROM content_privacy WHERE entity_id LIKE 'provenance-%'`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

describeWithDatabase('a manufacturer climb with an owner keeps the manufacturer’s stats (real DB)', () => {
  beforeAll(async () => {
    await removeFixtures();
  });

  beforeEach(async () => {
    await removeFixtures();
    for (const userId of USERS) {
      await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${userId}, ${`Name of ${userId}`}, ${`${userId}@example.test`})`,
      );
    }
  });

  afterAll(async () => {
    await removeFixtures();
  });

  it('is imported with an owner and stays the manufacturer’s climb', async () => {
    const uuid = uniqueUuid('shape');
    await importPublishedManufacturerClimb(uuid);

    const [climb] = rowsFromResult<{
      user_id: string | null;
      synced: boolean;
      setter_id: number | null;
      is_boardsesh_authored: boolean;
      is_draft: boolean;
      is_listed: boolean;
    }>(
      await db.execute(sql`
        SELECT user_id, synced, setter_id, is_boardsesh_authored, is_draft, is_listed
          FROM board_climbs WHERE uuid = ${uuid}`),
    );
    expect(climb).toEqual({
      user_id: IMPORTER,
      synced: true,
      setter_id: AURORA_USER_ID,
      is_boardsesh_authored: false,
      is_draft: false,
      is_listed: true,
    });
  });

  it('keeps upstream’s first ascent, grade and quality through a single-key recompute', async () => {
    const uuid = uniqueUuid('single');
    await importPublishedManufacturerClimb(uuid);
    await logLocalSend(uuid);

    await recomputeClimbStats(recomputeDb, BOARD, uuid, ANGLE);

    const stats = await storedStats(uuid);
    expect(stats.fa_username).toBe(UPSTREAM_FIRST_ASCENT);
    expect(stats.fa_at).toBe(UPSTREAM_FIRST_ASCENT_AT);
    expect(Number(stats.display_difficulty)).toBe(UPSTREAM_GRADE);
    expect(stats.tick_graded_at).toBeNull();
    // The local rating joins the blend as one Boardsesh vote; it does not
    // replace the manufacturer's average with a plain average of ticks.
    expect(Number(stats.boardsesh_quality_count)).toBe(1);
  });

  it('keeps upstream’s first ascent, grade and quality through a bulk recompute', async () => {
    const uuid = uniqueUuid('bulk');
    await importPublishedManufacturerClimb(uuid);
    await logLocalSend(uuid);

    await recomputeClimbStatsBulk(recomputeDb, [{ boardType: BOARD, climbUuid: uuid, angle: ANGLE }]);

    const stats = await storedStats(uuid);
    expect(stats.fa_username).toBe(UPSTREAM_FIRST_ASCENT);
    expect(stats.fa_at).toBe(UPSTREAM_FIRST_ASCENT_AT);
    expect(Number(stats.display_difficulty)).toBe(UPSTREAM_GRADE);
    expect(stats.tick_graded_at).toBeNull();
    expect(Number(stats.boardsesh_quality_count)).toBe(1);
  });

  it('ships upstream’s first-ascent credit in the REFERENCE stream and the online read', async () => {
    const uuid = uniqueUuid('reference');
    await importPublishedManufacturerClimb(uuid);

    const documents = await pullAllDocuments({
      resolver: 'syncClimbStats',
      scope: { boardType: BOARD, layoutId: LAYOUT_ID },
      viewerId: CLIMBER,
      audience: 'REFERENCE',
    });
    const shipped = documents.find((document) => document.climb_uuid === uuid);
    expect(shipped?.fa_username).toBe(UPSTREAM_FIRST_ASCENT);
    expect(shipped?.fa_at).not.toBeNull();

    const [online] = rowsFromResult<{ fa_username: string | null }>(
      await db.execute(sql`
        SELECT ${privateSafeFirstAscentName(
          {
            boardType: dbSchema.boardClimbStats.boardType,
            climbUuid: dbSchema.boardClimbStats.climbUuid,
            angle: dbSchema.boardClimbStats.angle,
            username: dbSchema.boardClimbStats.faUsername,
          },
          null,
        )} AS fa_username
          FROM board_climb_stats
         WHERE board_climb_stats.board_type = ${BOARD} AND board_climb_stats.climb_uuid = ${uuid}`),
    );
    expect(online?.fa_username).toBe(UPSTREAM_FIRST_ASCENT);
  });

  describe('the snapshot artifact', () => {
    let workDir: string;
    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), 'manufacturer-provenance-'));
    });
    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it('carries upstream’s first-ascent credit', async () => {
      const uuid = uniqueUuid('artifact');
      await importPublishedManufacturerClimb(uuid);

      const filePath = join(workDir, 'artifact.db');
      await exportLayoutSnapshot({
        sqlClient: createPool(),
        boardType: BOARD,
        layoutId: LAYOUT_ID,
        filePath,
        builtAt: '2026-06-10T00:00:00.000Z',
        stabilityWindowSeconds: 0,
      });

      const artifact = new DatabaseSync(filePath);
      try {
        const row = artifact
          .prepare('SELECT fa_username FROM board_climb_stats WHERE climb_uuid = ? AND angle = ?')
          .get(uuid, ANGLE) as { fa_username: string | null } | undefined;
        expect(row?.fa_username).toBe(UPSTREAM_FIRST_ASCENT);
      } finally {
        artifact.close();
      }
    });
  });

  it('is not marked as Boardsesh-authored when its owner deletes their account', async () => {
    const uuid = uniqueUuid('deleted-owner');
    await importPublishedManufacturerClimb(uuid);

    await db.transaction(async (tx) => {
      await withdrawDeletedAccountContent(
        tx as unknown as Parameters<typeof withdrawDeletedAccountContent>[0],
        IMPORTER,
      );
    });

    const [climb] = rowsFromResult<{ is_boardsesh_authored: boolean }>(
      await db.execute(sql`SELECT is_boardsesh_authored FROM board_climbs WHERE uuid = ${uuid}`),
    );
    expect(climb?.is_boardsesh_authored).toBe(false);
  });

  describe('the repair migration for first ascents the old recompute wrote', () => {
    /** Located by name, so the renumber bot can move it. */
    function repairStatements(): string[] {
      const drizzleDir = fileURLToPath(new URL('../../../db/drizzle/', import.meta.url));
      const fileName = readdirSync(drizzleDir).find((name) =>
        name.endsWith('_manufacturer_climb_first_ascent_repair.sql'),
      );
      if (!fileName) throw new Error('the first-ascent repair migration is missing');
      return readFileSync(join(drizzleDir, fileName), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
    }

    async function runRepair(): Promise<void> {
      for (const statement of repairStatements()) await db.execute(sql.raw(statement));
    }

    async function seedClimb(
      uuid: string,
      provenance: { userId: string | null; synced: boolean; setterId: number | null },
    ): Promise<void> {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed, user_id, synced, setter_id)
        VALUES (${uuid}, ${BOARD}, ${LAYOUT_ID}, 'Repair fixture', 'p1r5', false, true, ${provenance.userId},
                ${provenance.synced}, ${provenance.setterId})
      `);
    }

    async function seedStats(uuid: string, firstAscent: { name: string; at: string; upstreamSyncedAt: string | null }) {
      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, fa_username, fa_at, upstream_synced_at)
        VALUES (${BOARD}, ${uuid}, ${ANGLE}, 1, ${firstAscent.name}, ${firstAscent.at}, ${firstAscent.upstreamSyncedAt})
      `);
    }

    async function seedSend(uuid: string, climbedAt: string): Promise<void> {
      await db.execute(sql`
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, origin, attempt_count, climbed_at)
        VALUES (${`${uuid}-send`}, ${CLIMBER}, ${BOARD}, ${uuid}, ${ANGLE}, 'send', 'native', 1, ${climbedAt})
      `);
    }

    async function firstAscents(): Promise<Record<string, string | null>> {
      const rows = rowsFromResult<{ climb_uuid: string; fa_username: string | null }>(
        await db.execute(sql`
          SELECT climb_uuid, fa_username FROM board_climb_stats
           WHERE climb_uuid LIKE 'provenance-repair-%' ORDER BY climb_uuid`),
      );
      return Object.fromEntries(rows.map((row) => [row.climb_uuid, row.fa_username]));
    }

    it('clears a tick-derived first ascent on an owned manufacturer climb and nothing else', async () => {
      const manufacturer = { userId: IMPORTER, synced: true, setterId: AURORA_USER_ID };
      const sendAt = '2026-10-13 09:00:00';

      // A draft's stats exist only because of ticks: the name came from one.
      await seedClimb('provenance-repair-draft-stats', manufacturer);
      await seedStats('provenance-repair-draft-stats', { name: 'Climber', at: sendAt, upstreamSyncedAt: null });
      await seedSend('provenance-repair-draft-stats', sendAt);
      // Aurora wrote the row, then the old recompute stamped a send over it.
      await seedClimb('provenance-repair-overwritten', manufacturer);
      await seedStats('provenance-repair-overwritten', {
        name: 'Climber',
        at: sendAt,
        upstreamSyncedAt: '2026-10-12 00:00:00',
      });
      await seedSend('provenance-repair-overwritten', sendAt);
      // Aurora's own credit on an owned manufacturer climb: kept.
      await seedClimb('provenance-repair-upstream-credit', manufacturer);
      await seedStats('provenance-repair-upstream-credit', {
        name: UPSTREAM_FIRST_ASCENT,
        at: UPSTREAM_FIRST_ASCENT_AT,
        upstreamSyncedAt: '2026-10-12 00:00:00',
      });
      await seedSend('provenance-repair-upstream-credit', sendAt);
      // A climb set in Boardsesh: its name never ships, and the recompute owns it.
      await seedClimb('provenance-repair-set-here', { userId: SETTER, synced: false, setterId: null });
      await seedStats('provenance-repair-set-here', { name: 'Climber', at: sendAt, upstreamSyncedAt: null });
      // Woods writes `synced` on a climb it mints, with no manufacturer setter.
      await seedClimb('provenance-repair-synced-set-here', { userId: SETTER, synced: true, setterId: null });
      await seedStats('provenance-repair-synced-set-here', { name: 'Climber', at: sendAt, upstreamSyncedAt: null });
      // A catalogue climb with no owner: not this repair's business.
      await seedClimb('provenance-repair-catalogue', { userId: null, synced: true, setterId: AURORA_USER_ID });
      await seedStats('provenance-repair-catalogue', { name: 'Catalogue FA', at: sendAt, upstreamSyncedAt: null });

      await runRepair();

      expect(await firstAscents()).toEqual({
        'provenance-repair-catalogue': 'Catalogue FA',
        'provenance-repair-draft-stats': null,
        'provenance-repair-overwritten': null,
        'provenance-repair-set-here': 'Climber',
        'provenance-repair-synced-set-here': 'Climber',
        'provenance-repair-upstream-credit': UPSTREAM_FIRST_ASCENT,
      });

      // Idempotent: a second run changes nothing.
      await runRepair();
      expect((await firstAscents())['provenance-repair-upstream-credit']).toBe(UPSTREAM_FIRST_ASCENT);
    });
  });

  // The Kilter catalogue sync manages listing for Kilter's climbs. The owner
  // backfill assigns unlisted Kilter climbs to an account; that must not take
  // them out of Kilter's hands, or Kilter could never unlist or re-list them.
  it('lets the Kilter catalogue sync unlist an owned Kilter climb, and never one set in Boardsesh', async () => {
    async function seedKilterClimb(
      uuid: string,
      provenance: { userId: string | null; synced: boolean; setterId: number | null },
    ) {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed, user_id, synced, setter_id)
        VALUES (${uuid}, 'kilter', 1, 'Kilter fixture', 'p1r5', false, true, ${provenance.userId}, ${provenance.synced},
                ${provenance.setterId})
      `);
    }
    await seedKilterClimb('provenance-kilter-owned', { userId: IMPORTER, synced: true, setterId: AURORA_USER_ID });
    await seedKilterClimb('provenance-kilter-set-here', { userId: SETTER, synced: false, setterId: null });
    // Enough of the live catalogue that one unlisting is not an anomaly.
    for (let filler = 0; filler < 8; filler += 1) {
      await seedKilterClimb(`provenance-kilter-catalogue-${filler}`, { userId: null, synced: true, setterId: 1 });
    }

    const report = await reconcileDeletions(
      db as unknown as Parameters<typeof reconcileDeletions>[0],
      ['provenance-kilter-owned', 'provenance-kilter-set-here'],
      true,
      () => {},
    );

    expect(report).toMatchObject({ directUuidSoftDeletes: 1, protectedUserAuthored: 1, refused: false });
    const listed = rowsFromResult<{ uuid: string; is_listed: boolean }>(
      await db.execute(sql`
        SELECT uuid, is_listed FROM board_climbs
         WHERE uuid IN ('provenance-kilter-owned', 'provenance-kilter-set-here') ORDER BY uuid`),
    );
    expect(listed).toEqual([
      { uuid: 'provenance-kilter-owned', is_listed: false },
      { uuid: 'provenance-kilter-set-here', is_listed: true },
    ]);
  });

  describe('a climb set in Boardsesh is unchanged', () => {
    /**
     * Woods has no manufacturer to push to, so `saveClimb` writes `synced = true`
     * on a Woods climb it mints; every other board writes `false`. Neither has a
     * manufacturer setter id.
     */
    async function seedBoardseshClimb(uuid: string, boardType: string, synced: boolean): Promise<void> {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed, user_id, synced, setter_id)
        VALUES (${uuid}, ${boardType}, ${LAYOUT_ID}, 'Set here', 'p1r5', false, true, ${SETTER}, ${synced}, NULL)
      `);
      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, fa_username, fa_at)
        VALUES (${boardType}, ${uuid}, ${ANGLE}, 0, 'stale name', '2020-01-01 00:00:00')
      `);
      await db.execute(sql`
        INSERT INTO boardsesh_ticks
          (uuid, user_id, board_type, climb_uuid, angle, status, origin, attempt_count, quality, difficulty, climbed_at)
        VALUES (${`${uuid}-tick`}, ${CLIMBER}, ${boardType}, ${uuid}, ${ANGLE}, 'send', 'native', 1, 4, 18,
                '2026-06-05 10:00:00')
      `);
    }

    it.each([
      { label: 'catalogue board', boardType: BOARD, synced: false },
      { label: 'Woods', boardType: 'woods', synced: true },
    ])('derives its first ascent from ticks and never ships it ($label)', async ({ boardType, synced }) => {
      const uuid = uniqueUuid(`set-here-${boardType}`);
      await seedBoardseshClimb(uuid, boardType, synced);

      await recomputeClimbStatsBulk(recomputeDb, [{ boardType, climbUuid: uuid, angle: ANGLE }]);

      const [stats] = rowsFromResult<{ fa_username: string | null; boardsesh_quality_count: number | null }>(
        await db.execute(sql`
          SELECT fa_username, boardsesh_quality_count FROM board_climb_stats
           WHERE board_type = ${boardType} AND climb_uuid = ${uuid} AND angle = ${ANGLE}`),
      );
      expect(stats?.fa_username).toBe(`Name of ${CLIMBER}`);
      // Owned climbs are never blended, so the blend-input columns stay NULL.
      expect(stats?.boardsesh_quality_count).toBeNull();

      const documents = await pullAllDocuments({
        resolver: 'syncClimbStats',
        scope: { boardType, layoutId: LAYOUT_ID },
        viewerId: CLIMBER,
        audience: 'REFERENCE',
      });
      expect(documents.find((document) => document.climb_uuid === uuid)?.fa_username).toBeNull();

      await db.transaction(async (tx) => {
        await withdrawDeletedAccountContent(
          tx as unknown as Parameters<typeof withdrawDeletedAccountContent>[0],
          SETTER,
        );
      });
      const [climb] = rowsFromResult<{ is_boardsesh_authored: boolean }>(
        await db.execute(sql`SELECT is_boardsesh_authored FROM board_climbs WHERE uuid = ${uuid}`),
      );
      expect(climb?.is_boardsesh_authored).toBe(true);
    });
  });
});
