import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { parse, type GraphQLResolveInfo } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../db/client';
import { socialGymInsightsQueries } from '../graphql/resolvers/social/gym-insights';
import { gymReportingSettingsMutations } from '../graphql/resolvers/social/gym-reporting-settings';
import { readGymBusyTimes } from '../graphql/resolvers/social/gym-busy-times';
import { withGymReportingScope } from '../graphql/resolvers/social/gym-reporting';
import { activateGymReachObservation } from '../graphql/resolvers/social/gym-reporting-observation';
import { resolveGymAddressLocation } from '../services/gym-address-location';

vi.mock('../services/gym-address-location', () => ({ resolveGymAddressLocation: vi.fn() }));

const AS_OF = '2026-10-28T19:00:00.000Z';
const OLD_FLOOR = '2025-01-01T00:00:00.000Z';
const CLIMB = 'retired-gym-reach-test-climb';
const DAY_MS = 24 * 60 * 60_000;
const operation = parse('{ gymStats(input: { gymUuid: "fixture" }) { reachOverview { observationStartedAt } } }')
  .definitions[0];
if (operation.kind !== 'OperationDefinition') throw new Error('Expected a test query');
const overviewInfo = { fieldNodes: operation.selectionSet.selections, fragments: {} } as unknown as GraphQLResolveInfo;
const busyOperation = parse('{ gymStats(input: { gymUuid: "fixture" }) { busyTimes { status } } }').definitions[0];
if (busyOperation.kind !== 'OperationDefinition') throw new Error('Expected a test query');
const busyInfo = { fieldNodes: busyOperation.selectionSet.selections, fragments: {} } as unknown as GraphQLResolveInfo;

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

