import assert from 'node:assert/strict';
import test from 'node:test';
import {
  foldSprayWallHealth,
  resolveHealthWeek,
  SprayWallHealthInputError,
  type SprayWallHealthRows,
  type SprayWallRosterRow,
} from '../spray-wall-health';

/**
 * The weekly roll-up's arithmetic, pinned without a database (issue #6062).
 *
 * `computeSprayWallHealth`'s SQL is proven against the restricted batch login
 * in the backend's grant test; the SEMANTICS — who counts as a second
 * climber, what a deleted wall does to the stock, what absence means — are
 * this fold, and they are what a wrong number on the growth dashboard would
 * actually trace back to.
 */

const WINDOW = { start: new Date('2026-09-28T00:00:00.000Z'), end: new Date('2026-10-05T00:00:00.000Z') };

function rosterRow(overrides: Partial<SprayWallRosterRow> & { id: number }): SprayWallRosterRow {
  return {
    ownerId: 'owner-1',
    gymId: null,
    isPublic: true,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    holdCount: 50,
    layoutId: 7000 + overrides.id,
    hiddenAt: null,
    ...overrides,
  };
}

const EMPTY: SprayWallHealthRows = {
  walls: [],
  ticks: [],
  lit: [],
  litUsers: [],
  climbs: [],
  resetsPublished: 0,
  reportsFiled: 0,
};

