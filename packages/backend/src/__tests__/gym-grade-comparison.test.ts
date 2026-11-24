import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { rowsFromResult } from '@boardsesh/db/client';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  gymGradeComparisonMutations,
  gymGradeComparisonQueries,
} from '../graphql/resolvers/social/gym-grade-comparison';
import { readInventoryBoards } from '../graphql/resolvers/social/gym-inventory';
import { withGymReportingScope } from '../graphql/resolvers/social/gym-reporting';
import { assertSprayExposureBounded, sprayExposureIntervalsSql } from '../graphql/resolvers/social/gym-spray-exposure';

const OWNER = 'gym-grade-comparison-owner';
const STRANGER = 'gym-grade-comparison-stranger';
const ctx = (userId = OWNER): ConnectionContext =>
  ({ isAuthenticated: true, userId, connectionId: randomUUID() }) as ConnectionContext;
const embedded = (gymUuid: string, boardUuid?: string) => ({ input: { gymUuid, boardUuid } });

async function gym() {
  for (const user of [OWNER, STRANGER]) {
    await db.execute(sql`INSERT INTO users (id, email, name) VALUES (${user}, ${user + '@test.invalid'}, ${user})
      ON CONFLICT (id) DO NOTHING`);
  }
  const uuid = randomUUID();
  const [created] = rowsFromResult<{ id: string }>(
    await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id) VALUES (${uuid}, 'Grade test gym', ${uuid}, ${OWNER}) RETURNING id`),
  );
  return { id: Number(created.id), uuid };
}

async function board(gymId: number, { type = 'kilter', layout = 1, angle = 40, adjustable = false } = {}) {
  const uuid = randomUUID();
  const [created] = rowsFromResult<{ id: string }>(
    await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id,
      is_public, angle, is_angle_adjustable)
    VALUES (${uuid}, ${uuid}, ${OWNER}, ${type}, ${layout}, ${type === 'spray' ? layout : 8},
      '1,2', 'Grade test board', ${gymId}, true, ${angle}, ${adjustable}) RETURNING id`),
  );
  return { id: Number(created.id), uuid };
}

async function climb(type: string, layout: number, available = true) {
  const uuid = randomUUID();
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, frames, is_listed, is_draft, compatible_size_ids, required_set_ids)
    VALUES (${uuid}, ${type}, ${layout}, 'p1r1', ${available}, ${!available}, ARRAY[8], ARRAY[1])
  `);
  return uuid;
}

async function spray(
  gymId: number,
  { published = true, layout: suppliedLayout }: { published?: boolean; layout?: number } = {},
) {
  const [layoutRow] = rowsFromResult<{ layout: number }>(
    await db.execute(sql`
    SELECT nextval('spray_wall_catalog_id_seq')::int AS layout`),
  );
  const layout = suppliedLayout ?? layoutRow.layout;
  const configured = await board(gymId, { type: 'spray', layout });
  const [wall] = rowsFromResult<{ id: string }>(
    await db.execute(sql`
    INSERT INTO spray_walls (board_uuid, layout_id) VALUES (${configured.uuid}, ${layout}) RETURNING id
  `),
  );
  const [version] = rowsFromResult<{ id: string }>(
    await db.execute(sql`
    INSERT INTO spray_wall_versions (wall_id, version_number, status)
    VALUES (${wall.id}, 1, ${published ? 'published' : 'draft'}::spray_wall_version_status) RETURNING id
  `),
  );
  if (published) await db.execute(sql`UPDATE spray_walls SET current_version_id = ${version.id} WHERE id = ${wall.id}`);
  return { ...configured, layout, wall: Number(wall.id), version: Number(version.id) };
}

async function playlist(climbUuids: string[], angle = 40) {
  const uuid = randomUUID();
  const [created] = rowsFromResult<{ id: string }>(
    await db.execute(sql`
    INSERT INTO playlists (uuid, name, board_type, layout_id, is_public)
    VALUES (${uuid}, 'Private comparison list', 'kilter', 1, false) RETURNING id
  `),
  );
  await db.execute(sql`INSERT INTO playlist_ownership (playlist_id, user_id) VALUES (${created.id}, ${OWNER})`);
  for (const climbUuid of climbUuids) {
    await db.execute(
      sql`INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle) VALUES (${created.id}, ${climbUuid}, ${angle})`,
    );
  }
  return { id: created.id, uuid };
}

async function send(boardId: number, climbUuid: string, angle: number, mirror = false) {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count,
      climbed_at, board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution,
      reporting_time_precision, reporting_climbed_at, is_mirror)
    SELECT ${randomUUID()}, ${OWNER}, board_type, ${climbUuid}, ${angle}, 'send', 1,
      now() AT TIME ZONE 'UTC' - interval '1 hour', id, 'native', id, gym_id, 'uuid',
      'instant', now() AT TIME ZONE 'UTC' - interval '1 hour', ${mirror}
    FROM user_boards WHERE id = ${boardId}
  `);
}

