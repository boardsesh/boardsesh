import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { parse, type GraphQLResolveInfo } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../db/client';
import { socialGymInsightsQueries } from '../graphql/resolvers/social/gym-insights';
import { gymReportingSettingsMutations } from '../graphql/resolvers/social/gym-reporting-settings';

const AS_OF = '2026-10-28T19:00:00.000Z';
const OLD_FLOOR = '2025-01-01T00:00:00.000Z';
const CLIMB = 'retired-gym-reach-test-climb';
const DAY_MS = 24 * 60 * 60_000;
const operation = parse('{ gymStats(input: { gymUuid: "fixture" }) { reachOverview { observationStartedAt } } }')
  .definitions[0];
if (operation.kind !== 'OperationDefinition') throw new Error('Expected a test query');
const overviewInfo = { fieldNodes: operation.selectionSet.selections, fragments: {} } as unknown as GraphQLResolveInfo;

let connection = 0;
let boardSize = 400;
function auth(userId: string) {
  return { connectionId: `gym-reach-${connection++}`, userId, isAuthenticated: true } as ConnectionContext;
}

async function user() {
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO users (id, email, name, created_at, updated_at) VALUES (${id}, ${id + '@test.example'}, ${id}, now(), now())`,
  );
  return id;
}

async function gym(ownerId: string, zone: string | null = 'America/Los_Angeles') {
  const uuid = randomUUID();
  const [row] = rowsFromResult<{ id: number }>(
    await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, reporting_time_zone)
    VALUES (${uuid}, 'Reach Gym', ${uuid}, ${ownerId}, true, ${zone})
    RETURNING id
  `),
  );
  return { id: Number(row.id), uuid, ownerId };
}

async function board(venue: Awaited<ReturnType<typeof gym>>, opts: { owner?: string; isPublic?: boolean } = {}) {
  const uuid = randomUUID();
  const [row] = rowsFromResult<{ id: number }>(
    await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public)
    VALUES (${uuid}, ${uuid}, ${opts.owner ?? venue.ownerId}, 'kilter', 1, ${boardSize++}, '1,2', ${uuid}, ${venue.id},
      ${opts.isPublic ?? true})
    RETURNING id
  `),
  );
  return { id: Number(row.id), uuid, gymId: venue.id };
}

async function receipt(gymId: number, startedAt = OLD_FLOOR) {
  await db.execute(sql`
    INSERT INTO gym_reporting_observations (gym_id, contract_version, started_at)
    VALUES (${gymId}, 1, ${startedAt}::timestamptz)
  `);
}

async function receiptCount(gymId: number) {
  const [row] = rowsFromResult<{ count: number }>(
    await db.execute(sql`
    SELECT count(*)::int AS count FROM gym_reporting_observations WHERE gym_id = ${gymId}
  `),
  );
  return row.count;
}

async function report(
  venue: Awaited<ReturnType<typeof gym>>,
  opts: { boardUuid?: string; userId?: string; period?: 'week' | 'month' | 'quarter' } = {},
) {
  const data = await socialGymInsightsQueries.gymStats(
    null,
    {
      input: { gymUuid: venue.uuid, boardUuid: opts.boardUuid, period: opts.period },
    },
    auth(opts.userId ?? venue.ownerId),
    overviewInfo,
  );
  if (!data.reachOverview) throw new Error('Expected the requested reach field');
  return data.reachOverview;
}

async function tick(
  wall: Awaited<ReturnType<typeof board>>,
  actor: string,
  at: string,
  opts: {
    status?: 'send' | 'flash' | 'attempt';
    origin?: 'native' | 'kilter_pull';
    mirror?: boolean;
    unknown?: boolean;
    authorDate?: string;
    authorZone?: string;
    capturedGym?: number | null;
  } = {},
) {
  const uuid = randomUUID();
  const precision = opts.unknown ? null : opts.authorDate ? 'day' : 'instant';
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, origin, climbed_at, board_id,
      reporting_board_id, reporting_gym_id, reporting_attribution, reporting_time_precision,
      reporting_date, reporting_date_time_zone, reporting_climbed_at, attempt_count)
    VALUES (${uuid}, ${actor}, 'kilter', ${CLIMB}, 40, ${opts.mirror ?? false}, ${opts.status ?? 'send'}::tick_status,
      ${opts.origin ?? 'native'}::tick_origin, ${at}::timestamptz AT TIME ZONE 'UTC', ${wall.id}, ${wall.id},
      ${opts.capturedGym === undefined ? wall.gymId : opts.capturedGym}, 'uuid', ${precision}, ${opts.authorDate ?? null}::date,
      ${opts.authorZone ?? null}, ${precision ? sql`${at}::timestamptz AT TIME ZONE 'UTC'` : sql`NULL`}, 12)
  `);
  return uuid;
}

