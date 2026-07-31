import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { getWorkerDatabaseUrl, setupWorkerDatabase } from './worker-db';

// The migration is READ OFF DISK and executed verbatim. Retyping the SQL here
// would make every assertion a tautology — the test would prove that the SQL in
// the test does what the SQL in the test does, and the shipped file could say
// anything. Same pattern as moonboard-fa-cleanup-migration.test.ts.
const drizzleDir = fileURLToPath(new URL('../../../db/drizzle/', import.meta.url));
const MIGRATION_0188 = readFileSync(`${drizzleDir}0188_moonboard_wrong_angle_stats_cleanup.sql`, 'utf8');

type TickRow = { climb_uuid: string; angle: number; origin: string };
type StatsRow = {
  board_type: string;
  climb_uuid: string;
  angle: number;
  upstream_ascensionist_count: number | null;
  boardsesh_ascensionist_count: number | null;
  display_difficulty: number | null;
  fa_username: string | null;
  quality_normalized: boolean;
};

function rowsFromResult<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object' && result !== null && 'rows' in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

describe('MoonBoard wrong-angle cleanup migration 0188 — real DB replay (#3529)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await setupWorkerDatabase();
    client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
    db = drizzle(client);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE boardsesh_ticks, board_climb_stats, board_climbs, sync_deletions, users RESTART IDENTITY CASCADE`,
    );
  });

  async function seedUser(id: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${id}, ${`${id}@example.test`}, ${id}, now(), now())
    `);
  }

  async function seedClimb(args: {
    boardType: string;
    uuid: string;
    angle: number | null;
    ownerUserId?: string | null;
  }): Promise<void> {
    await db.execute(sql`
      INSERT INTO board_climbs
        (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, user_id, angle)
      VALUES
        (${args.uuid}, ${args.boardType}, 1, 'setter', ${args.uuid}, '', 'p1r1', true,
         ${args.ownerUserId ?? null}, ${args.angle})
    `);
  }

  async function seedStats(args: {
    boardType: string;
    uuid: string;
    angle: number;
    upstream?: number;
    boardsesh?: number;
    displayDifficulty?: number | null;
    benchmarkDifficulty?: number | null;
    upstreamQuality?: number | null;
    faUsername?: string | null;
    qualityNormalized?: boolean;
  }): Promise<void> {
    await db.execute(sql`
      INSERT INTO board_climb_stats
        (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
         boardsesh_ascensionist_count, display_difficulty, benchmark_difficulty,
         upstream_quality_average, fa_username, quality_normalized)
      VALUES
        (${args.boardType}, ${args.uuid}, ${args.angle},
         ${(args.upstream ?? 0) + (args.boardsesh ?? 0)}, ${args.upstream ?? 0}, ${args.boardsesh ?? 0},
         ${args.displayDifficulty ?? null}, ${args.benchmarkDifficulty ?? null},
         ${args.upstreamQuality ?? null}, ${args.faUsername ?? null}, ${args.qualityNormalized ?? true})
    `);
  }

  async function seedTick(args: {
    userId: string;
    boardType: string;
    uuid: string;
    angle: number;
    origin?: string;
  }): Promise<void> {
    await db.execute(sql`
      INSERT INTO boardsesh_ticks
        (uuid, user_id, board_type, climb_uuid, angle, status, origin, attempt_count, climbed_at, created_at, updated_at)
      VALUES
        (gen_random_uuid()::text, ${args.userId}, ${args.boardType}, ${args.uuid}, ${args.angle},
         'send'::tick_status, ${args.origin ?? 'native'}::tick_origin, 1,
         '2026-01-01 00:00:00', now(), now())
    `);
  }

  async function tickRows(): Promise<TickRow[]> {
    const result = await db.execute(sql`
      SELECT climb_uuid, angle, origin::text AS origin
        FROM boardsesh_ticks
       ORDER BY climb_uuid, angle
    `);
    return rowsFromResult<TickRow>(result);
  }

  async function statsRows(): Promise<StatsRow[]> {
    const result = await db.execute(sql`
      SELECT board_type, climb_uuid, angle, upstream_ascensionist_count, boardsesh_ascensionist_count,
             display_difficulty, fa_username, quality_normalized
        FROM board_climb_stats
       ORDER BY board_type, climb_uuid, angle
    `);
    return rowsFromResult<StatsRow>(result);
  }

  async function applyMigration(): Promise<void> {
    await client.unsafe(MIGRATION_0188);
  }

  const PHANTOM = 'MOON-PHANTOM';
  const REAL_AT_25 = 'MOON-REAL-AT-25';
  const OWNED = 'MOON-OWNED';
  const ANGLE_AGNOSTIC = 'MOON-NULLANGLE';
  const KILTER = 'KILTER-WRONG-ANGLE';
  const IMPORTED = 'MOON-CSV-IMPORT';

  /**
   * Every shape the migration has to tell apart, seeded together so each run
   * proves the fences hold in the presence of the rows they must NOT touch.
   */
  async function seedEveryShape(): Promise<void> {
    await seedUser('climber');
    await seedUser('climb-owner');

    // 1. The #3529 damage: catalog climb graded at 40, phantom stats row at 25
    //    minted by a stranded tick.
    await seedClimb({ boardType: 'moonboard', uuid: PHANTOM, angle: 40 });
    await seedStats({ boardType: 'moonboard', uuid: PHANTOM, angle: 40, upstream: 7, displayDifficulty: 18.2 });
    await seedStats({
      boardType: 'moonboard',
      uuid: PHANTOM,
      angle: 25,
      boardsesh: 1,
      qualityNormalized: false,
    });
    await seedTick({ userId: 'climber', boardType: 'moonboard', uuid: PHANTOM, angle: 25 });

    // 2. Fence: the legitimate multi-angle shape. The 25° row carries real
    //    catalog data, so both the tick and the row must survive untouched.
    await seedClimb({ boardType: 'moonboard', uuid: REAL_AT_25, angle: 40 });
    await seedStats({ boardType: 'moonboard', uuid: REAL_AT_25, angle: 40, upstream: 9, displayDifficulty: 20.1 });
    await seedStats({ boardType: 'moonboard', uuid: REAL_AT_25, angle: 25, upstream: 7, displayDifficulty: 16.4 });
    await seedTick({ userId: 'climber', boardType: 'moonboard', uuid: REAL_AT_25, angle: 25 });

    // 3. Fence: a USER-CREATED MoonBoard climb whose angle was edited. editClimb
    //    deliberately leaves the old angle's stats row in place, carrying
    //    fa_username = setterUsername and no difficulty — which looks exactly
    //    like a phantom row unless the migration is scoped to catalog climbs.
    await seedClimb({ boardType: 'moonboard', uuid: OWNED, angle: 40, ownerUserId: 'climb-owner' });
    await seedStats({ boardType: 'moonboard', uuid: OWNED, angle: 40, boardsesh: 1, faUsername: 'climb-owner' });
    await seedStats({ boardType: 'moonboard', uuid: OWNED, angle: 25, boardsesh: 1, faUsername: 'climb-owner' });
    await seedTick({ userId: 'climber', boardType: 'moonboard', uuid: OWNED, angle: 25 });

    // 4. Fence: the post-#3851 angle-agnostic canonical climb. With no angle on
    //    the climb row there is no "graded angle" to snap to.
    await seedClimb({ boardType: 'moonboard', uuid: ANGLE_AGNOSTIC, angle: null });
    await seedStats({ boardType: 'moonboard', uuid: ANGLE_AGNOSTIC, angle: 25, boardsesh: 1 });
    await seedTick({ userId: 'climber', boardType: 'moonboard', uuid: ANGLE_AGNOSTIC, angle: 25 });

    // 5. Fence: Kilter. Its catalog grades every angle independently, so a
    //    wrong-angle-looking row is not wrong at all.
    await seedClimb({ boardType: 'kilter', uuid: KILTER, angle: 40 });
    await seedStats({ boardType: 'kilter', uuid: KILTER, angle: 25, boardsesh: 1, qualityNormalized: false });
    await seedTick({ userId: 'climber', boardType: 'kilter', uuid: KILTER, angle: 25 });

    // 6. The CSV importer pins MoonBoard ticks to 40, so an imported tick should
    //    never match statement A. Proved rather than assumed.
    await seedClimb({ boardType: 'moonboard', uuid: IMPORTED, angle: 40 });
    await seedStats({ boardType: 'moonboard', uuid: IMPORTED, angle: 40, upstream: 3, displayDifficulty: 15.0 });
    await seedTick({
      userId: 'climber',
      boardType: 'moonboard',
      uuid: IMPORTED,
      angle: 40,
      origin: 'moonboard_import',
    });
  }

  it('moves the stranded tick to the graded angle and deletes the emptied phantom row', async () => {
    await seedEveryShape();

    await applyMigration();

    const ticks = await tickRows();
    expect(ticks.find((tick) => tick.climb_uuid === PHANTOM)?.angle).toBe(40);

    const stats = await statsRows();
    // The phantom 25° row is gone…
    expect(stats.filter((row) => row.climb_uuid === PHANTOM && row.angle === 25)).toHaveLength(0);
    // …and the graded 40° row kept its upstream data.
    const graded = stats.find((row) => row.climb_uuid === PHANTOM && row.angle === 40);
    expect(Number(graded?.upstream_ascensionist_count)).toBe(7);
    expect(Number(graded?.display_difficulty)).toBeCloseTo(18.2);
  });

  it('emits a sync_deletions tombstone so offline clients drop the phantom row too', async () => {
    await seedEveryShape();

    await applyMigration();

    const tombstones = rowsFromResult<{ record_id: string }>(
      await db.execute(sql`
        SELECT record_id FROM sync_deletions WHERE table_name = 'board_climb_stats' ORDER BY record_id
      `),
    );
    expect(tombstones.map((row) => row.record_id)).toContain(`moonboard:${PHANTOM}:25`);
  });

  it('leaves a MoonBoard angle that carries real catalog data completely alone', async () => {
    await seedEveryShape();

    await applyMigration();

    expect((await tickRows()).find((tick) => tick.climb_uuid === REAL_AT_25)?.angle).toBe(25);
    const stats = await statsRows();
    const kept = stats.find((row) => row.climb_uuid === REAL_AT_25 && row.angle === 25);
    expect(Number(kept?.upstream_ascensionist_count)).toBe(7);
  });

  it('leaves a user-created MoonBoard climb alone (editClimb leaves the old angle behind on purpose)', async () => {
    await seedEveryShape();

    await applyMigration();

    expect((await tickRows()).find((tick) => tick.climb_uuid === OWNED)?.angle).toBe(25);
    const stats = await statsRows();
    expect(stats.filter((row) => row.climb_uuid === OWNED)).toHaveLength(2);
  });

  it('leaves an angle-agnostic MoonBoard climb alone (post-#3851 shape)', async () => {
    await seedEveryShape();

    await applyMigration();

    expect((await tickRows()).find((tick) => tick.climb_uuid === ANGLE_AGNOSTIC)?.angle).toBe(25);
    const stats = await statsRows();
    expect(stats.filter((row) => row.climb_uuid === ANGLE_AGNOSTIC && row.angle === 25)).toHaveLength(1);
  });

  it('leaves Kilter untouched, including its quality_normalized flag', async () => {
    await seedEveryShape();

    await applyMigration();

    expect((await tickRows()).find((tick) => tick.climb_uuid === KILTER)?.angle).toBe(25);
    const stats = await statsRows();
    const kilterRow = stats.find((row) => row.climb_uuid === KILTER && row.angle === 25);
    expect(kilterRow).toBeDefined();
    // Statement C is MoonBoard-scoped — a Kilter row on the old 1-3 scale must
    // keep its FALSE flag or the 1-3→1-5 conversion would be skipped for it.
    expect(kilterRow?.quality_normalized).toBe(false);
  });

  it('never touches a CSV-imported MoonBoard tick (the importer already pins 40)', async () => {
    await seedEveryShape();

    await applyMigration();

    const imported = (await tickRows()).find((tick) => tick.climb_uuid === IMPORTED);
    expect(imported?.angle).toBe(40);
    expect(imported?.origin).toBe('moonboard_import');
  });

  it('marks every surviving MoonBoard row quality_normalized (statement C)', async () => {
    await seedEveryShape();
    // A MoonBoard row at a CORRECT angle stuck on the column default — the case
    // statement B cannot reach, which is why statement C exists.
    await seedStats({
      boardType: 'moonboard',
      uuid: PHANTOM,
      angle: 15,
      boardsesh: 0,
      upstream: 2,
      displayDifficulty: 12.0,
      qualityNormalized: false,
    });

    await applyMigration();

    const stats = await statsRows();
    const moonboardFlags = stats.filter((row) => row.board_type === 'moonboard').map((row) => row.quality_normalized);
    expect(moonboardFlags.every(Boolean)).toBe(true);
  });

  it('is idempotent — a second pass changes nothing', async () => {
    await seedEveryShape();

    await applyMigration();
    const ticksAfterFirst = await tickRows();
    const statsAfterFirst = await statsRows();

    await applyMigration();

    expect(await tickRows()).toEqual(ticksAfterFirst);
    expect(await statsRows()).toEqual(statsAfterFirst);
  });
});
