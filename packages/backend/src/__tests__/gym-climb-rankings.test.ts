import { randomInt, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { rowsFromResult } from '@boardsesh/db/client';
import type { ConnectionContext, GymClimbRankingMode } from '@boardsesh/shared-schema';
import { applyAuroraAscents, applyAuroraBids } from '@boardsesh/aurora-sync/apply-user-logbook';
import { applyClimbRatings, applyLogs } from '@boardsesh/kilter-sync';
import { db } from '../db/client';
import {
  gymClimbRankingQueries,
  prepareRankingRowsStatement,
  rankingCommentCandidatesSql,
  rankingTickCandidatesSql,
  readRanking,
} from '../graphql/resolvers/social/gym-climb-rankings';
import { withGymReportingScope } from '../graphql/resolvers/social/gym-reporting';
import {
  assertInventoryWorkBounded,
  GYM_INVENTORY_MAX_BOARDS,
  readInventoryBoards,
} from '../graphql/resolvers/social/gym-inventory';
import { gymReportingSettingsMutations } from '../graphql/resolvers/social/gym-reporting-settings';
import { socialCommentMutations } from '../graphql/resolvers/social/comments';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { deleteClimbMutations } from '../graphql/resolvers/climbs/delete-climb';

const ctx = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: randomUUID() }) as ConnectionContext;

async function user() {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO users (id, email, name) VALUES (${id}, ${id + '@test.invalid'}, 'Ranking climber')`);
  return id;
}

async function addBoard(gymId: number, owner: string, kind = 'kilter', angle = 40) {
  const uuid = randomUUID();
  const [board] = rowsFromResult<{ id: string }>(
    await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name,
      gym_id, is_public, angle, is_angle_adjustable)
    VALUES (${uuid}, ${uuid}, ${owner}, ${kind}, 1, 8, '1,2', ${'Wall ' + uuid}, ${gymId}, true, ${angle}, false)
    RETURNING id
  `),
  );
  return { uuid, id: Number(board.id) };
}

async function addClimb(kind = 'kilter', name = 'The Rankable Line') {
  const uuid = randomUUID();
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, frames, is_listed, is_draft, is_hidden,
      compatible_size_ids, required_set_ids, name)
    VALUES (${uuid}, ${kind}, 1, 'p1r12', true, false, false, ARRAY[8], ARRAY[1], ${name})
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty) VALUES (${kind}, ${uuid}, 40, 18)
  `);
  return uuid;
}

async function site(kind = 'kilter') {
  const owner = await user();
  const gymUuid = randomUUID();
  const [gym] = rowsFromResult<{ id: string }>(
    await db.execute(sql`
    INSERT INTO gyms (uuid, slug, name, owner_id, reporting_time_zone)
    VALUES (${gymUuid}, ${gymUuid}, 'Rankings Gym', ${owner}, 'UTC') RETURNING id
  `),
  );
  const gymId = Number(gym.id);
  const board = await addBoard(gymId, owner, kind);
  const climbUuid = await addClimb(kind);
  return { owner, gymUuid, gymId, board, climbUuid, kind };
}

type Site = Awaited<ReturnType<typeof site>>;
const stamp = (daysAgo = 2) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

async function save(
  fixture: Site,
  climber: string,
  patch: {
    quality?: number | null;
    difficulty?: number | null;
    climbedAt?: string;
    status?: 'send' | 'attempt';
    isMirror?: boolean;
    boardUuid?: string;
    uuid?: string;
    sessionId?: string;
    reportingTime?: { precision: 'day'; date: string; timeZone: string };
  } = {},
) {
  const uuid = patch.uuid ?? randomUUID();
  await tickMutations.saveTick(
    null,
    {
      input: {
        uuid,
        boardType: fixture.kind,
        climbUuid: fixture.climbUuid,
        angle: 40,
        isMirror: false,
        status: 'send',
        attemptCount: 2,
        isBenchmark: false,
        comment: '',
        layoutId: 1,
        sizeId: 8,
        setIds: '1,2',
        climbedAt: stamp(),
        reportingTime: { precision: 'instant' },
        boardUuid: fixture.board.uuid,
        ...patch,
      },
    },
    ctx(climber),
  );
  return uuid;
}

const query = (fixture: Site, mode: GymClimbRankingMode, boardUuid?: string | null, cursor?: string) =>
  gymClimbRankingQueries.gymClimbRankings(
    null,
    { input: { gymUuid: fixture.gymUuid, mode, boardUuid, cursor } },
    ctx(fixture.owner),
  );

async function edit(uuid: string, climber: string, input: unknown) {
  return tickMutations.updateTick(null, { uuid, input }, ctx(climber));
}

const comment = (climber: string, tickUuid: string, parentCommentUuid?: string) =>
  socialCommentMutations.addComment(
    null,
    {
      input: {
        entityType: 'tick',
        entityId: tickUuid,
        body: 'A better way through the crux',
        parentCommentUuid,
      },
    },
    ctx(climber),
  );

async function evidence(uuid: string) {
  return rowsFromResult<{ metric: string; attested_value: number }>(
    await db.execute(sql`
    SELECT votes.metric, votes.attested_value FROM gym_reporting_tick_votes votes
    JOIN boardsesh_ticks tick ON tick.id = votes.tick_id WHERE tick.uuid = ${uuid} ORDER BY votes.metric
  `),
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function blockWrite<Result>(
  table: 'comments' | 'boardsesh_ticks' | 'board_climbs',
  action: 'DELETE' | 'UPDATE',
  uuid: string,
  start: () => Promise<Result>,
  whileBlocked: () => Promise<void>,
) {
  const namespace = 7970;
  const key = randomInt(1000, 2_000_000_000);
  if (!/^[a-f0-9-]{36}$/.test(uuid)) throw new Error('Expected a fixture UUID');
  await db.execute(
    sql.raw(`
    CREATE FUNCTION public.rankings_test_hold_write() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
    AS $$ BEGIN
      PERFORM pg_catalog.pg_advisory_xact_lock(${namespace}, ${key});
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$
  `),
  );
  await db.execute(
    sql.raw(`
    CREATE TRIGGER rankings_test_hold_write BEFORE ${action} ON public.${table}
      FOR EACH ROW WHEN (OLD.uuid = '${uuid}') EXECUTE FUNCTION public.rankings_test_hold_write()
  `),
  );
  const acquired = deferred();
  const release = deferred();
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${namespace}::int, ${key}::int)`);
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  const operation = start();
  void operation.catch(() => {});
  try {
    await expect
      .poll(async () => {
        const [status] = rowsFromResult<{ blocked: boolean }>(
          await db.execute(sql`
        SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = ${namespace}::oid AND objid = ${key}::oid AND objsubid = 2) AS blocked
      `),
        );
        return status.blocked;
      })
      .toBe(true);
    await whileBlocked();
  } finally {
    release.resolve();
    await Promise.allSettled([holder, operation]);
    await db.execute(sql`DROP FUNCTION public.rankings_test_hold_write() CASCADE`);
  }
  return operation;
}