let seq = 0;
async function display(wall: Awaited<ReturnType<typeof board>>, actor: string | null, at: string) {
  await db.execute(sql`
    INSERT INTO board_climb_events (board_id, board_type, source, user_id, seq, climb_uuid, angle,
      confirmed_at, reporting_board_id, reporting_gym_id)
    VALUES (${wall.id}, 'kilter', 'boardsesh', ${actor}, ${seq++}, ${CLIMB}, 40,
      ${at}::timestamptz AT TIME ZONE 'UTC', ${wall.id}, ${wall.gymId})
  `);
}

afterEach(() => vi.useRealTimers());

describe('gym reach overview', () => {
  it('counts first records, returns and reactivated climbers across sources and physical boards', async () => {
    vi.setSystemTime(new Date(AS_OF));
    const [owner, pastAndPresent, returner, justNew, reactivated, previousOnly, unrelated] = await Promise.all(
      Array.from({ length: 7 }, () => user()),
    );
    const venue = await gym(owner);
    await receipt(venue.id);
    const [wallA, wallB, privateWall] = await Promise.all([
      board(venue),
      board(venue),
      board(venue, { owner: unrelated, isPublic: false }),
    ]);
    await gymReportingSettingsMutations.setGymReportingBoardAlias(
      null,
      {
        input: { gymUuid: venue.uuid, boardUuid: wallB.uuid, rootBoardUuid: wallA.uuid },
      },
      auth(owner),
    );
    await Promise.all([
      display(wallA, pastAndPresent, '2026-10-08T12:00:00Z'),
      display(wallB, pastAndPresent, '2026-10-17T12:00:00Z'),
      display(wallB, pastAndPresent, '2026-10-24T12:00:00Z'),
      display(wallB, returner, '2026-10-17T13:00:00Z'),
      tick(wallA, returner, '2026-10-25T01:00:00Z', { status: 'flash' }),
      tick(wallA, returner, '2026-10-25T01:00:00Z', { status: 'send', mirror: true }),
      tick(wallB, returner, '2026-10-25T02:00:00Z', { status: 'send' }),
      tick(wallB, returner, '2026-10-25T02:00:00Z', { origin: 'kilter_pull' }),
      tick(wallA, justNew, '2026-10-26T12:00:00Z', { status: 'attempt' }),
      tick(wallB, reactivated, '2019-06-11T05:00:00Z', {
        status: 'attempt',
        authorDate: '2019-06-10',
        authorZone: 'America/Los_Angeles',
      }),
      display(wallA, reactivated, '2026-10-26T12:00:00Z'),
      display(wallB, previousOnly, '2026-10-17T14:00:00Z'),
      display(wallB, null, '2026-10-25T11:00:00Z'),
      tick(privateWall, unrelated, '2026-10-25T02:00:00Z'),
      tick(wallA, unrelated, AS_OF),
    ]);
    const data = await report(venue);
    expect(data.current.climbers).toEqual({ count: 4, coverage: 'complete' });
    expect(data.current.firstRecorded).toEqual({ count: 1, coverage: 'complete' });
    expect(data.current.sends).toEqual({ count: 3, coverage: 'complete' });
    expect(data.current.sendLoggers).toBe(1);
    expect(data.current.sessions).toEqual({ count: 1, coverage: 'complete' });
    expect(data.cameBack).toEqual({ returning: 2, previousClimbers: 3, coverage: 'complete' });
    expect(data.previousCameBack).toEqual({ returning: 1, previousClimbers: 1, coverage: 'complete' });
    expect((await report(venue, { boardUuid: wallB.uuid })).current).toEqual(data.current);
    expect(JSON.stringify(data)).not.toContain(returner);
  });

  it('distinguishes recorded zero, missing complete weeks and the running Monday-start week', async () => {
    vi.setSystemTime(new Date(AS_OF));
    const owner = await user();
    const venue = await gym(owner);
    await board(venue);
    await receipt(venue.id, '2026-09-01T00:00:00.000Z');
    const data = await report(venue);
    expect(data.weeklyTrend).toHaveLength(12);
    expect(data.weeklyTrend[0]).toMatchObject({
      startDate: '2026-08-10',
      endDate: '2026-08-16',
      inProgress: false,
      sends: { count: 0, coverage: 'unavailable' },
    });
    expect(data.weeklyTrend.at(-2)).toMatchObject({
      startDate: '2026-10-19',
      endDate: '2026-10-25',
      inProgress: false,
      climbers: { count: 0, coverage: 'complete' },
      sends: { count: 0, coverage: 'complete' },
    });
    expect(data.weeklyTrend.at(-1)).toMatchObject({ startDate: '2026-10-26', inProgress: true });
    expect(data.cameBack).toEqual({ returning: 0, previousClimbers: 0, coverage: 'unavailable' });
  });

  it('keeps uncertain author day candidates out and refreshes an earlier-history classification', async () => {
    vi.setSystemTime(new Date(AS_OF));
    const [owner, lateActor, uncertainActor] = await Promise.all([user(), user(), user()]);
    const venue = await gym(owner);
    await receipt(venue.id);
    const wall = await board(venue);
    await tick(wall, lateActor, '2026-10-27T03:00:00Z');
    await tick(wall, uncertainActor, '2026-10-26T19:00:00Z', { status: 'attempt' });
    await tick(wall, uncertainActor, '2026-10-21T22:00:00Z', {
      status: 'attempt',
      authorDate: '2026-10-21',
      authorZone: 'UTC',
    });
    const before = await report(venue);
    expect(before.current.firstRecorded).toEqual({ count: 1, coverage: 'partial' });
    expect(before.current.uncertainFirstRecorded).toBe(1);
    expect(before.current.sends).toEqual({ count: 1, coverage: 'complete' });
    const uploaded = await tick(wall, lateActor, '2025-04-26T15:00:00Z', { status: 'attempt' });
    expect((await report(venue)).current.firstRecorded.count).toBe(0);
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid = ${uploaded}`);
    expect((await report(venue)).current.firstRecorded.count).toBe(1);
  });

  it.each([
    {
      window: 'current' as const,
      precise: '2026-10-25T20:00:00Z',
      before: '2026-10-21T18:00:00Z',
      shortlyAfter: '2026-10-21T20:00:00Z',
      farAfter: '2026-10-27T20:00:00Z',
      recordedDate: '2026-10-23',
    },
    {
      window: 'previous' as const,
      precise: '2026-10-18T20:00:00Z',
      before: '2026-10-14T18:00:00Z',
      shortlyAfter: '2026-10-14T20:00:00Z',
      farAfter: '2026-10-20T20:00:00Z',
      recordedDate: '2026-10-16',
    },
  ])('uses an all-history unbounded probe for $window candidates only', async (fixture) => {
    vi.setSystemTime(new Date(AS_OF));
    const [owner, privateOwner, beforeActor, nearActor, farActor, correctedActor, cleanActor] = await Promise.all(
      Array.from({ length: 7 }, () => user()),
    );
    const venue = await gym(owner);
    const wall = await board(venue);
    const privateWall = await board(venue, { owner: privateOwner, isPublic: false });
    await receipt(venue.id);
    const allActors = [beforeActor, nearActor, farActor, correctedActor, cleanActor];
    await Promise.all(allActors.map((actor) => display(wall, actor, fixture.precise)));
    const oldClient = { status: 'attempt', unknown: true } as const;
    await Promise.all([
      tick(wall, beforeActor, fixture.before, oldClient),
      tick(wall, nearActor, fixture.shortlyAfter, oldClient),
      tick(wall, farActor, fixture.farAfter, oldClient),
      tick(privateWall, cleanActor, fixture.farAfter, oldClient),
      // This certified day fits entirely after the cohort cutoff.
      tick(wall, cleanActor, `${fixture.recordedDate}T12:00:00Z`, {
        status: 'attempt',
        authorDate: fixture.recordedDate,
        authorZone: 'UTC',
      }),
    ]);
    const hidden = await tick(wall, cleanActor, fixture.farAfter, oldClient);
    await db.execute(sql`INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
      VALUES ('tick', ${hidden}, ${cleanActor}, 'only_me')`);
    const corrected = await tick(wall, correctedActor, '2026-10-01T12:00:00Z', {
      status: 'attempt',
      authorDate: '2026-10-01',
      authorZone: 'UTC',
    });
    // The mutable logbook time can move beyond every report window. Its saved
    // author-day evidence is no longer certified for the new timestamp.
    await db.execute(sql`UPDATE boardsesh_ticks SET climbed_at = '2026-12-14 20:00' WHERE uuid = ${corrected}`);
    const result = (await report(venue))[fixture.window];
    expect(result.climbers).toEqual({ count: 5, coverage: 'complete' });
    expect(result.firstRecorded).toEqual({ count: 1, coverage: 'partial' });
    expect(result.uncertainFirstRecorded).toBe(4);
  });

  it('keeps definite C/P membership complete despite a boundary-day duplicate', async () => {
    vi.setSystemTime(new Date(AS_OF));
    const [owner, returning, uncertainActor] = await Promise.all([user(), user(), user()]);
    const venue = await gym(owner);
    await receipt(venue.id);
    const wall = await board(venue);
    await display(wall, returning, '2026-10-17T22:00:00Z');
    await display(wall, returning, '2026-10-24T22:00:00Z');
    const boundary = { authorDate: '2026-10-21', authorZone: 'UTC' };
    await tick(wall, returning, '2026-10-21T22:00:00Z', boundary);
    const completeCohort = await report(venue);
    expect(completeCohort.current.climbers).toEqual({ count: 1, coverage: 'complete' });
    expect(completeCohort.previous.climbers).toEqual({ count: 1, coverage: 'complete' });
    expect(completeCohort.cameBack).toEqual({ returning: 1, previousClimbers: 1, coverage: 'complete' });
    expect(completeCohort.current.sends.coverage).toBe('partial');
    expect(completeCohort.previous.sessions.coverage).toBe('partial');

    await tick(wall, uncertainActor, '2026-10-21T22:00:00Z', { ...boundary, status: 'attempt' });
    const incompleteCohort = await report(venue);
    expect(incompleteCohort.current.climbers).toEqual({ count: 1, coverage: 'partial' });
    expect(incompleteCohort.previous.climbers).toEqual({ count: 1, coverage: 'partial' });
    expect(incompleteCohort.cameBack).toEqual({ returning: 1, previousClimbers: 1, coverage: 'partial' });
  });

  it.each(['2026-10-25T10:00:00Z', '2020-10-25T10:00:00Z'])(
    'withholds the zero rate while unbounded evidence could add a previous member (raw stamp %s)',
    async (rawStamp) => {
      vi.setSystemTime(new Date(AS_OF));
      const [owner, currentOnly, previousOnly, hiddenActor] = await Promise.all([user(), user(), user(), user()]);
      const venue = await gym(owner);
      await receipt(venue.id);
      const wall = await board(venue);
      const hiddenWall = await board(venue, { owner: hiddenActor, isPublic: false });
      await display(wall, currentOnly, '2026-10-24T22:00:00Z');
      await display(wall, previousOnly, '2026-10-17T22:00:00Z');
      await display(wall, previousOnly, '2026-10-10T22:00:00Z');
      await tick(hiddenWall, hiddenActor, rawStamp, { unknown: true });
      const onlyMe = await tick(wall, hiddenActor, rawStamp, { unknown: true });
      await db.execute(sql`INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
        VALUES ('tick', ${onlyMe}, ${hiddenActor}, 'only_me')`);
      const unknown = await tick(wall, currentOnly, rawStamp, { status: 'attempt', unknown: true });

      const partial = await report(venue);
      expect(partial.current.climbers).toEqual({ count: 1, coverage: 'complete' });
      expect(partial.previous.climbers).toEqual({ count: 1, coverage: 'partial' });
      expect(partial.cameBack).toEqual({ returning: 0, previousClimbers: 1, coverage: 'partial' });
      expect(partial.previousCameBack).toEqual({ returning: 1, previousClimbers: 1, coverage: 'partial' });
      expect(partial.current.sends).toEqual({ count: 0, coverage: 'complete' });
      expect(partial.weeklyTrend.find(({ startDate }) => startDate === '2026-10-19')?.climbers.coverage).toBe(
        'complete',
      );
      expect(partial.weeklyTrend.find(({ startDate }) => startDate === '2026-10-12')?.climbers.coverage).toBe(
        'partial',
      );

      const certify = (at: string) => {
        const stamp = sql`${at}::timestamptz AT TIME ZONE 'UTC'`;
        return db.execute(sql`UPDATE boardsesh_ticks SET
          climbed_at = ${stamp}, reporting_climbed_at = ${stamp}, reporting_time_precision = 'instant'
          WHERE uuid = ${unknown}`);
      };
      await certify('2026-10-25T10:00:00Z');
      expect((await report(venue)).cameBack).toEqual({ returning: 0, previousClimbers: 1, coverage: 'complete' });
      await certify('2026-10-18T10:00:00Z');
      expect((await report(venue)).cameBack).toEqual({ returning: 1, previousClimbers: 2, coverage: 'complete' });
    },
  );

  it.each([true, false])(
    'withholds a partial rate until a missing previous actor is classified (returns: %s)',
    async (returns) => {
      vi.setSystemTime(new Date(AS_OF));
      const [owner, returning, previous, ambiguous] = await Promise.all([user(), user(), user(), user()]);
      const venue = await gym(owner);
      await receipt(venue.id);
      const wall = await board(venue);
      await tick(wall, returning, '2026-10-18T19:00:00Z', { status: 'attempt' });
      await tick(wall, returning, '2026-10-26T19:00:00Z', { status: 'attempt' });
      await tick(wall, previous, '2026-10-18T19:00:00Z', { status: 'attempt' });
      const unknown = await tick(wall, ambiguous, '2026-10-17T07:00:00Z', { status: 'attempt', unknown: true });
      if (returns) await display(wall, ambiguous, '2026-10-26T19:00:00Z');
      const partial = await report(venue);
      expect(partial.cameBack).toEqual({ returning: 1, previousClimbers: 2, coverage: 'partial' });
      await db.execute(sql`
      UPDATE boardsesh_ticks SET reporting_climbed_at = climbed_at, reporting_time_precision = 'instant'
      WHERE uuid = ${unknown}
    `);
      const complete = await report(venue);
      expect(complete.cameBack).toEqual({ returning: returns ? 2 : 1, previousClimbers: 3, coverage: 'complete' });
    },
  );

  it('starts a DB receipt with no activity, keeps it immutable, and matures while empty', async () => {
    const owner = await user();
    const venue = await gym(owner, 'UTC');
    await board(venue);
    const oldSelection = await socialGymInsightsQueries.gymStats(null, { input: { gymUuid: venue.uuid } }, auth(owner));
    expect(oldSelection.reachOverview).toBeNull();
    expect(await receiptCount(venue.id)).toBe(0);
    const activation = await Promise.all([report(venue), report(venue)]);
    expect(activation.some((value) => value.observationStartedAt === null)).toBe(true);
    expect(await receiptCount(venue.id)).toBe(1);
    vi.setSystemTime(new Date(Date.now() + 100 * DAY_MS));
    const data = await report(venue);
    expect(data.observationStartedAt).toBeTruthy();
    expect(data.current).toMatchObject({
      climbers: { count: 0, coverage: 'complete' },
      firstRecorded: { count: 0, coverage: 'complete' },
      sends: { count: 0, coverage: 'complete' },
      sessions: { count: 0, coverage: 'complete' },
    });
    expect(data.weeklyTrend.slice(0, -1).every((week) => week.sends.coverage === 'complete')).toBe(true);
    expect((await report(venue)).observationStartedAt).toBe(data.observationStartedAt);
  });

  it('waits for the merged gym receipt and excludes captured other or unlinked venues after a return', async () => {
    const owner = await user();
    const venue = await gym(owner, 'UTC');
    const twin = await gym(owner, 'UTC');
    const other = await gym(owner, 'UTC');
    await receipt(venue.id);
    const wall = await board(venue);
    vi.setSystemTime(new Date(AS_OF));
    await db.execute(sql`UPDATE user_boards SET gym_id = ${other.id} WHERE id = ${wall.id}`);
    await tick(wall, owner, '2026-10-25T01:00:00Z', { capturedGym: other.id });
    await tick(wall, owner, '2026-10-25T02:00:00Z', { capturedGym: null });
    await db.execute(sql`UPDATE user_boards SET gym_id = ${venue.id} WHERE id = ${wall.id}`);
    await tick(wall, owner, '2026-10-25T03:00:00Z');
    const prior = await report(venue);
    expect(prior.current.sends).toEqual({ count: 1, coverage: 'complete' });
    await db.execute(sql`UPDATE gyms SET deleted_at = now(), merged_into_gym_id = ${venue.id} WHERE id = ${twin.id}`);
    expect((await report(venue)).observationStartedAt).toBeNull();
    expect(await receiptCount(twin.id)).toBe(1);
    // Move the reporting clock forward, never rewrite the immutable receipt.
    vi.setSystemTime(new Date(Date.now() + 100 * DAY_MS));
    const merged = await report(venue);
    expect(merged.observationStartedAt).not.toBe(prior.observationStartedAt);
    expect(merged.current.sends.coverage).toBe('complete');
  });
});
