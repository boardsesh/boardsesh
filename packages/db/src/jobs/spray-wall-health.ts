/**
 * Spray-wall health: one weekly roll-up of how the fleet's walls are doing.
 *
 * The rollout of spray walls (`docs/spray-walls.md`) answers "is it working?"
 * only from event funnels that start with somebody uploading a photo. Nothing
 * there says how the walls that DID land are living: are owners climbing on
 * them, is anyone else, are holds coming off the wall, are resets settling,
 * are reports piling up? This job measures that stock directly from the app
 * tables and returns one flat bag of integers — the payload of the backend's
 * `Spray Wall Health Weekly` event (`docs/growth-metrics.md`).
 *
 * Why an event per week and not a stats table: the reporting target is the
 * PostHog growth dashboard, and a Postgres table cannot feed it. One event a
 * week is negligible against the event budget, and the week it covers rides
 * in the payload as `weekStart`, so a CLI backfill re-emits a past week as an
 * equal event, not a silent rewrite.
 *
 * Nothing identifies a wall or a person: every field is a count. The owner's
 * identity lives only inside the aggregates (`wallsSecondClimber` counts walls
 * someone OTHER than the owner climbed this week), matching the wall telemetry
 * rule in `docs/spray-walls.md` ("Telemetry").
 *
 * Read-only: no `transact` is taken because nothing is written. The weekly
 * window is the Monday-anchored week that just ENDED, in UTC; pass `weekStart`
 * (a Monday ISO date) to re-measure an older week. The SQL below is thin; the
 * semantics all live in {@link foldSprayWallHealth}, tested without a
 * database.
 */
import { and, count, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { boardClimbEvents } from '../schema/app/board-climb-events';
import { boardseshTicks } from '../schema/app/ascents';
import { userBoards } from '../schema/app/boards';
import { sprayWallReports, sprayWallVersions, sprayWalls } from '../schema/app/spray-walls';
import { boardClimbs } from '../schema/boards/unified';
import type { JobDatabase } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every metric is a plain integer over the fleet. Fleet-level totals
 * (`litEvents`, `ticks*`) count every spray row in the window even when the
 * board is gone — the week really did have that much activity. Wall-level
 * stock (the `walls*`, `climbs*`, `holdsAlive`) reads the LIVE roster, and
 * any per-wall attribution (active, second-climber) drops rows whose board is
 * not on it. Cohorts with no population (no live walls at all) are reported
 * by the CALLER as the bare `wallsLive: 0` bag — see
 * `buildSprayWallHealthProperties` in the backend's wall-health events
 * module — so a dashboard never reads "no cohort" as "zero activity".
 */
export type SprayWallHealthMetrics = {
  // Stock of live walls (the wall row and its board both undeleted).
  wallsLive: number;
  wallsCreated: number;
  wallsGym: number;
  wallsPublic: number;
  wallsActive: number;
  wallsSecondClimber: number;
  // Climbs on live walls (listed, i.e. not drafts).
  climbsLive: number;
  climbsCreated: number;
  /** Listed climbs with at least one hold no longer installed on the wall. */
  climbsDegraded: number;
  // Lighting and logging inside the week. `lit` is board_climb_events: on a
  // wall with no LEDs this is "a climb was put on the wall", not a light write.
  litEvents: number;
  litWalls: number;
  litClimbs: number;
  ticksLogged: number;
  /** Spray ticks that are not bare attempts: flash or send. */
  ticksSends: number;
  ticksClimbers: number;
  /** Ticks written by someone other than the wall's owner. */
  ticksNonOwner: number;
  // Reset and report churn inside the week, plus the hold stock.
  resetsPublished: number;
  reportsFiled: number;
  holdsAlive: number;
};

/** The live-wall roster row the fold consumes. */
export type SprayWallRosterRow = {
  id: number;
  ownerId: string;
  gymId: number | null;
  isPublic: boolean;
  createdAt: Date;
  holdCount: number;
  layoutId: number;
  hiddenAt: Date | null;
};

export type ComputeSprayWallHealthOptions = {
  db: JobDatabase;
  signal: AbortSignal;
  /** ISO date of a Monday to measure instead of the week that just ended. */
  weekStart?: string;
};

export type SprayWallHealthRun = {
  /** ISO date of the measured week's Monday. */
  weekStart: string;
  metrics: SprayWallHealthMetrics;
};

/** A `weekStart` that is not a well-formed Monday. Never retryable. */
export class SprayWallHealthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SprayWallHealthInputError';
  }
}

/**
 * The Monday-anchored week that just ENDED, as `Date`s in UTC. Running any
 * time on a Monday resolves `end` to that morning's 00:00Z, so the morning job
 * measures the completed week rather than the one that just began.
 */