describe('local climb ranking reports', () => {
  it('counts repeat ticks, keeps mirrored variants and distinct physical installations separate, and verifies a target', async () => {
    const fixture = await site('tension');
    const second = await addBoard(fixture.gymId, fixture.owner, 'tension');
    await save(fixture, fixture.owner);
    await save(fixture, fixture.owner);
    await save(fixture, fixture.owner, { isMirror: true });
    await save(fixture, fixture.owner, { boardUuid: second.uuid });
    const result = await query(fixture, 'MOST_SENT');
    expect(result.status).toBe('READY');
    expect(result.quietAvailable).toBe(false);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      senderCount: 1,
      sendCount: 2,
      target: { logicalBoardUuid: fixture.board.uuid, angle: 40, isMirror: false },
    });
    expect(result.rows.filter(({ target }) => target.isMirror)).toHaveLength(1);
    const input = {
      gymUuid: fixture.gymUuid,
      logicalBoardUuid: fixture.board.uuid,
      climbUuid: fixture.climbUuid,
      angle: 40,
      isMirror: true,
    };
    const detail = () => gymClimbRankingQueries.gymClimbRankingTarget(null, { input }, ctx(fixture.owner));
    expect(await detail()).toMatchObject({ boardType: 'tension', isMirror: true, sizeId: 8 });
    await db.execute(sql`UPDATE board_climbs SET is_listed = false WHERE uuid = ${fixture.climbUuid}`);
    await expect(detail()).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect((await query(fixture, 'MOST_SENT')).rows).toEqual([]);
  });

  it('groups verified configurations and type-scoped aliases without counting incompatible variants', async () => {
    const fixture = await site();
    const second = await addBoard(fixture.gymId, fixture.owner);
    const wrongSets = await addBoard(fixture.gymId, fixture.owner);
    const wrongAngle = await addBoard(fixture.gymId, fixture.owner, 'kilter', 45);
    await db.execute(sql`UPDATE user_boards SET set_ids = '2' WHERE id = ${wrongSets.id}`);
    const alias = randomUUID();
    await db.execute(sql`
      INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
      VALUES ('kilter', ${alias}, ${fixture.climbUuid}, 'ranking fixture')
    `);
    await gymReportingSettingsMutations.setGymReportingBoardAlias(
      null,
      {
        input: {
          gymUuid: fixture.gymUuid,
          boardUuid: second.uuid,
          rootBoardUuid: fixture.board.uuid,
        },
      },
      ctx(fixture.owner),
    );
    for (const [board, climbUuid] of [
      [fixture.board, fixture.climbUuid],
      [second, alias],
      [wrongSets, alias],
      [wrongAngle, alias],
    ] as const) {
      await db.execute(sql`
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, climbed_at,
          board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution, reporting_time_precision, reporting_climbed_at)
        SELECT ${randomUUID()}, ${fixture.owner}, 'kilter', ${climbUuid}, 40, false, 'send', stamp,
          ${board.id}, 'native', ${board.id}, ${fixture.gymId}, 'uuid', 'instant', stamp
        FROM (SELECT now() AT TIME ZONE 'UTC' AS stamp) clock
      `);
    }
    const result = await query(fixture, 'MOST_SENT');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sendCount: 2,
      senderCount: 1,
      physicalBoardUuid: fixture.board.uuid,
      target: { climbUuid: fixture.climbUuid, angle: 40 },
    });
  });

  it('compares MoonBoard ordinal grades and retains half-step and neutral feedback', async () => {
    const fixture = await site('moonboard');
    const users = await Promise.all(Array.from({ length: 6 }, () => user()));
    const grades = [13, 13, 13, 16, 16, 16];
    for (const [index, climber] of users.entries()) {
      await db.execute(sql`
        WITH saved AS (
          INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, climbed_at,
            board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution,
            reporting_time_precision, reporting_climbed_at, difficulty)
          SELECT ${randomUUID()}, ${climber}, 'moonboard', ${fixture.climbUuid}, 40, false, 'send', stamp,
            ${fixture.board.id}, 'native', ${fixture.board.id}, ${fixture.gymId}, 'uuid', 'instant', stamp, ${grades[index]}
          FROM (SELECT now() AT TIME ZONE 'UTC' AS stamp) clock RETURNING id, difficulty
        )
        INSERT INTO gym_reporting_tick_votes (tick_id, metric, attested_value)
        SELECT id, 'DIFFICULTY', difficulty FROM saved
      `);
    }
    await db.execute(sql`UPDATE board_climb_stats SET display_difficulty = 13 WHERE climb_uuid = ${fixture.climbUuid}`);
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows[0]).toMatchObject({ gradeDelta: 0.5, voterCount: 6 });
    await db.execute(sql`UPDATE boardsesh_ticks SET difficulty = 13 WHERE climb_uuid = ${fixture.climbUuid}`);
    await db.execute(sql`
      INSERT INTO gym_reporting_tick_votes (tick_id, metric, attested_value)
      SELECT id, 'DIFFICULTY', difficulty FROM boardsesh_ticks WHERE climb_uuid = ${fixture.climbUuid}
      ON CONFLICT DO NOTHING
    `);
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows[0]).toMatchObject({ gradeDelta: 0, voterCount: 6 });
  });

  it('uses latest certified stars and grades per climber, with five independent votes', async () => {
    const fixture = await site();
    const climbers = await Promise.all(Array.from({ length: 5 }, () => user()));
    await save(fixture, climbers[0], { quality: 1, difficulty: 20, climbedAt: stamp(5) });
    for (const climber of climbers.slice(0, 4)) {
      await save(fixture, climber, { quality: 4, difficulty: 20, status: 'attempt' });
    }
    expect((await query(fixture, 'TOP_RATED')).rows).toEqual([]);
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows).toEqual([]);
    await save(fixture, climbers[4], { quality: 5, difficulty: 21 });
    expect((await query(fixture, 'TOP_RATED')).rows[0]).toMatchObject({ voterCount: 5, qualityMean: 4.2 });
    await db.execute(
      sql`UPDATE board_climb_stats SET display_difficulty = 18 WHERE climb_uuid = ${fixture.climbUuid} AND angle = 40`,
    );
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows[0]).toMatchObject({ voterCount: 5, gradeDelta: 2 });
  });

  it('requires actual native field evidence through Aurora overwrite, legacy echo, same-value confirmation and value ABA', async () => {
    const fixture = await site();
    const climbers = await Promise.all(Array.from({ length: 5 }, () => user()));
    const climbedAt = stamp();
    const saved: string[] = [];
    const sessionId = randomUUID();
    await db.execute(sql`
      INSERT INTO board_sessions (id, board_path, name, created_by_user_id, board_id, created_at, last_activity)
      VALUES (${sessionId}, 'kilter/1/8/1,2/40', 'Vote proof session', ${fixture.owner}, ${fixture.board.id}, now(), now())
    `);
    for (const climber of climbers) {
      saved.push(await save(fixture, climber, { quality: 5, difficulty: 20, climbedAt, sessionId }));
    }
    expect((await query(fixture, 'TOP_RATED')).rows[0].qualityMean).toBe(5);
    for (const [index, climber] of climbers.entries()) {
      const auroraId = randomUUID();
      // The outgoing provider link leaves a native row eligible for an upstream refresh.
      await db.execute(sql`UPDATE boardsesh_ticks SET aurora_id = ${auroraId}, aurora_type = 'ascents',
        aurora_synced_at = clock_timestamp() AT TIME ZONE 'UTC' WHERE uuid = ${saved[index]}`);
      const sync = (quality: number, difficulty: number) =>
        db.transaction((tx) =>
          applyAuroraAscents(
            tx,
            'kilter',
            climber,
            [
              {
                uuid: auroraId,
                climb_uuid: fixture.climbUuid,
                angle: 40,
                attempt_id: 2,
                bid_count: 2,
                quality,
                difficulty,
                climbed_at: climbedAt,
                created_at: climbedAt,
              },
            ],
            async () => {},
          ),
        );
      await sync(3, 20);
      expect(await evidence(saved[index])).toEqual([
        { metric: 'DIFFICULTY', attested_value: 20 },
        { metric: 'QUALITY', attested_value: 5 },
      ]);
      await sync(2, 21);
      const [updated] = rowsFromResult<{ quality: number; difficulty: number; same_time: boolean }>(
        await db.execute(sql`
        SELECT quality, difficulty, climbed_at = reporting_climbed_at AS same_time FROM boardsesh_ticks WHERE uuid = ${saved[index]}
      `),
      );
      expect(updated).toMatchObject({ quality: 3, difficulty: 21, same_time: true });
      await sync(3, 20);
      expect(await evidence(saved[index])).toEqual([]);
    }
    expect((await query(fixture, 'TOP_RATED')).rows).toEqual([]);
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows).toEqual([]);
    for (const [index, climber] of climbers.entries()) {
      const uuid = saved[index];
      await edit(uuid, climber, { comment: 'Legacy note', quality: 5, difficulty: 20 });
      expect(await evidence(uuid)).toEqual([]);
      const readReceipts = async () =>
        rowsFromResult<{ updated_at: string; ticks: number; sessions: number }>(
          await db.execute(sql`
        SELECT tick.updated_at::text,
          (SELECT count(*)::int FROM logbook_changes change WHERE change.tick_uuid = tick.uuid) AS ticks,
          (SELECT count(*)::int FROM logbook_session_changes change JOIN board_sessions session
            ON session.export_id = change.session_export_id WHERE session.id = tick.session_id AND change.user_id = tick.user_id) AS sessions
        FROM boardsesh_ticks tick WHERE tick.uuid = ${uuid}
      `),
        );
      const [before] = await readReceipts();
      expect(before.ticks).toBeGreaterThan(0);
      expect(before.sessions).toBeGreaterThan(0);
      await edit(uuid, climber, { quality: 5, reportingVoteFields: ['QUALITY'] });
      const [after] = await readReceipts();
      expect(after).toEqual(before);
      expect(await evidence(uuid)).toEqual([{ metric: 'QUALITY', attested_value: 5 }]);
    }
    expect((await query(fixture, 'TOP_RATED')).rows[0]).toMatchObject({ voterCount: 5, qualityMean: 5 });
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows).toEqual([]);
    await edit(saved[0], climbers[0], { quality: null, reportingVoteFields: ['QUALITY'] });
    expect((await query(fixture, 'TOP_RATED')).rows).toEqual([]);
  });

  it('keeps a copied Kilter grade unproved after link clearing and allows a deliberate native confirmation', async () => {
    const fixture = await site();
    const climbers = await Promise.all(Array.from({ length: 5 }, () => user()));
    const stampAt = stamp();
    const providerIds = climbers.map(() => randomUUID());
    const applyLog = (climber: string, providerId: string, operation: 'PUT' | 'REMOVE') =>
      db.transaction((tx) =>
        applyLogs(
          tx,
          climber,
          [
            {
              op_id: '1',
              op: operation,
              object_type: 'logs',
              object_id: providerId,
              ...(operation === 'PUT'
                ? {
                    data: {
                      id: '1',
                      log_uuid: providerId,
                      climb_uuid: fixture.climbUuid,
                      user_uuid: climber,
                      gym_uuid: null,
                      wall_uuid: null,
                      product_layout_uuid: null,
                      angle: 40,
                      flashed: 0,
                      topped: 1,
                      attempts: 2,
                      created_at: stampAt,
                    },
                  }
                : {}),
            },
          ],
          new Map([[fixture.climbUuid, fixture.climbUuid]]),
          () => {},
          async () => {},
        ),
      );
    const saved: string[] = [];
    for (const [index, climber] of climbers.entries()) {
      const uuid = await save(fixture, climber, { quality: 4, climbedAt: stampAt });
      saved.push(uuid);
      await applyLog(climber, providerIds[index], 'PUT');
      await db.transaction(async (tx) => {
        const ratingId = randomUUID();
        await applyClimbRatings(
          tx,
          climber,
          [
            {
              op_id: '1',
              op: 'PUT',
              object_type: 'climb_ratings',
              object_id: ratingId,
              data: {
                id: ratingId,
                climb_rating_uuid: ratingId,
                user_uuid: climber,
                gym_uuid: null,
                wall_uuid: null,
                product_layout_uuid: null,
                climb_uuid: fixture.climbUuid,
                angle: 40,
                rating: 4,
                difficulty_grade_id: 22,
                comment: null,
                created_at: stampAt,
              },
            },
          ],
          new Map([[fixture.climbUuid, fixture.climbUuid]]),
          () => {},
          new Map(),
          async () => {},
        );
        if (index !== 0) {
          await tx.execute(sql`UPDATE boardsesh_ticks SET kilter_id = NULL WHERE uuid = ${uuid}`);
        }
      });
      const [stored] = rowsFromResult<{ difficulty: number }>(
        await db.execute(sql`
        SELECT difficulty FROM boardsesh_ticks WHERE uuid = ${uuid}
      `),
      );
      expect(stored.difficulty).toBe(22);
      expect(await evidence(uuid)).toEqual([{ metric: 'QUALITY', attested_value: 4 }]);
    }
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows).toEqual([]);
    for (const [index, climber] of climbers.entries()) {
      await edit(saved[index], climber, { difficulty: 22, reportingVoteFields: ['DIFFICULTY'] });
    }
    await db.execute(
      sql`UPDATE board_climb_stats SET display_difficulty = 18 WHERE climb_uuid = ${fixture.climbUuid} AND angle = 40`,
    );
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows[0]).toMatchObject({ voterCount: 5, gradeDelta: 4 });
    await applyLog(climbers[0], providerIds[0], 'REMOVE');
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows).toEqual([]);
    await applyLog(climbers[0], providerIds[0], 'PUT');
    expect((await query(fixture, 'GRADE_FEEDBACK')).rows[0].voterCount).toBe(5);
  });

  it('does not certify bids, imported rows or duplicate native saves, and cannot revive old microsecond evidence', async () => {
    const fixture = await site();
    const climber = await user();
    const climbedAt = stamp().replace(/\.\d+Z$/, '.123456Z');
    const uuid = await save(fixture, climber, { status: 'attempt', quality: 4, difficulty: 20, climbedAt });
    expect(await evidence(uuid)).toEqual([
      { metric: 'DIFFICULTY', attested_value: 20 },
      { metric: 'QUALITY', attested_value: 4 },
    ]);
    const auroraId = randomUUID();
    await db.execute(sql`
      UPDATE boardsesh_ticks SET aurora_id = ${auroraId}, aurora_type = 'bids',
        aurora_synced_at = clock_timestamp() AT TIME ZONE 'UTC' WHERE uuid = ${uuid}
    `);
    await db.transaction((tx) =>
      applyAuroraBids(
        tx,
        'kilter',
        climber,
        [
          {
            uuid: auroraId,
            climb_uuid: fixture.climbUuid,
            angle: 40,
            bid_count: 2,
            climbed_at: climbedAt,
            created_at: climbedAt,
          },
        ],
        async () => {},
      ),
    );
    const [afterBid] = rowsFromResult(
      await db.execute(sql`
      SELECT origin, board_id = reporting_board_id AS same_board, reporting_time_precision,
        climbed_at = date_trunc('milliseconds', reporting_climbed_at) AS milliseconds_only,
        climbed_at = reporting_climbed_at AS same_occurrence
      FROM boardsesh_ticks WHERE uuid = ${uuid}
    `),
    );
    expect(afterBid).toMatchObject({
      origin: 'native',
      same_board: true,
      reporting_time_precision: 'instant',
      milliseconds_only: true,
      same_occurrence: false,
    });
    expect(await evidence(uuid)).toEqual([]);
    await save(fixture, climber, { uuid, status: 'attempt', quality: 4, difficulty: 20, climbedAt });
    expect(await evidence(uuid)).toEqual([]);

    const imported = randomUUID();
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status,
        climbed_at, board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution,
        reporting_time_precision, reporting_climbed_at, aurora_id, aurora_type)
      SELECT ${imported}, user_id, board_type, climb_uuid, angle, is_mirror, status,
        climbed_at, board_id, 'aurora_pull', reporting_board_id, reporting_gym_id, reporting_attribution,
        reporting_time_precision, reporting_climbed_at, ${randomUUID()}, 'bids'
      FROM boardsesh_ticks WHERE uuid = ${uuid}
    `);
    await edit(imported, climber, { quality: 3, reportingVoteFields: ['QUALITY'] });
    expect(await evidence(imported)).toEqual([]);
    expect(await evidence(uuid)).toEqual([]);

    await edit(uuid, climber, { quality: 3, difficulty: 21, reportingVoteFields: ['QUALITY', 'DIFFICULTY'] });
    expect(await evidence(uuid)).toEqual([]);
    await edit(uuid, climber, {
      climbedAt,
      reportingTime: { precision: 'instant' },
      quality: 3,
      difficulty: 21,
      reportingVoteFields: ['QUALITY', 'DIFFICULTY'],
    });
    expect(await evidence(uuid)).toEqual([
      { metric: 'DIFFICULTY', attested_value: 21 },
      { metric: 'QUALITY', attested_value: 3 },
    ]);
    await db.execute(
      sql`UPDATE boardsesh_ticks SET climbed_at = climbed_at + interval '1 microsecond' WHERE uuid = ${uuid}`,
    );
    await db.execute(sql`UPDATE boardsesh_ticks SET climbed_at = reporting_climbed_at WHERE uuid = ${uuid}`);
    expect(await evidence(uuid)).toEqual([]);
    await edit(uuid, climber, { difficulty: 21, reportingVoteFields: ['DIFFICULTY'] });
    expect(await evidence(uuid)).toEqual([{ metric: 'DIFFICULTY', attested_value: 21 }]);
  });

  it('updates both actual Aurora pull twins without certifying either or changing the unrelated native proof', async () => {
    const fixture = await site();
    const climber = await user();
    const providerIds = [randomUUID(), randomUUID()];
    const climbedAt = stamp(3).replace(/\.\d+Z$/, '.876543Z');
    await db.transaction((tx) =>
      applyAuroraAscents(
        tx,
        'kilter',
        climber,
        providerIds.map((uuid) => ({
          uuid,
          climb_uuid: fixture.climbUuid,
          angle: 40,
          attempt_id: 2,
          bid_count: 2,
          quality: 2,
          difficulty: 20,
          climbed_at: climbedAt,
          created_at: climbedAt,
        })),
        async () => {},
      ),
    );
    // Give both imports valid-looking board and occurrence fields so the origin gate is exercised.
    await db.execute(sql`
      UPDATE boardsesh_ticks SET board_id = ${fixture.board.id}, reporting_board_id = ${fixture.board.id},
        reporting_gym_id = ${fixture.gymId}, reporting_attribution = 'uuid', reporting_time_precision = 'instant',
        reporting_climbed_at = climbed_at
      WHERE aurora_id IN (${providerIds[0]}, ${providerIds[1]})
    `);
    const readTwins = () =>
      db.execute<{ uuid: string; origin: string; quality: number }>(sql`
      SELECT uuid, origin, quality FROM boardsesh_ticks
      WHERE aurora_id IN (${providerIds[0]}, ${providerIds[1]}) ORDER BY aurora_id COLLATE "C"
    `);
    const before = await readTwins();
    expect(before).toHaveLength(2);
    expect(before.map(({ origin, quality }) => ({ origin, quality }))).toEqual([
      { origin: 'aurora_pull', quality: 3 },
      { origin: 'aurora_pull', quality: 3 },
    ]);
    const native = await save(fixture, climber, { quality: 4, climbedAt: stamp(1) });
    // The lower Aurora ID is the visible directional witness. Confirm this update actually broadcasts to its twin.
    await edit(before[0].uuid, climber, { quality: 5, reportingVoteFields: ['QUALITY'] });
    expect((await readTwins()).map(({ quality }) => quality)).toEqual([5, 5]);
    expect(await evidence(before[0].uuid)).toEqual([]);
    expect(await evidence(before[1].uuid)).toEqual([]);
    expect(await evidence(native)).toEqual([{ metric: 'QUALITY', attested_value: 4 }]);
  });

  it('uses real tick comments and replies, preserves global threads, and cannot move attribution with its tick', async () => {
    const fixture = await site();
    const other = await user();
    const uuid = await save(fixture, fixture.owner);
    const root = await comment(fixture.owner, uuid);
    const child = await comment(other, uuid, root.uuid);
    await socialCommentMutations.addComment(
      null,
      {
        input: {
          entityType: 'climb',
          entityId: fixture.climbUuid,
          body: 'Global discussion',
        },
      },
      ctx(other),
    );
    expect((await query(fixture, 'MOST_DISCUSSED')).rows[0]).toMatchObject({ commentCount: 2, authorCount: 2 });
    await socialCommentMutations.deleteComment(null, { commentUuid: root.uuid }, ctx(fixture.owner));
    expect((await query(fixture, 'MOST_DISCUSSED')).rows[0]).toMatchObject({ commentCount: 1, authorCount: 1 });
    const second = await addBoard(fixture.gymId, fixture.owner);
    await edit(uuid, fixture.owner, { boardUuid: second.uuid });
    expect((await query(fixture, 'MOST_DISCUSSED')).rows).toEqual([]);
    const [stored] = rowsFromResult<{ logical_board_id: string }>(
      await db.execute(sql`
      SELECT attribution.logical_board_id FROM gym_climb_comment_attributions attribution
      JOIN comments ON comments.id = attribution.comment_id WHERE comments.uuid = ${child.uuid}
    `),
    );
    expect(Number(stored.logical_board_id)).toBe(fixture.board.id);
  });

  it('suppresses restricted, unscoped and malformed comment ancestry while retaining readable replies', async () => {
    const fixture = await site();
    const other = await user();
    const visitor = await user();
    await db.execute(sql`UPDATE user_boards SET is_public = false WHERE id = ${fixture.board.id}`);
    const uuid = await save(fixture, fixture.owner);
    const root = await comment(fixture.owner, uuid);
    const before = await query(fixture, 'MOST_DISCUSSED');
    expect(before.rows[0]).toMatchObject({ commentCount: 1, target: { shareable: false } });
    await expect(
      gymClimbRankingQueries.gymClimbRankings(
        null,
        { input: { gymUuid: fixture.gymUuid, mode: 'MOST_DISCUSSED' } },
        ctx(visitor),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });

    const otherTick = await save(fixture, fixture.owner);
    const otherRoot = await comment(fixture.owner, otherTick);
    const locked = await comment(fixture.owner, uuid, root.uuid);
    const orphan = await comment(fixture.owner, uuid, root.uuid);
    const foreignParent = await comment(fixture.owner, uuid, root.uuid);
    const cyclic = await comment(fixture.owner, uuid, root.uuid);
    const rootless = await comment(fixture.owner, uuid);
    await db.execute(sql`UPDATE comments SET parent_comment_id = -1 WHERE uuid = ${orphan.uuid}`);
    await db.execute(sql`UPDATE comments SET parent_comment_id = id WHERE uuid = ${cyclic.uuid}`);
    await db.execute(sql`
      UPDATE comments SET parent_comment_id = (SELECT id FROM comments WHERE uuid = ${otherRoot.uuid})
      WHERE uuid = ${foreignParent.uuid}
    `);
    await db.execute(sql`
      DELETE FROM gym_climb_comment_attributions WHERE comment_id = (SELECT id FROM comments WHERE uuid = ${rootless.uuid})
    `);
    const overDepth = await comment(fixture.owner, uuid, root.uuid);
    await db.execute(sql`
      WITH RECURSIVE sequence AS (
        SELECT generate_series(1, 33)::bigint AS ordinal
      ), added AS (
        INSERT INTO comments (id, uuid, entity_type, entity_id, parent_comment_id, user_id, body)
        SELECT (9223372036000000000::bigint + ordinal), ${randomUUID()} || ordinal, 'tick', ${uuid},
          CASE WHEN ordinal = 1 THEN NULL ELSE (9223372036000000000::bigint + ordinal - 1) END,
          ${fixture.owner}, 'Oversized thread fixture'
        FROM sequence RETURNING id
      )
      UPDATE comments SET parent_comment_id = (SELECT max(id) FROM added) WHERE uuid = ${overDepth.uuid}
    `);
    const unscopedReply = await comment(fixture.owner, uuid, rootless.uuid);
    const [unscoped] = rowsFromResult<{ found: boolean }>(
      await db.execute(sql`
      SELECT EXISTS (SELECT 1 FROM gym_climb_comment_attributions context
        JOIN comments item ON item.id = context.comment_id WHERE item.uuid = ${unscopedReply.uuid}) AS found
    `),
    );
    expect(unscoped.found).toBe(false);
    await db.execute(sql`
      INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
      VALUES ('comment', ${locked.uuid}, ${fixture.owner}, 'only_me')
    `);
    expect((await query(fixture, 'MOST_DISCUSSED')).rows[0]).toMatchObject({ commentCount: 2 });
    await db.execute(sql`
      INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
      VALUES ('comment', ${root.uuid}, ${fixture.owner}, 'only_me'), ('tick', ${otherTick}, ${fixture.owner}, 'only_me')
    `);
    expect((await query(fixture, 'MOST_DISCUSSED')).rows).toEqual([]);

    // A follower-only comment can count for a gym owner with the author's grant,
    // then disappears immediately when that relationship is revoked.
    await db.execute(sql`UPDATE user_boards SET is_public = true WHERE id = ${fixture.board.id}`);
    const publicTick = await save(fixture, fixture.owner);
    const followers = await comment(other, publicTick);
    await db.execute(sql`INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
      VALUES ('comment', ${followers.uuid}, ${other}, 'followers')`);
    await db.execute(sql`
      INSERT INTO user_follows (follower_id, following_id) VALUES (${fixture.owner}, ${other})
    `);
    expect((await query(fixture, 'MOST_DISCUSSED')).rows[0]).toMatchObject({ commentCount: 1 });
    await db.execute(sql`DELETE FROM user_follows WHERE follower_id = ${fixture.owner} AND following_id = ${other}`);
    expect((await query(fixture, 'MOST_DISCUSSED')).rows).toEqual([]);
  });

  it('uses the exact database creation instant at both half-open discussion boundaries', async () => {
    const fixture = await site();
    const tick = await save(fixture, fixture.owner);
    const first = stamp(8).slice(0, 19) + '.000003Z';
    const end = stamp(1).slice(0, 19) + '.000003Z';
    for (const [reference, delta] of [
      [first, -1],
      [first, 0],
      [end, -1],
      [end, 0],
    ] as const) {
      const created = await comment(fixture.owner, tick);
      await db.execute(sql`
        WITH moved AS (
          UPDATE comments SET created_at = (${reference}::timestamptz AT TIME ZONE 'UTC')
            + interval '1 microsecond' * ${delta} WHERE uuid = ${created.uuid}
          RETURNING id, created_at
        )
        UPDATE gym_climb_comment_attributions context SET comment_created_at = moved.created_at
        FROM moved WHERE context.comment_id = moved.id
      `);
    }
    const result = await withGymReportingScope({ gymUuid: fixture.gymUuid }, ctx(fixture.owner), (tx, scope) =>
      readRanking(tx, { ...scope, asOf: end, current: { startAt: first, endAt: end } }, 'MOST_DISCUSSED'),
    );
    expect(result.rows[0]).toMatchObject({ commentCount: 2, authorCount: 1 });
  });

  it('serializes reply versus root delete and makes a timed-out reply retryable', async () => {
    const fixture = await site();
    const uuid = await save(fixture, fixture.owner);
    const root = await comment(fixture.owner, uuid);
    const other = await user();
    const result = await blockWrite(
      'comments',
      'DELETE',
      root.uuid,
      () => socialCommentMutations.deleteComment(null, { commentUuid: root.uuid }, ctx(fixture.owner)),
      async () => {
        await expect(comment(other, uuid, root.uuid)).rejects.toMatchObject({
          extensions: { code: 'TEMPORARILY_UNAVAILABLE' },
        });
      },
    );
    expect(result).toBe(true);
    expect((await query(fixture, 'MOST_DISCUSSED')).rows).toEqual([]);
    const [remaining] = rowsFromResult<{ count: number }>(
      await db.execute(sql`
      SELECT count(*)::int AS count FROM comments WHERE entity_type = 'tick' AND entity_id = ${uuid}
    `),
    );
    expect(remaining.count).toBe(0);
  });

  it('rolls back a comment racing a tick delete and never moves a partial write during reassociation', async () => {
    const fixture = await site();
    const other = await user();
    const original = await save(fixture, fixture.owner);
    await comment(fixture.owner, original);
    await expect(
      blockWrite(
        'boardsesh_ticks',
        'DELETE',
        original,
        () => tickMutations.deleteTick(null, { uuid: original }, ctx(fixture.owner)),
        async () => {
          await expect(comment(other, original)).rejects.toMatchObject({
            extensions: { code: 'TEMPORARILY_UNAVAILABLE' },
          });
        },
      ),
    ).resolves.toBe(true);
    expect((await query(fixture, 'MOST_DISCUSSED')).rows).toEqual([]);

    const moved = await save(fixture, fixture.owner);
    const root = await comment(fixture.owner, moved);
    const newBoard = await addBoard(fixture.gymId, fixture.owner);
    await blockWrite(
      'boardsesh_ticks',
      'UPDATE',
      moved,
      () => edit(moved, fixture.owner, { boardUuid: newBoard.uuid }),
      async () => {
        await expect(comment(other, moved, root.uuid)).rejects.toMatchObject({
          extensions: { code: 'TEMPORARILY_UNAVAILABLE' },
        });
      },
    );
    expect((await query(fixture, 'MOST_DISCUSSED')).rows).toEqual([]);
    await comment(other, moved, root.uuid);
    expect((await query(fixture, 'MOST_DISCUSSED')).rows).toEqual([]);
    await comment(other, moved);
    expect((await query(fixture, 'MOST_DISCUSSED')).rows[0]).toMatchObject({
      commentCount: 1,
      target: { logicalBoardUuid: newBoard.uuid },
    });
  });

  it('does not leave an orphan global discussion when a spray climb hard delete wins', async () => {
    const fixture = await site();
    const climbUuid = randomUUID();
    const wallUuid = randomUUID();
    const [layout] = rowsFromResult<{ id: number }>(
      await db.execute(sql`
      SELECT nextval('spray_wall_catalog_id_seq')::int AS id
    `),
    );
    await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name,
        gym_id, is_public, angle, is_angle_adjustable)
      VALUES (${wallUuid}, ${wallUuid}, ${fixture.owner}, 'spray', ${layout.id}, ${layout.id}, '1', 'Quiet wall',
        ${fixture.gymId}, true, 40, false)
    `);
    const [wall] = rowsFromResult<{ id: string }>(
      await db.execute(sql`
      INSERT INTO spray_walls (board_uuid, layout_id) VALUES (${wallUuid}, ${layout.id}) RETURNING id
    `),
    );
    const [version] = rowsFromResult<{ id: string }>(
      await db.execute(sql`
      INSERT INTO spray_wall_versions (wall_id, version_number, status)
      VALUES (${wall.id}, 1, 'published') RETURNING id
    `),
    );
    await db.execute(sql`UPDATE spray_walls SET current_version_id = ${version.id} WHERE id = ${wall.id}`);
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, angle, frames, name, is_listed, is_draft, user_id)
      VALUES (${climbUuid}, 'spray', ${layout.id}, 40, 'p1r12', 'Temporary climb', true, false, ${fixture.owner})
    `);
    let commentOutcome: Promise<unknown> | undefined;
    await expect(
      blockWrite(
        'board_climbs',
        'DELETE',
        climbUuid,
        () => deleteClimbMutations.deleteClimb(null, { uuid: climbUuid, boardType: 'spray' }, ctx(fixture.owner)),
        async () => {
          commentOutcome = socialCommentMutations.addComment(
            null,
            {
              input: {
                entityType: 'climb',
                entityId: climbUuid,
                body: 'Global comment racing deletion',
              },
            },
            ctx(fixture.owner),
          );
          void commentOutcome.catch(() => {});
          await expect
            .poll(async () => {
              const [state] = rowsFromResult<{ blocked: boolean }>(
                await db.execute(sql`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE '%board_climbs%' AND query LIKE '%for key share%') AS blocked
          `),
              );
              return state.blocked;
            })
            .toBe(true);
        },
      ),
    ).resolves.toBe(true);
    await expect(commentOutcome).rejects.toMatchObject({ extensions: { code: 'CLIMB_NOT_FOUND' } });
    const [stored] = rowsFromResult<{ count: number }>(
      await db.execute(sql`
      SELECT count(*)::int AS count FROM comments WHERE entity_type = 'climb' AND entity_id = ${climbUuid}
    `),
    );
    expect(stored.count).toBe(0);
  });

  it('uses exact native ties without using the stored time to order day-only votes', async () => {
    const fixture = await site();
    const climbers = await Promise.all(Array.from({ length: 5 }, () => user()));
    const climbedAt = stamp();
    for (const climber of climbers) await save(fixture, climber, { quality: 4, climbedAt });
    await save(fixture, climbers[0], { quality: 5, climbedAt });
    expect((await query(fixture, 'TOP_RATED')).rows[0]).toMatchObject({ voterCount: 5, qualityMean: 4.2 });

    await save(fixture, climbers[0], {
      quality: 3,
      climbedAt,
      reportingTime: { precision: 'day', date: climbedAt.slice(0, 10), timeZone: 'UTC' },
    });
    expect((await query(fixture, 'TOP_RATED')).rows).toEqual([]);
  });

  it('keeps unrelated day evidence outside the voter calendar budget and fails closed on unresolved relevant days', async () => {
    const fixture = await site();
    const climbers = await Promise.all(Array.from({ length: 5 }, () => user()));
    for (const climber of climbers) await save(fixture, climber, { quality: 4, climbedAt: stamp(5) });
    const day = stamp(2).slice(0, 10);
    await save(fixture, climbers[0], {
      quality: 5,
      climbedAt: day + 'T12:00:00Z',
      reportingTime: { precision: 'day', date: day, timeZone: 'Europe/Paris' },
    });
    const baseline = await query(fixture, 'TOP_RATED');
    expect(baseline.rows[0]).toMatchObject({ voterCount: 5, qualityMean: 4.2 });
    const pressureActor = await user();
    const prefix = randomUUID();
    await db.execute(sql`
      WITH zones AS (
        SELECT name, row_number() OVER (ORDER BY name) AS ordinal,
          (${day}::date + time '12:00') AT TIME ZONE name AT TIME ZONE 'UTC' AS stamp
        FROM pg_timezone_names
        WHERE name ~ '^(Africa|America|Antarctica|Asia|Atlantic|Australia)/[A-Za-z0-9_+/-]+$'
        ORDER BY name LIMIT 270
      )
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status,
        climbed_at, board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution,
        reporting_time_precision, reporting_date, reporting_date_time_zone, reporting_climbed_at, quality)
      SELECT ${prefix} || ordinal, ${pressureActor}, 'kilter', ${fixture.climbUuid}, 40, false, 'send',
        stamp, ${fixture.board.id}, 'native', ${fixture.board.id}, ${fixture.gymId}, 'uuid',
        'day', ${day}::date, name, stamp, 3 FROM zones
    `);
    const [seeded] = rowsFromResult<{ count: number }>(
      await db.execute(sql`
      SELECT count(*)::int AS count FROM boardsesh_ticks WHERE uuid LIKE ${prefix + '%'}
    `),
    );
    expect(seeded.count).toBe(270);
    expect((await query(fixture, 'TOP_RATED')).rows).toEqual(baseline.rows);

    const hidden = await addClimb();
    await db.execute(sql`UPDATE board_climbs SET is_hidden = true WHERE uuid = ${hidden}`);
    await db.execute(sql`UPDATE boardsesh_ticks SET climb_uuid = ${hidden} WHERE uuid LIKE ${prefix + '%'}`);
    const attachRating = () =>
      db.execute(sql`
      INSERT INTO gym_reporting_tick_votes (tick_id, metric, attested_value)
      SELECT id, 'QUALITY', quality FROM boardsesh_ticks WHERE uuid LIKE ${prefix + '%'}
    `);
    await attachRating();
    expect((await query(fixture, 'TOP_RATED')).rows).toEqual(baseline.rows);

    await db.execute(sql`UPDATE boardsesh_ticks SET climb_uuid = ${fixture.climbUuid} WHERE uuid LIKE ${prefix + '%'}`);
    await attachRating();
    await expect(query(fixture, 'TOP_RATED')).resolves.toMatchObject({
      mode: 'TOP_RATED',
      status: 'TEMPORARILY_UNAVAILABLE',
      rows: [],
      nextCursor: null,
      asOf: null,
      truncated: false,
    });
  });

  it('uses lifetime Quiet exposure and can EXPLAIN the full production scoring statements', async () => {
    const fixture = await site();
    const wallUuid = randomUUID();
    const [layout] = rowsFromResult<{ id: number }>(
      await db.execute(sql`
      SELECT nextval('spray_wall_catalog_id_seq')::int AS id
    `),
    );
    const [wallBoard] = rowsFromResult<{ id: string }>(
      await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name,
        gym_id, is_public, angle, is_angle_adjustable)
      VALUES (${wallUuid}, ${wallUuid}, ${fixture.owner}, 'spray', ${layout.id}, ${layout.id}, '1', 'Quiet wall',
        ${fixture.gymId}, true, 40, false)
      RETURNING id
    `),
    );
    const [wall] = rowsFromResult<{ id: string }>(
      await db.execute(sql`
      INSERT INTO spray_walls (board_uuid, layout_id) VALUES (${wallUuid}, ${layout.id}) RETURNING id
    `),
    );
    const [version] = rowsFromResult<{ id: string }>(
      await db.execute(sql`
      INSERT INTO spray_wall_versions (wall_id, version_number, status)
      VALUES (${wall.id}, 1, 'published') RETURNING id
    `),
    );
    await db.execute(sql`UPDATE spray_walls SET current_version_id = ${version.id} WHERE id = ${wall.id}`);
    const quiet = randomUUID();
    const popular = randomUUID();
    const immature = randomUUID();
    const unmeasured = randomUUID();
    for (const climbUuid of [quiet, popular, immature, unmeasured]) {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, angle, frames, name, is_listed, is_draft)
        VALUES (${climbUuid}, 'spray', ${layout.id}, 40, 'p1r12', ${climbUuid}, true, false)
      `);
      if (climbUuid === unmeasured) continue;
      await db.execute(sql`
        INSERT INTO spray_exposure_observations (board_id, board_uuid, gym_id, wall_id, version_id, layout_id,
          angle, climb_uuid, observed_at)
        VALUES (${wallBoard.id}, ${wallUuid}, ${fixture.gymId}, ${wall.id}, ${version.id}, ${layout.id}, 40, ${climbUuid},
          now() - make_interval(days => ${climbUuid === immature ? 13 : 21}))
      `);
    }
    await db.execute(sql`
      INSERT INTO spray_exposure_invalidations (kind, key, observed_at)
      VALUES ('layout', public.spray_exposure_climb_key(${layout.id}, ${popular}), now() - interval '3 days')
    `);
    await db.execute(sql`
      INSERT INTO spray_exposure_observations (board_id, board_uuid, gym_id, wall_id, version_id, layout_id,
        angle, climb_uuid, observed_at)
      VALUES (${wallBoard.id}, ${wallUuid}, ${fixture.gymId}, ${wall.id}, ${version.id}, ${layout.id}, 40, ${popular},
        now() - interval '2 days')
    `);
    await db.execute(sql`
      INSERT INTO spray_exposure_checkpoints
        (board_id, board_uuid, gym_id, wall_id, version_id, layout_id, angle, observed_at)
      VALUES (${wallBoard.id}, ${wallUuid}, ${fixture.gymId}, ${wall.id}, ${version.id}, ${layout.id}, 40, now())
    `);
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count,
        climbed_at, board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution, reporting_time_precision,
        reporting_climbed_at)
      VALUES (${randomUUID()}, ${fixture.owner}, 'spray', ${popular}, 40, false, 'send', 1,
        (now() AT TIME ZONE 'UTC') - interval '2 days', ${wallBoard.id}, 'native', ${wallBoard.id}, ${fixture.gymId},
        'uuid', 'instant', (now() AT TIME ZONE 'UTC') - interval '2 days')
    `);
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count,
        climbed_at, board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution, reporting_time_precision,
        reporting_date, reporting_date_time_zone, reporting_climbed_at)
      SELECT ${randomUUID()}, ${fixture.owner}, 'spray', ${popular}, 40, false, 'send', 1,
        stamp, ${wallBoard.id}, 'native', ${wallBoard.id}, ${fixture.gymId}, 'uuid', 'day', stamp::date, 'UTC', stamp
      FROM (SELECT ((now() AT TIME ZONE 'UTC')::date - 3) + time '12:00' AS stamp) wall_day
    `);
    await save(fixture, fixture.owner);
    const result = await query(fixture, 'QUIET_CLIMBS');
    expect(result.status).toBe('READY');
    expect(result.quietAvailable).toBe(true);
    expect(result.rows.map(({ target }) => target.climbUuid)).toEqual([quiet, popular]);
    expect(result.rows[0]).toMatchObject({ sendCount: 0, lastSendAt: null, boardName: 'Quiet wall' });
    expect(result.rows[0].knownLifetimeDays).toBeCloseTo(21);
    expect(result.rows[0].knownWindowDays).toBeCloseTo(7);
    expect(result.rows[1].knownLifetimeDays).toBeGreaterThan(19);
    expect(result.rows[1].knownWindowDays).toBeCloseTo(6);
    expect(result.rows[1]).toMatchObject({ sendCount: 1, lastSendEndAt: null });
    expect(result.rows[1].sendsPerDay).toBeCloseTo(1 / 6);
    expect((await query(fixture, 'QUIET_CLIMBS', fixture.board.uuid)).quietAvailable).toBe(false);

    const explainFile = process.env.BOARDSESH_GYM_RANKING_EXPLAIN_FILE;
    if (!explainFile) return;
    const climbers = await Promise.all(Array.from({ length: 5 }, () => user()));
    const day = stamp(2).slice(0, 10);
    for (const [index, climber] of climbers.entries()) {
      const tick = await save(fixture, climber, {
        quality: 4,
        difficulty: 18,
        ...(index === 0
          ? {
              climbedAt: day + 'T12:00:00Z',
              reportingTime: { precision: 'day', date: day, timeZone: 'Europe/Paris' } as const,
            }
          : {}),
      });
      if (index === 0) await comment(climber, tick);
    }
    await db.execute(sql`UPDATE board_climb_stats SET display_difficulty = 18 WHERE climb_uuid = ${fixture.climbUuid}`);
    const plans = await withGymReportingScope(
      { gymUuid: fixture.gymUuid },
      ctx(fixture.owner),
      async (tx, scope) => {
        const boards = await readInventoryBoards(tx, scope, false);
        await assertInventoryWorkBounded(tx, boards);
        const modes = ['MOST_SENT', 'TOP_RATED', 'MOST_DISCUSSED', 'GRADE_FEEDBACK', 'QUIET_CLIMBS'] as const;
        const results = [];
        for (const mode of modes) {
          const statement = await prepareRankingRowsStatement(tx, scope, mode, boards);
          if (!statement) throw new Error(`Missing full scoring statement for ${mode}`);
          const plan = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
          expect(JSON.stringify(plan)).toContain('Execution Time');
          results.push({ mode, plan });
        }
        return results;
      },
      { maxBoards: GYM_INVENTORY_MAX_BOARDS, readsPerMinute: 20, operation: 'gym-climb-rankings-explain' },
    );
    await appendFile(explainFile, plans.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  });

  it('uses the bounded board/time indexes for both source caps and refuses partial rankings', async () => {
    const fixture = await site();
    await withGymReportingScope({ gymUuid: fixture.gymUuid }, ctx(fixture.owner), async (tx, scope) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      for (const [statement, index] of [
        [rankingTickCandidatesSql(scope, scope.current.startAt), 'boardsesh_ticks_board_climbed_at_idx'],
        [rankingCommentCandidatesSql(scope, sql`1`, false), 'gym_climb_comment_attribution_board_time_idx'],
      ] as const) {
        const plan = await tx.execute(sql`EXPLAIN (COSTS OFF) ${statement} LIMIT 10`);
        expect(JSON.stringify(plan)).toContain(index);
      }
    });

    const tick = await save(fixture, fixture.owner);
    await db.transaction(async (tx) => {
      // The test only needs raw candidates. Suppress unrelated fixture changelog writes.
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, board_id)
        SELECT ${randomUUID()} || ordinal, ${fixture.owner}, 'kilter', ${fixture.climbUuid}, 40, 'send',
          now() AT TIME ZONE 'UTC', ${fixture.board.id}
        FROM generate_series(1, 100001) AS ordinal
      `);
    });
    expect(await query(fixture, 'MOST_SENT')).toMatchObject({ status: 'SCOPE_TOO_LARGE', rows: [] });
    await db.execute(sql`
      WITH added AS (
        INSERT INTO comments (uuid, user_id, entity_type, entity_id, body)
        SELECT ${randomUUID()} || ordinal, ${fixture.owner}, 'tick', ${tick}, 'Source budget fixture'
        FROM generate_series(1, 4097) ordinal RETURNING id, created_at
      )
      INSERT INTO gym_climb_comment_attributions (comment_id, logical_board_id, board_uuid, gym_id, board_type,
        climb_uuid, angle, is_mirror, comment_created_at)
      SELECT id, ${fixture.board.id}, ${fixture.board.uuid}, ${fixture.gymId}, 'kilter',
        ${fixture.climbUuid}, 40, false, created_at FROM added
    `);
    expect(await query(fixture, 'MOST_DISCUSSED')).toMatchObject({ status: 'SCOPE_TOO_LARGE', rows: [] });
  }, 30000);

  // This pagination fixture saves 21 real ticks serially before requesting the first page.
  it('restarts a continuation when a previously ranked climb is withdrawn', async () => {
    const fixture = await site();
    const climbs = Array.from({ length: 20 }, () => randomUUID());
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, frames, is_listed, is_draft, is_hidden, compatible_size_ids,
        required_set_ids, name)
      SELECT uuid, 'kilter', 1, 'p1r12', true, false, false, ARRAY[8], ARRAY[1], uuid
      FROM unnest(ARRAY[${sql.join(
        climbs.map((uuid) => sql`${uuid}::text`),
        sql`, `,
      )}]) uuid
    `);
    for (const climbUuid of [...climbs, fixture.climbUuid]) await save({ ...fixture, climbUuid }, fixture.owner);
    const first = await query(fixture, 'MOST_SENT');
    expect(first.rows).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    expect((await query(fixture, 'MOST_SENT', null, first.nextCursor!)).rows).toHaveLength(1);
    const expired = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')),
        asOf: stamp(1).replace(/\.(\d+)Z$/, '.$1000Z'),
      }),
    ).toString('base64url');
    expect(await query(fixture, 'MOST_SENT', null, expired)).toMatchObject({ status: 'PAGE_CHANGED', rows: [] });
    await db.execute(sql`UPDATE board_climbs SET is_hidden = true WHERE uuid = ${first.rows[0].target.climbUuid}`);
    expect(await query(fixture, 'MOST_SENT', null, first.nextCursor!)).toMatchObject({
      status: 'PAGE_CHANGED',
      rows: [],
    });
  }, 30000);
});