void test('resolveHealthWeek measures the week that ended on the most recent Monday', () => {
  // Mid-week: a Wednesday afternoon run still measures LAST week.
  const midweek = resolveHealthWeek(new Date('2026-10-01T13:00:00.000Z'));
  assert.equal(midweek.weekStart, '2026-09-21');
  assert.equal(midweek.start.toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(midweek.end.toISOString(), '2026-09-28T00:00:00.000Z');

  // The Monday morning the job actually runs on: the week ending that morning.
  const mondayRun = resolveHealthWeek(new Date('2026-10-05T08:45:00.000Z'));
  assert.equal(mondayRun.weekStart, '2026-09-28');
  assert.equal(mondayRun.end.toISOString(), '2026-10-05T00:00:00.000Z');
});

void test('resolveHealthWeek takes an explicit Monday for backfills and rejects anything else', () => {
  const backfill = resolveHealthWeek(new Date(), '2026-08-03');
  assert.equal(backfill.weekStart, '2026-08-03');
  assert.equal(backfill.start.toISOString(), '2026-08-03T00:00:00.000Z');

  // A Tuesday would silently measure a rolling 7 days, mislabeled as a week.
  assert.throws(() => resolveHealthWeek(new Date(), '2026-08-04'), SprayWallHealthInputError);
  assert.throws(() => resolveHealthWeek(new Date(), 'last monday'), SprayWallHealthInputError);
  // 2026-02-30 would die on the Date constructor instead of the format test.
  assert.throws(() => resolveHealthWeek(new Date(), '2026-02-30'), SprayWallHealthInputError);
});

void test('empty roster is the no-cohort shape: zeros here, absence at the caller', () => {
  const metrics = foldSprayWallHealth(EMPTY, WINDOW);
  assert.equal(metrics.wallsLive, 0);
  assert.equal(metrics.litEvents, 0);
  assert.equal(metrics.ticksClimbers, 0);
  assert.equal(metrics.holdsAlive, 0);
});

void test('owner ticks make a wall active, guest ticks also make it a second-climber wall', () => {
  const walls = [rosterRow({ id: 1, ownerId: 'owner-1' }), rosterRow({ id: 2, ownerId: 'owner-2' })];
  const metrics = foldSprayWallHealth(
    {
      ...EMPTY,
      walls,
      ticks: [
        { boardId: 1, status: 'send', userId: 'owner-1', logged: 3 },
        { boardId: 2, status: 'attempt', userId: 'guest-9', logged: 1 },
      ],
    },
    WINDOW,
  );
  assert.equal(metrics.ticksLogged, 4);
  assert.equal(metrics.ticksSends, 3); // the bare attempt is not a send
  assert.equal(metrics.ticksClimbers, 2);
  assert.equal(metrics.ticksNonOwner, 1);
  assert.equal(metrics.wallsActive, 2);
  assert.equal(metrics.wallsSecondClimber, 1);
});

void test('activity on a deleted board stays in the fleet totals but off every wall', () => {
  const metrics = foldSprayWallHealth(
    {
      ...EMPTY,
      walls: [rosterRow({ id: 1 })],
      ticks: [
        { boardId: 1, status: 'flash', userId: 'owner-1', logged: 2 },
        { boardId: 99, status: 'send', userId: 'ghost-1', logged: 5 }, // board deleted mid-week
        { boardId: null, status: 'send', userId: 'ghost-2', logged: 1 }, // imported tick, no board
      ],
      lit: [{ boardId: 99, litEvents: 4, litClimbs: 2 }],
    },
    WINDOW,
  );
  assert.equal(metrics.ticksLogged, 8); // everything in the window counts
  assert.equal(metrics.ticksClimbers, 3);
  assert.equal(metrics.litEvents, 4);
  assert.equal(metrics.wallsActive, 1); // only the live wall
  assert.equal(metrics.litWalls, 0); // its lit rows are on the deleted board
  assert.equal(metrics.wallsSecondClimber, 0); // the ghost sends were not on a live wall
});

void test('kiosk lighting events count as activity, never as a second climber', () => {
  const metrics = foldSprayWallHealth(
    {
      ...EMPTY,
      walls: [rosterRow({ id: 1, ownerId: 'owner-1' })],
      lit: [{ boardId: 1, litEvents: 6, litClimbs: 4 }],
      litUsers: [
        { boardId: 1, userId: null, litEvents: 6 }, // push-mode kiosk, no climber behind it
      ],
    },
    WINDOW,
  );
  assert.equal(metrics.wallsActive, 1);
  assert.equal(metrics.litWalls, 1);
  assert.equal(metrics.wallsSecondClimber, 0);
  assert.equal(metrics.ticksClimbers, 0);
});

void test('a guest lighting a wall counts as a second climber without any tick', () => {
  const metrics = foldSprayWallHealth(
    {
      ...EMPTY,
      walls: [rosterRow({ id: 1, ownerId: 'owner-1' })],
      litUsers: [{ boardId: 1, userId: 'guest-3', litEvents: 1 }],
    },
    WINDOW,
  );
  assert.equal(metrics.wallsSecondClimber, 1);
  assert.equal(metrics.ticksClimbers, 1);
});

void test('stock reads the roster with its quirks: gyms, hidden walls, birth weeks, dead layouts', () => {
  const walls = [
    rosterRow({ id: 1, gymId: 12, createdAt: new Date('2026-10-01T09:00:00.000Z'), holdCount: 100 }),
    // Public but admin-hidden: stock counts it, wallsPublic does not.
    rosterRow({ id: 2, isPublic: true, hiddenAt: new Date('2026-09-30T00:00:00.000Z') }),
    rosterRow({ id: 3, isPublic: false, holdCount: 20 }),
  ];
  const metrics = foldSprayWallHealth(
    {
      ...EMPTY,
      walls,
      climbs: [
        { layoutId: 7001, climbs: 9, degraded: 2, created: 4 }, // live
        { layoutId: 7002, climbs: 5, degraded: 1, created: 1 }, // live
        { layoutId: 7003, climbs: 5, degraded: 1, created: 1 }, // live
        { layoutId: 4242, climbs: 7, degraded: 7, created: 7 }, // deleted wall's layout
      ],
    },
    WINDOW,
  );
  assert.equal(metrics.wallsLive, 3);
  assert.equal(metrics.wallsCreated, 1); // only id 1 was born inside the week
  assert.equal(metrics.wallsGym, 1);
  assert.equal(metrics.wallsPublic, 1); // id 1 (id 2 is hidden, id 3 is private)
  assert.equal(metrics.climbsLive, 19); // the dead layout's 7 climbs are gone with it
  assert.equal(metrics.climbsCreated, 6);
  assert.equal(metrics.climbsDegraded, 4);
  assert.equal(metrics.holdsAlive, 170);
});