export function resolveHealthWeek(now: Date, weekStartIso?: string): { start: Date; end: Date; weekStart: string } {
  if (weekStartIso !== undefined) {
    if (!ISO_DATE.test(weekStartIso)) {
      throw new SprayWallHealthInputError(`weekStart must be YYYY-MM-DD, got ${weekStartIso}`);
    }
    const start = new Date(`${weekStartIso}T00:00:00.000Z`);
    if (start.getUTCDay() !== 1 || start.toISOString().slice(0, 10) !== weekStartIso) {
      throw new SprayWallHealthInputError(`weekStart must be a real Monday, got ${weekStartIso}`);
    }
    return { start, end: new Date(start.getTime() + 7 * DAY_MS), weekStart: weekStartIso };
  }
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - sinceMonday);
  const start = new Date(end.getTime() - 7 * DAY_MS);
  return { start, end, weekStart: start.toISOString().slice(0, 10) };
}

export type SprayWallHealthRows = {
  /** The live-wall roster. */
  walls: SprayWallRosterRow[];
  ticks: Array<{ boardId: number | null; status: string; userId: string; logged: number }>;
  lit: Array<{ boardId: number; litEvents: number; litClimbs: number }>;
  litUsers: Array<{ boardId: number; userId: string | null; litEvents: number }>;
  climbs: Array<{ layoutId: number; climbs: number; degraded: number; created: number }>;
  resetsPublished: number;
  reportsFiled: number;
};

/**
 * The whole measurement, as pure arithmetic over the rows the queries return.
 *
 * Owner-versus-guest is the load-bearing split: a second climber on somebody's
 * wall is the share-the-send story the feature is built for, so every
 * non-owner tick or lighting event counts toward `wallsSecondClimber`, and
 * events without a user (a kiosk pushing a climb) count as activity but never
 * as a second climber. A tick or event whose board left the roster stays in
 * the fleet totals — the week really had that activity — and simply cannot
 * make a deleted wall "active".
 */
export function foldSprayWallHealth(
  rows: SprayWallHealthRows,
  window: { start: Date; end: Date },
): SprayWallHealthMetrics {
  const wallById = new Map(rows.walls.map((wall) => [wall.id, wall]));

  const climbers = new Set<string>();
  let ticksLogged = 0;
  let ticksSends = 0;
  let ticksNonOwner = 0;
  const activeWalls = new Set<number>();
  const secondClimberWalls = new Set<number>();
  for (const row of rows.ticks) {
    ticksLogged += row.logged;
    if (row.status !== 'attempt') ticksSends += row.logged;
    climbers.add(row.userId);
    const wall = row.boardId === null ? undefined : wallById.get(row.boardId);
    if (!wall) continue;
    activeWalls.add(wall.id);
    if (row.userId !== wall.ownerId) {
      ticksNonOwner += row.logged;
      secondClimberWalls.add(wall.id);
    }
  }

  let litEvents = 0;
  let litClimbs = 0;
  const litWalls = new Set<number>();
  for (const row of rows.lit) {
    litEvents += row.litEvents;
    litClimbs += row.litClimbs;
    if (!wallById.has(row.boardId)) continue;
    litWalls.add(row.boardId);
    activeWalls.add(row.boardId);
  }
  for (const row of rows.litUsers) {
    if (row.userId === null) continue;
    climbers.add(row.userId);
    const wall = wallById.get(row.boardId);
    if (wall && row.userId !== wall.ownerId) secondClimberWalls.add(wall.id);
  }

  let climbsLive = 0;
  let climbsCreated = 0;
  let climbsDegraded = 0;
  // The climbs query groups by layout; only layouts still on the live roster
  // count, so a deleted wall's climbs leave the stock with it.
  const liveLayouts = new Set(rows.walls.map((wall) => wall.layoutId));
  for (const row of rows.climbs) {
    if (!liveLayouts.has(row.layoutId)) continue;
    climbsLive += row.climbs;
    climbsCreated += row.created;
    climbsDegraded += row.degraded;
  }

  let wallsCreated = 0;
  let wallsGym = 0;
  let wallsPublic = 0;
  let holdsAlive = 0;
  for (const wall of rows.walls) {
    if (wall.createdAt >= window.start && wall.createdAt < window.end) wallsCreated += 1;
    if (wall.gymId !== null) wallsGym += 1;
    // An admin-hidden wall reads private: it is still stock, just not public.
    if (wall.isPublic && wall.hiddenAt === null) wallsPublic += 1;
    holdsAlive += wall.holdCount;
  }

  return {
    wallsLive: rows.walls.length,
    wallsCreated,
    wallsGym,
    wallsPublic,
    wallsActive: activeWalls.size,
    wallsSecondClimber: secondClimberWalls.size,
    climbsLive,
    climbsCreated,
    climbsDegraded,
    litEvents,
    litWalls: litWalls.size,
    litClimbs,
    ticksLogged,
    ticksSends,
    ticksClimbers: climbers.size,
    ticksNonOwner,
    resetsPublished: rows.resetsPublished,
    reportsFiled: rows.reportsFiled,
    holdsAlive,
  };
}