beforeEach(() => vi.mocked(resolveGymAddressLocation).mockReset().mockResolvedValue(null));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('gym reach overview', () => {
  it('looks up an authorized address before the reporting transaction and binds it to the current gym', async () => {
    const owner = await user();
    const venue = await gym(owner, null);
    await board(venue);
    const address = 'Damrak 1, Amsterdam, Netherlands';
    await db.execute(sql`UPDATE gyms SET address = ${address} WHERE id = ${venue.id}`);
    const transactionSpy = vi.spyOn(db, 'transaction');
    vi.mocked(resolveGymAddressLocation).mockImplementationOnce(async () => {
      expect(transactionSpy).not.toHaveBeenCalled();
      return { address, latitude: 52.3676, longitude: 4.9041 };
    });
    const scope = await withGymReportingScope({ gymUuid: venue.uuid }, auth(owner), async (_, scope) => scope);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(scope).toMatchObject({ timeZone: 'Europe/Amsterdam', timeZoneConfigured: true });
    await db.execute(sql`UPDATE gyms SET address = 'Changed address' WHERE id = ${venue.id}`);
    await activateGymReachObservation(scope);
    expect(await receiptCount(venue.id)).toBe(0);
  });

  it.each(['address', 'is_public', 'is_listed'] as const)(
    'ignores preflight evidence when %s changes before the snapshot',
    async (changedField) => {
      const owner = await user();
      const venue = await gym(owner, null);
      await board(venue);
      const address = 'Damrak 1, Amsterdam, Netherlands';
      await db.execute(sql`UPDATE gyms SET address = ${address} WHERE id = ${venue.id}`);
      vi.mocked(resolveGymAddressLocation).mockImplementationOnce(async () => {
        if (changedField === 'address') {
          await db.execute(sql`UPDATE gyms SET address = 'Changed address' WHERE id = ${venue.id}`);
        } else if (changedField === 'is_public') {
          await db.execute(sql`UPDATE gyms SET is_public = false WHERE id = ${venue.id}`);
        } else {
          await db.execute(sql`UPDATE gyms SET is_listed = false WHERE id = ${venue.id}`);
        }
        return { address, latitude: 52.3676, longitude: 4.9041 };
      });
      const scope = await withGymReportingScope({ gymUuid: venue.uuid }, auth(owner), async (_, scope) => scope);
      expect(scope).toMatchObject({ timeZone: 'UTC', timeZoneConfigured: false });
      await activateGymReachObservation(scope);
      expect(await receiptCount(venue.id)).toBe(0);
    },
  );

  it('uses mapped gym time without persisting an override and preserves local DST boundaries', async () => {
    vi.setSystemTime(new Date('2026-03-12T12:00:00Z'));
    const owner = await user();
    const venue = await gym(owner, null);
    await board(venue);
    await db.execute(sql`UPDATE gyms SET latitude = 40.7128, longitude = -74.006 WHERE id = ${venue.id}`);
    const scope = await withGymReportingScope({ gymUuid: venue.uuid }, auth(owner), async (tx, reportingScope) => {
      const [mode] = rowsFromResult<{ readOnly: string }>(
        await tx.execute(sql`SELECT current_setting('transaction_read_only') AS "readOnly"`),
      );
      expect(mode.readOnly).toBe('on');
      return reportingScope;
    });
    expect(scope).toMatchObject({ timeZone: 'America/New_York', timeZoneConfigured: true });
    expect(new Date(scope.current.startAt).toISOString()).toBe('2026-03-05T13:00:00.000Z');
    const [stored] = rowsFromResult<{ zone: string | null }>(
      await db.execute(sql`SELECT reporting_time_zone AS zone FROM gyms WHERE id = ${venue.id}`),
    );
    expect(stored.zone).toBeNull();
  });

  it('recomputes the location default, preserves an override, and restores automatic mode when cleared', async () => {
    const owner = await user();
    const venue = await gym(owner, null);
    await board(venue);
    await db.execute(sql`UPDATE gyms SET latitude = 52.3676, longitude = 4.9041 WHERE id = ${venue.id}`);
    const readZone = () =>
      withGymReportingScope({ gymUuid: venue.uuid }, auth(owner), async (_, scope) => scope.timeZone);
    expect(await readZone()).toBe('Europe/Amsterdam');
    await gymReportingSettingsMutations.setGymReportingTimeZone(
      null,
      { input: { gymUuid: venue.uuid, timeZone: 'UTC' } },
      auth(owner),
    );
    await db.execute(sql`UPDATE gyms SET latitude = -33.8688, longitude = 151.2093 WHERE id = ${venue.id}`);
    expect(await readZone()).toBe('UTC');
    await gymReportingSettingsMutations.setGymReportingTimeZone(
      null,
      { input: { gymUuid: venue.uuid, timeZone: null } },
      auth(owner),
    );
    expect(await readZone()).toBe('Australia/Sydney');
  });

  it('activates forward coverage for mapped gyms only after the authorized first read', async () => {
    const owner = await user();
    const venue = await gym(owner, null);
    await board(venue);
    await db.execute(sql`UPDATE gyms SET latitude = 52.3676, longitude = 4.9041 WHERE id = ${venue.id}`);
    await expect(
      socialGymInsightsQueries.gymStats(null, { input: { gymUuid: venue.uuid } }, auth(await user()), overviewInfo),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(resolveGymAddressLocation).not.toHaveBeenCalled();
    expect(await receiptCount(venue.id)).toBe(0);
    const first = await socialGymInsightsQueries.gymStats(
      null,
      { input: { gymUuid: venue.uuid } },
      auth(owner),
      overviewInfo,
    );
    expect(first).toMatchObject({ timeZone: 'Europe/Amsterdam', timeZoneConfigured: true });
    expect(first.reachOverview?.observationStartedAt).toBeNull();
    expect(await receiptCount(venue.id)).toBe(1);
    vi.setSystemTime(new Date(Date.now() + 1000));
    expect((await report(venue)).observationStartedAt).toBeTruthy();
  });

  it('rechecks the current locked location before activating an earlier inferred scope', async () => {
    const owner = await user();
    const venue = await gym(owner, null);
    await board(venue);
    await db.execute(sql`UPDATE gyms SET latitude = 52.3676, longitude = 4.9041 WHERE id = ${venue.id}`);
    const scope = await withGymReportingScope({ gymUuid: venue.uuid }, auth(owner), async (_, scope) => scope);
    await db.execute(sql`UPDATE gyms SET latitude = null, longitude = null WHERE id = ${venue.id}`);
    await activateGymReachObservation(scope);
    expect(await receiptCount(venue.id)).toBe(0);
    expect(
      await withGymReportingScope({ gymUuid: venue.uuid }, auth(owner), async (_, scope) => scope.timeZoneConfigured),
    ).toBe(false);
  });

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

describe('gym busy times', () => {
  async function busy(
    venue: Awaited<ReturnType<typeof gym>>,
    opts: { period?: 'week' | 'month' | 'quarter'; boardUuid?: string } = {},
  ) {
    const stats = await socialGymInsightsQueries.gymStats(
      null,
      { input: { gymUuid: venue.uuid, ...opts } },
      auth(venue.ownerId),
      busyInfo,
    );
    expect(stats.reachOverview).toBeNull();
    if (!stats.busyTimes) throw new Error('Expected the requested busy-times field');
    return stats.busyTimes;
  }

  it('deduplicates repeated hours and people across sources and aliases and excludes today', async () => {
    vi.setSystemTime(new Date('2024-11-04T17:00:00Z'));
    const [owner, second, outsider] = await Promise.all([user(), user(), user()]);
    const venue = await gym(owner, 'America/New_York');
    await receipt(venue.id, '2024-10-26T00:00:00Z');
    const [wallA, wallB, privateWall] = await Promise.all([
      board(venue),
      board(venue),
      board(venue, { owner: outsider, isPublic: false }),
    ]);
    await gymReportingSettingsMutations.setGymReportingBoardAlias(
      null,
      { input: { gymUuid: venue.uuid, boardUuid: wallB.uuid, rootBoardUuid: wallA.uuid } },
      auth(owner),
    );
    await Promise.all([
      display(wallA, owner, '2024-11-03T05:15:00Z'),
      tick(wallA, owner, '2024-11-03T06:30:00Z', { status: 'attempt' }),
      tick(wallB, owner, '2024-11-03T06:30:00Z', { mirror: true }),
      tick(wallB, second, '2024-11-03T06:45:00Z'),
      tick(wallB, outsider, '2024-11-03T06:45:00Z', { origin: 'kilter_pull' }),
      tick(wallB, outsider, '2024-11-03T06:45:00Z', { capturedGym: null }),
      display(wallA, null, '2024-11-03T05:10:00Z'),
      tick(privateWall, outsider, '2024-11-03T06:45:00Z'),
      display(wallA, owner, '2024-11-04T02:00:00Z'),
      tick(wallA, outsider, '2024-11-04T05:00:00Z'),
      tick(wallA, outsider, '2024-11-04T18:00:00Z'),
      tick(wallA, outsider, '2024-10-25T22:00:00Z'),
      tick(wallA, outsider, '2023-11-05T06:30:00Z'),
    ]);
    const data = await busy(venue, { boardUuid: wallB.uuid });
    expect(data).toMatchObject({
      status: 'ready',
      startDate: '2024-08-06',
      endDate: '2024-11-03',
      coveredDates: 9,
      firstCoveredDate: '2024-10-26',
      instantDisplays: 2,
      instantTicks: 3,
      dateOnlyRecords: 0,
      unknownTimeRecords: 0,
    });
    expect(data.weekdays.map((entry) => entry.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(data.hours).toHaveLength(168);
    expect(
      data.hours.every((entry, index) => entry.hour === index % 24 && entry.dayOfWeek === Math.floor(index / 24) + 1),
    ).toBe(true);
    expect(data.weekdays[6]).toEqual({ dayOfWeek: 7, eligibleDates: 2, recordedClimbers: 2 });
    expect(data.hours[6 * 24 + 1]).toEqual({ dayOfWeek: 7, hour: 1, eligibleDates: 2, recordedClimbers: 2 });
    expect(data.hours[6 * 24 + 21]).toMatchObject({ eligibleDates: 2, recordedClimbers: 1 });
    expect(data.hours[6 * 24 + 3]).toMatchObject({ eligibleDates: 2, recordedClimbers: 0 });
    expect(JSON.stringify(data)).not.toContain(second);
    expect(await busy(venue, { boardUuid: wallA.uuid, period: 'quarter' })).toEqual(data);
  });

  it.each([
    {
      zone: 'America/New_York',
      floor: '2024-03-09T05:00:00Z',
      asOf: '2024-03-11T15:00:00Z',
      weekday: 7,
      hour: 2,
      dateCount: 2,
      expected: 0,
    },
    {
      zone: 'Australia/Lord_Howe',
      floor: '2024-10-04T13:30:00Z',
      asOf: '2024-10-06T16:00:00Z',
      weekday: 7,
      hour: 2,
      dateCount: 2,
      expected: 1,
    },
    {
      zone: 'Australia/Lord_Howe',
      floor: '2024-04-05T13:00:00Z',
      asOf: '2024-04-07T15:30:00Z',
      weekday: 7,
      hour: 1,
      dateCount: 2,
      expected: 1,
    },
    {
      zone: 'America/Havana',
      floor: '2024-11-03T04:30:00Z',
      asOf: '2024-11-04T17:00:00Z',
      weekday: 7,
      hour: 0,
      dateCount: 0,
      expected: 0,
    },
    {
      zone: 'America/Havana',
      floor: '2024-03-10T05:00:00Z',
      asOf: '2024-03-11T17:00:00Z',
      weekday: 7,
      hour: 0,
      dateCount: 1,
      expected: 0,
    },
    {
      zone: 'Pacific/Apia',
      floor: '2011-12-29T10:00:00Z',
      asOf: '2012-01-01T15:00:00Z',
      weekday: 5,
      hour: 12,
      dateCount: 3,
      expected: 0,
    },
  ])(
    'uses actual civil-hour coverage in $zone at $asOf, independent of the DB timezone',
    async ({ zone, floor, asOf, weekday, hour, dateCount, expected }) => {
      vi.setSystemTime(new Date(asOf));
      const venue = await gym(await user(), zone);
      const wall = await board(venue);
      await receipt(venue.id, floor);
      const data = await withGymReportingScope(
        { gymUuid: venue.uuid, boardUuid: wall.uuid },
        auth(venue.ownerId),
        async (tx, scope) => {
          await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Auckland'`);
          return readGymBusyTimes(tx, scope, floor);
        },
      );
      expect(data.coveredDates).toBe(dateCount);
      expect(data.hours[(weekday - 1) * 24 + hour]).toMatchObject({ eligibleDates: expected, recordedClimbers: 0 });
      if (dateCount === 0) expect(data.status).toBe('historyUnavailable');
    },
  );

  it('uses correctly dated late logs only for the weekday and reports timing loss separately', async () => {
    vi.setSystemTime(new Date('1988-10-31T21:00:00Z'));
    const owner = await user();
    const venue = await gym(owner, 'America/Goose_Bay');
    const wall = await board(venue);
    await receipt(venue.id, '1988-10-29T01:00:00Z');
    await tick(wall, owner, '1988-10-30T14:00:00Z', {
      authorDate: '1988-10-30',
      authorZone: 'Atlantic/South_Georgia',
    });
    await tick(wall, owner, '1988-10-30T15:00:00Z', {
      authorDate: '1988-10-30',
      authorZone: 'America/Goose_Bay',
    });
    await tick(wall, owner, '1988-10-30T15:00:00Z', { unknown: true });
    await tick(wall, owner, '1988-10-30T15:00:00Z', {
      origin: 'kilter_pull',
      authorDate: '1988-10-30',
      authorZone: 'America/Goose_Bay',
    });
    const data = await busy(venue);
    expect(data).toMatchObject({
      dateOnlyRecords: 2,
      unplacedDateOnlyRecords: 1,
      unknownTimeRecords: 1,
      instantTicks: 0,
    });
    expect(data.weekdays[6]).toMatchObject({ eligibleDates: 1, recordedClimbers: 1 });
    expect(data.hours.every((entry) => entry.recordedClimbers === 0)).toBe(true);
  });

  it('keeps the author-calendar budget for the identified population only', async () => {
    vi.setSystemTime(new Date('2024-02-02T15:00:00Z'));
    const [owner, anonymous, hidden] = await Promise.all([user(), user(), user()]);
    const venue = await gym(owner, 'Europe/Berlin');
    const wall = await board(venue);
    await receipt(venue.id, '2024-01-30T23:00:00Z');
    await tick(wall, owner, '2024-02-01T11:00:00Z', {
      authorDate: '2024-02-01',
      authorZone: 'Europe/Paris',
    });
    const before = await busy(venue);
    expect(before).toMatchObject({ dateOnlyRecords: 1, unplacedDateOnlyRecords: 0, unknownTimeRecords: 0 });
    expect(before.weekdays[3]).toMatchObject({ eligibleDates: 1, recordedClimbers: 1 });

    await db.execute(sql`
      INSERT INTO user_profiles (user_id, is_private, anonymous_on_foreign_boards, privacy_revision)
      VALUES (${anonymous}, false, true, 1), (${hidden}, true, false, 1)
    `);
    const pressurePrefix = `${randomUUID()}-busy-pressure-`;
    await db.execute(sql`
      WITH zones AS (
        SELECT name, row_number() OVER (ORDER BY name) AS ordinal,
          timezone(interval '0', timestamp '2024-02-01 12:00' AT TIME ZONE name) AS saved_at
        FROM pg_timezone_names
        WHERE name ~ '^(Africa|America|Antarctica|Asia|Atlantic|Australia)/[A-Za-z0-9_+/-]+$'
        ORDER BY name LIMIT 270
      ), pressure AS (
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at,
          board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution,
          reporting_time_precision, reporting_date, reporting_date_time_zone, reporting_climbed_at)
        SELECT ${pressurePrefix} || ordinal, CASE WHEN ordinal % 2 = 0 THEN ${anonymous} ELSE ${hidden} END,
          'kilter', ${CLIMB}, 40, 'send', saved_at, ${wall.id}, 'native', ${wall.id}, ${venue.id}, 'uuid',
          'day', date '2024-02-01', name, saved_at FROM zones
        RETURNING uuid, user_id
      )
      INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience, public_consent_revision)
      SELECT 'tick', uuid, user_id, 'public', 1 FROM pressure WHERE user_id = ${hidden}
    `);
    const [pressureSize] = rowsFromResult<{ count: number }>(
      await db.execute(sql`SELECT count(*)::int AS count FROM boardsesh_ticks WHERE uuid LIKE ${pressurePrefix + '%'}`),
    );
    expect(pressureSize.count).toBe(270);

    // Earlier-sorting zones would consume all 24,000 samples before Europe/Paris.
    expect(await busy(venue)).toEqual(before);

    // The same pressure from genuine identified records still exhausts the
    // budget conservatively. No authored day can produce an hourly peak.
    await db.execute(sql`UPDATE boardsesh_ticks SET user_id = ${owner} WHERE uuid LIKE ${pressurePrefix + '%'}`);
    const after = await busy(venue);
    expect(after.dateOnlyRecords).toBeGreaterThan(1);
    expect(after.unknownTimeRecords).toBeGreaterThan(0);
    expect(after.hasUnboundedUnknownTime).toBe(false);
    expect(after.hours.every((entry) => entry.recordedClimbers === 0)).toBe(true);
  }, 30_000);

  it('reports unbounded timing from an old saved timestamp without placing it on a date', async () => {
    vi.setSystemTime(new Date('2024-07-30T18:00:00Z'));
    const owner = await user();
    const venue = await gym(owner, 'UTC');
    const wall = await board(venue);
    await receipt(venue.id, '2024-07-27T00:00:00Z');
    await tick(wall, owner, '2018-01-03T09:00:00Z', { unknown: true });
    const data = await busy(venue);
    expect(data).toMatchObject({ coveredDates: 3, unknownTimeRecords: 0, hasUnboundedUnknownTime: true });
    expect([...data.weekdays, ...data.hours].every((entry) => entry.recordedClimbers === 0)).toBe(true);
    const combined = parse(
      '{ gymStats(input: { gymUuid: "fixture" }) { reachOverview { observationStartedAt } busyTimes { status } } }',
    ).definitions[0];
    if (combined.kind !== 'OperationDefinition') throw new Error('Expected a test query');
    const overviewAndBusyInfo = {
      fieldNodes: combined.selectionSet.selections,
      fragments: {},
    } as unknown as GraphQLResolveInfo;
    const dashboard = await socialGymInsightsQueries.gymStats(
      null,
      { input: { gymUuid: venue.uuid } },
      auth(owner),
      overviewAndBusyInfo,
    );
    expect(dashboard.reachOverview).toBeTruthy();
    expect(dashboard.busyTimes).toEqual(data);
  });

  it('keeps setup, no boards and not-yet-observed history distinct from mature recorded zeros', async () => {
    vi.setSystemTime(new Date('2024-07-30T18:00:00Z'));
    const owner = await user();
    const noZone = await gym(owner, null);
    await board(noZone);
    expect(await busy(noZone)).toMatchObject({ status: 'zoneRequired', startDate: null, coveredDates: 0 });
    const venue = await gym(owner, 'UTC');
    expect(await busy(venue)).toMatchObject({ status: 'historyUnavailable', startDate: '2024-05-01', coveredDates: 0 });
    await board(venue);
    expect(await busy(venue)).toMatchObject({ status: 'historyUnavailable', coveredDates: 0 });
    const mature = await gym(owner, 'UTC');
    await board(mature);
    await receipt(mature.id, OLD_FLOOR.replace('2025-', '2020-'));
    const zero = await busy(mature);
    expect(zero).toMatchObject({ status: 'ready', coveredDates: 90, firstCoveredDate: '2024-05-01' });
    expect(zero.hours.every((entry) => entry.eligibleDates >= 12 && entry.recordedClimbers === 0)).toBe(true);
  });
});