const report = (gymUuid: string, boardUuid?: string) =>
  gymGradeComparisonQueries.gymGradeComparison(null, embedded(gymUuid, boardUuid), ctx());
const select = (gymUuid: string, boardUuid: string, playlistUuid: string | null) =>
  gymGradeComparisonMutations.setGymGradeCollection(null, { input: { gymUuid, boardUuid, playlistUuid } }, ctx());

async function history(gymUuid: string) {
  return withGymReportingScope(
    { gymUuid },
    ctx(),
    async (tx, scope) => {
      const bindings = (await readInventoryBoards(tx, scope)).flatMap((board) =>
        board.readySprayBinding ? [board.readySprayBinding] : [],
      );
      await assertSprayExposureBounded(tx, scope, bindings);
      return rowsFromResult<{ climb_uuid: string; start_at: string; end_at: string }>(
        await tx.execute(sprayExposureIntervalsSql(scope, bindings)),
      );
    },
    { maxBoards: 32, operation: 'gym-grade-test', readsPerMinute: 100 },
  );
}

async function waitForExposureFence() {
  await expect
    .poll(async () => {
      const [state] = rowsFromResult<{ waiting: boolean }>(
        await db.execute(sql`
      SELECT EXISTS (SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND database = (
          SELECT oid FROM pg_database WHERE datname = current_database()
        )) AS waiting
    `),
      );
      return state.waiting;
    })
    .toBe(true);
}