export async function computeSprayWallHealth({
  db,
  signal,
  weekStart,
}: ComputeSprayWallHealthOptions): Promise<SprayWallHealthRun> {
  const { start, end, weekStart: week } = resolveHealthWeek(new Date(), weekStart);
  signal.throwIfAborted();
  // The tick and lit-event timestamp columns read as strings in the client, so
  // their window bounds go out as ISO strings; the Date-typed columns take the
  // Dates directly.
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  // The wall roster drives everything: per-wall metrics intersect with it, so
  // deleted walls drop out of every number, including events and ticks that
  // still name their board id.
  const walls = await db
    .select({
      id: userBoards.id,
      ownerId: userBoards.ownerId,
      gymId: userBoards.gymId,
      isPublic: userBoards.isPublic,
      createdAt: userBoards.createdAt,
      holdCount: sprayWalls.holdCount,
      layoutId: sprayWalls.layoutId,
      hiddenAt: sprayWalls.hiddenAt,
    })
    .from(sprayWalls)
    .innerJoin(userBoards, eq(userBoards.uuid, sprayWalls.boardUuid))
    .where(and(eq(userBoards.boardType, 'spray'), isNull(userBoards.deletedAt), isNull(sprayWalls.deletedAt)));
  signal.throwIfAborted();

  const ticks = await db
    .select({
      boardId: boardseshTicks.boardId,
      status: boardseshTicks.status,
      userId: boardseshTicks.userId,
      logged: count(),
    })
    .from(boardseshTicks)
    .where(
      and(
        eq(boardseshTicks.boardType, 'spray'),
        gte(boardseshTicks.climbedAt, startIso),
        lt(boardseshTicks.climbedAt, endIso),
      ),
    )
    .groupBy(boardseshTicks.boardId, boardseshTicks.status, boardseshTicks.userId);

  // Two reads of the same window, because two distinct-counts cannot share a
  // GROUP BY grain: per-wall climb distinctness, per-wall-and-climber
  // ownership analysis. Spray volume makes both result sets small.
  const lit = await db
    .select({
      boardId: boardClimbEvents.boardId,
      litEvents: count(),
      litClimbs: sql<number>`count(distinct ${boardClimbEvents.climbUuid})::int`,
    })
    .from(boardClimbEvents)
    .where(
      and(
        eq(boardClimbEvents.boardType, 'spray'),
        gte(boardClimbEvents.confirmedAt, startIso),
        lt(boardClimbEvents.confirmedAt, endIso),
      ),
    )
    .groupBy(boardClimbEvents.boardId);

  const litUsers = await db
    .select({
      boardId: boardClimbEvents.boardId,
      userId: boardClimbEvents.userId,
      litEvents: count(),
    })
    .from(boardClimbEvents)
    .where(
      and(
        eq(boardClimbEvents.boardType, 'spray'),
        gte(boardClimbEvents.confirmedAt, startIso),
        lt(boardClimbEvents.confirmedAt, endIso),
      ),
    )
    .groupBy(boardClimbEvents.boardId, boardClimbEvents.userId);
  signal.throwIfAborted();

  const climbs = await db
    .select({
      layoutId: boardClimbs.layoutId,
      climbs: count(),
      degraded: sql<number>`count(*) filter (where ${boardClimbs.missingHoldCount} > 0)::int`,
      created: sql<number>`count(*) filter (where ${boardClimbs.createdAt}::timestamptz >= ${startIso}::timestamptz and ${boardClimbs.createdAt}::timestamptz < ${endIso}::timestamptz)::int`,
    })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.boardType, 'spray'), sql`${boardClimbs.isDraft} IS NOT TRUE`))
    .groupBy(boardClimbs.layoutId);

  const resets = await db
    .select({ publishedCount: count() })
    .from(sprayWallVersions)
    .innerJoin(sprayWalls, eq(sprayWallVersions.wallId, sprayWalls.id))
    .where(
      and(
        eq(sprayWallVersions.status, 'published'),
        gte(sprayWallVersions.publishedAt, start),
        lt(sprayWallVersions.publishedAt, end),
        isNull(sprayWalls.deletedAt),
      ),
    );

  const reports = await db
    .select({ filedCount: count() })
    .from(sprayWallReports)
    .innerJoin(sprayWalls, eq(sprayWallReports.wallId, sprayWalls.id))
    .where(
      and(gte(sprayWallReports.createdAt, start), lt(sprayWallReports.createdAt, end), isNull(sprayWalls.deletedAt)),
    );

  return {
    weekStart: week,
    metrics: foldSprayWallHealth(
      {
        walls,
        ticks,
        lit,
        litUsers,
        climbs,
        resetsPublished: resets[0]?.publishedCount ?? 0,
        reportsFiled: reports[0]?.filedCount ?? 0,
      },
      { start, end },
    ),
  };
}