describe('gym grade comparison', () => {
  it('pairs exact current observations with only native sends on the same configured board angle and original orientation', async () => {
    const home = await gym();
    const ready = await board(home.id);
    const excluded = await board(home.id);
    const graded = await climb('kilter', 1);
    const unknown = await climb('kilter', 1);
    const unlisted = await climb('kilter', 1, false);
    const saved = await playlist([graded, unknown, unlisted]);
    const options = await gymGradeComparisonQueries.gymGradeCollectionOptions(
      null,
      { input: { gymUuid: home.uuid, boardUuid: ready.uuid, search: 'private comparison' } },
      ctx(),
    );
    expect(options.collections).toContainEqual({ uuid: saved.uuid, name: 'Private comparison list' });
    await select(home.uuid, ready.uuid, saved.uuid);
    await send(ready.id, graded, 40);
    await send(ready.id, graded, 40);
    await send(ready.id, graded, 40, true);
    await send(ready.id, graded, 45);
    await send(excluded.id, graded, 40);
    await send(ready.id, unlisted, 40);
    await db.execute(sql`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
      VALUES ('kilter', ${graded}, 40, 18.2), ('kilter', ${unknown}, 45, 20)`);
    const before = await report(home.uuid);
    expect(before).toMatchObject({
      availableCount: 2,
      sendCount: 2,
      grades: [
        { difficultyId: 18, availableCount: 1, sendCount: 2 },
        { difficultyId: null, availableCount: 1, sendCount: 0 },
      ],
    });
    expect(before.boards.find(({ boardUuid }) => boardUuid === excluded.uuid)?.included).toBe(false);
    await db.execute(
      sql`UPDATE board_climb_stats SET display_difficulty = 19 WHERE climb_uuid = ${graded} AND angle = 40`,
    );
    expect((await report(home.uuid)).grades[0]).toMatchObject({ difficultyId: 19, availableCount: 1, sendCount: 2 });
    await db.execute(
      sql`UPDATE playlist_climbs SET angle = 45 WHERE playlist_id = ${saved.id} AND climb_uuid = ${graded}`,
    );
    expect(await report(home.uuid)).toMatchObject({ availableCount: 1, sendCount: 0 });
    await select(home.uuid, ready.uuid, null);
    expect(await report(home.uuid)).toMatchObject({ availableCount: 0, sendCount: 0 });
  });

  it('deduplicates physical supply after exact configuration membership, without collapsing repeat sends', async () => {
    const home = await gym();
    const root = await board(home.id);
    const alias = await board(home.id);
    const separate = await board(home.id);
    const shared = await climb('kilter', 1);
    const collection = await playlist([shared]);
    await db.execute(sql`
      INSERT INTO gym_reporting_board_aliases (gym_id, board_id, root_board_id, verified_by)
      VALUES (${home.id}, ${alias.id}, ${root.id}, ${OWNER})
    `);
    await select(home.uuid, root.uuid, collection.uuid);
    await select(home.uuid, alias.uuid, collection.uuid);
    await select(home.uuid, separate.uuid, collection.uuid);
    await send(root.id, shared, 40);
    await send(alias.id, shared, 40);
    await send(alias.id, shared, 40);
    await send(separate.id, shared, 40);

    expect(await report(home.uuid)).toMatchObject({ availableCount: 2, sendCount: 4 });
    expect(await report(home.uuid, root.uuid)).toMatchObject({ availableCount: 1, sendCount: 3 });
    await select(home.uuid, alias.uuid, null);
    expect(await report(home.uuid, alias.uuid)).toMatchObject({ availableCount: 1, sendCount: 1 });
  });

  it('revalidates a playlist grant independently for each staff reader', async () => {
    const home = await gym();
    const configured = await board(home.id);
    const selected = await playlist([]);
    await select(home.uuid, configured.uuid, selected.uuid);
    await expect(
      gymGradeComparisonQueries.gymGradeComparison(null, embedded(home.uuid), ctx(STRANGER)),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await db.execute(sql`INSERT INTO gym_members (gym_id, user_id, role) VALUES (${home.id}, ${STRANGER}, 'editor')`);
    const other = await gymGradeComparisonQueries.gymGradeComparison(null, embedded(home.uuid), ctx(STRANGER));
    expect(other.boards).toMatchObject([{ status: 'COLLECTION_UNAVAILABLE', collectionName: null, included: false }]);
    expect((await report(home.uuid)).boards).toMatchObject([{ status: 'COLLECTION_EMPTY', included: false }]);
  });

  it('checks publication, retirement, intact holds, moderation, and deletion from authoritative spray queries', async () => {
    const home = await gym();
    const wall = await spray(home.id);
    const available = await climb('spray', wall.layout);
    const broken = await climb('spray', wall.layout);
    const retired = await climb('spray', wall.layout);
    const hidden = await climb('spray', wall.layout);
    await climb('spray', wall.layout, false);
    await db.execute(sql`UPDATE board_climbs SET missing_hold_count = 1 WHERE uuid = ${broken}`);
    await db.execute(sql`UPDATE board_climbs SET retired_by_reset = true WHERE uuid = ${retired}`);
    await db.execute(sql`UPDATE board_climbs SET is_hidden = true WHERE uuid = ${hidden}`);
    expect(await report(home.uuid)).toMatchObject({ availableCount: 1, sendCount: 0 });
    expect((await history(home.uuid)).every((range) => range.climb_uuid === available)).toBe(true);
    await db.execute(sql`UPDATE spray_walls SET archived_at = now() WHERE id = ${wall.wall}`);
    expect(await report(home.uuid)).toMatchObject({ availableCount: 0, sendCount: 0 });
    expect(await history(home.uuid)).toEqual([]);
  });

  it('retains a single uninterrupted spray exposure interval once its checkpoint advances', async () => {
    const home = await gym();
    const wall = await spray(home.id);
    const available = await climb('spray', wall.layout);
    expect(await report(home.uuid)).toMatchObject({ availableCount: 1 });
    // Age the one committed opening and checkpoint inside this disposable fixture to pass the observer's throttle.
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE spray_exposure_observations SET observed_at = observed_at - interval '3 days'
        WHERE board_id = ${wall.id} AND climb_uuid = ${available}
      `);
      await tx.execute(sql`
        UPDATE spray_exposure_checkpoints SET observed_at = observed_at - interval '3 days' WHERE board_id = ${wall.id}
      `);
    });
    expect(await report(home.uuid)).toMatchObject({ availableCount: 1 });
    const ranges = await history(home.uuid);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].climb_uuid).toBe(available);
    expect(Date.parse(ranges[0].end_at) - Date.parse(ranges[0].start_at)).toBeGreaterThanOrEqual(3 * 86_400_000);
  });

  it('interrupts exposure on exact version status or owner changes while ignoring an unreferenced draft', async () => {
    const home = await gym();
    const wall = await spray(home.id);
    const spare = await spray(home.id, { published: false });
    const available = await climb('spray', wall.layout);
    await report(home.uuid);
    await db.execute(sql`INSERT INTO spray_wall_versions (wall_id, version_number) VALUES (${wall.wall}, 2)`);
    await db.execute(
      sql`UPDATE spray_wall_versions SET status = 'superseded' WHERE wall_id = ${wall.wall} AND version_number = 2`,
    );
    await db.execute(sql`UPDATE spray_wall_versions SET status = 'superseded' WHERE id = ${wall.version}`);
    expect(await report(home.uuid)).toMatchObject({ availableCount: 0 });
    await db.execute(sql`UPDATE spray_wall_versions SET status = 'published' WHERE id = ${wall.version}`);
    expect(await report(home.uuid)).toMatchObject({ availableCount: 1 });
    const [prior] = (await history(home.uuid)).filter((range) => range.climb_uuid === available);
    expect(prior).toBeDefined();
    await db.execute(
      sql`UPDATE spray_wall_versions SET wall_id = ${spare.wall}, version_number = 2 WHERE id = ${wall.version}`,
    );
    expect(await report(home.uuid)).toMatchObject({ availableCount: 0 });
    await db.execute(
      sql`UPDATE spray_wall_versions SET wall_id = ${wall.wall}, version_number = 1 WHERE id = ${wall.version}`,
    );
    expect(await report(home.uuid)).toMatchObject({ availableCount: 1 });
    const known = (await history(home.uuid)).filter((range) => range.climb_uuid === available);
    expect(known).toHaveLength(2);
    expect(String(known[0].end_at) < String(known[1].start_at)).toBe(true);
    await db.execute(sql`DELETE FROM spray_wall_versions WHERE id = ${wall.version}`);
    expect(await report(home.uuid)).toMatchObject({ availableCount: 0 });
  });

  it('does not open an exposure while an uncommitted multi-layer write swaps eligibility', async () => {
    const home = await gym();
    const wall = await spray(home.id, { published: false });
    const available = await climb('spray', wall.layout);
    let unlock!: () => void;
    let locked!: () => void;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const layoutFence = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(public.spray_exposure_fence_key('layout', ${String(wall.layout)}))`,
      );
      locked();
      await release;
    });
    let writer: Promise<unknown> | undefined;
    try {
      await acquired;
      writer = db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE spray_wall_versions SET status = 'published' WHERE id = ${wall.version}`);
        await tx.execute(sql`UPDATE spray_walls SET current_version_id = ${wall.version} WHERE id = ${wall.wall}`);
        // The row passes its source DML before the callback can acquire the
        // layout fence and record the invalidation. No all-layer state is visible.
        await tx.execute(sql`UPDATE board_climbs SET is_hidden = true WHERE uuid = ${available}`);
      });
      await waitForExposureFence();
      expect(await report(home.uuid)).toMatchObject({ availableCount: 0 });
    } finally {
      unlock();
      await layoutFence;
      await writer;
    }
    expect(await report(home.uuid)).toMatchObject({ availableCount: 0 });
    const recorded = rowsFromResult(
      await db.execute(sql`
      SELECT 1 FROM spray_exposure_observations WHERE wall_id = ${wall.wall} AND climb_uuid = ${available}
    `),
    );
    expect(recorded).toEqual([]);
  });

  it('does not extend a checkpoint while a closing writer holds the version fence, even if it rolls back', async () => {
    const home = await gym();
    const wall = await spray(home.id);
    const available = await climb('spray', wall.layout);
    await report(home.uuid);
    const checkpoint = async () =>
      rowsFromResult<{ seen: string }>(
        await db.execute(sql`
      SELECT observed_at::text AS seen FROM spray_exposure_checkpoints WHERE wall_id = ${wall.wall}
    `),
      )[0]?.seen;
    const prior = await checkpoint();
    expect(prior).toBeDefined();
    let release!: () => void;
    let changed!: () => void;
    const continueWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const afterWrite = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const rollback = new Error('intentional exposure fixture rollback');
    const writer = db
      .transaction(async (tx) => {
        await tx.execute(sql`UPDATE spray_wall_versions SET status = 'superseded' WHERE id = ${wall.version}`);
        changed();
        await continueWrite;
        throw rollback;
      })
      .catch((error) => {
        expect(error).toBe(rollback);
      });
    try {
      await afterWrite;
      expect(await report(home.uuid)).toMatchObject({ availableCount: 1 });
      expect(await checkpoint()).toBe(prior);
      expect(await history(home.uuid)).toEqual([]);
    } finally {
      release();
      await writer;
    }
    expect(await report(home.uuid)).toMatchObject({ availableCount: 1 });
    const reopened = rowsFromResult(
      await db.execute(sql`
      SELECT 1 FROM spray_exposure_observations WHERE wall_id = ${wall.wall} AND climb_uuid = ${available}
    `),
    );
    expect(reopened).toHaveLength(1);
  });

  it('keeps a source mutation uncommitted until an exclusive observer fence finishes', async () => {
    const home = await gym();
    const wall = await spray(home.id);
    await climb('spray', wall.layout);
    await report(home.uuid);
    let unlock!: () => void;
    let locked!: () => void;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const observer = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(public.spray_exposure_fence_key('version', ${String(wall.version)}))`,
      );
      locked();
      await release;
    });
    let writerCommitted = false;
    let writer: Promise<unknown> | undefined;
    try {
      await acquired;
      writer = db
        .execute(sql`UPDATE spray_wall_versions SET status = 'superseded' WHERE id = ${wall.version}`)
        .then(() => {
          writerCommitted = true;
        });
      await waitForExposureFence();
      expect(writerCommitted).toBe(false);
      expect(await report(home.uuid)).toMatchObject({ availableCount: 1 });
    } finally {
      unlock();
      await observer;
      await writer;
    }
    expect(writerCommitted).toBe(true);
    expect(await report(home.uuid)).toMatchObject({ availableCount: 0 });
  });

  it('bounds raw spray layout rows even when nearly every climb is unavailable', async () => {
    const home = await gym();
    const wall = await spray(home.id);
    const available = await climb('spray', wall.layout);
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, frames, is_listed, is_draft)
      SELECT ${wall.uuid} || ':draft:' || draft_number::text, 'spray', ${wall.layout}, '', false, true
      FROM generate_series(1, 4095) draft_number
    `);
    expect(await report(home.uuid)).toMatchObject({ availableCount: 1, sendCount: 0 });
    const observations = async () =>
      rowsFromResult(
        await db.execute(sql`
      SELECT seq FROM spray_exposure_observations WHERE wall_id = ${wall.wall} AND climb_uuid = ${available}
    `),
      );
    const before = await observations();
    await climb('spray', wall.layout, false);
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE board_climbs SET is_hidden = true WHERE uuid = ${available}`);
      await tx.execute(sql`UPDATE board_climbs SET is_hidden = false WHERE uuid = ${available}`);
    });
    await expect(report(home.uuid)).rejects.toMatchObject({ extensions: { code: 'SCOPE_TOO_LARGE' } });
    expect(await observations()).toEqual(before);
  });

  it('fails above the raw membership limit without affecting regular playlist use', async () => {
    const home = await gym();
    const configured = await board(home.id);
    const selection = await playlist([]);
    await select(home.uuid, configured.uuid, selection.uuid);
    await db.execute(sql`INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle)
      SELECT ${selection.id}, 'inventory-limit-' || member::text, 40 FROM generate_series(1, 4097) member`);
    await expect(report(home.uuid)).rejects.toMatchObject({ extensions: { code: 'SCOPE_TOO_LARGE' } });
  });
});
