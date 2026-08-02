import { and, eq, exists, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardClimbs, boardClimbStats } from '../../schema/boards/unified';
import { statsRowCarriesRealCatalogData } from '../climb-stats/real-catalog-data';

// Same handle type the recompute core takes: any drizzle PgDatabase (postgres-js,
// the script client, the Neon HTTP client) and the PgTransaction the backend
// resolvers run inside all satisfy it, so no cast is needed at any call site.
type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type MoonBoardTickAngleInput = {
  boardType: string;
  climbUuid: string;
  requestedAngle: number;
  /**
   * Called instead of rethrowing when the lookup fails. Injected because
   * packages/db carries no logger of its own — the backend passes its winston
   * logger, so a broken lookup is still visible even though it can never fail
   * the tick.
   */
  onError?: (error: unknown) => void;
};

/**
 * Decide which angle a tick belongs at (#3529). The single place that rule lives.
 *
 * MoonBoard identity is angle-bearing today: the catalog importer mints one
 * board_climbs row per (problem, angle) as `uuidv5('moonboard:{id}:{angle}')`,
 * each carrying a non-null `board_climbs.angle` (packages/db/scripts/
 * moonboard-catalog-helpers.ts). So a 40°-graded problem logged from a board
 * sitting at 25° arrives as "this 40° climb UUID, at angle 25" — an angle the
 * problem is not graded at and nothing renders. The recompute then seeds a stats
 * row there, and that phantom row surfaces in 25° stats-driven search with a NULL
 * grade and a 1-ascent count while the send is missing from the 40° page everyone
 * else browses. Snapping the tick to the climb's own graded angle puts the send
 * on the row every surface already reads.
 *
 * Rules, in order:
 *   (a) not MoonBoard → return requestedAngle with NO query. Kilter and Tension
 *       pay nothing; their angle genuinely is per-tick and the catalog grades
 *       every angle independently.
 *   (b) one query: the climb's own angle, its owner, plus whether a stats row
 *       carrying REAL CATALOG DATA already exists at requestedAngle.
 *   (c) climb not in board_climbs, OR the climb is USER-CREATED
 *       (board_climbs.user_id IS NOT NULL), OR board_climbs.angle IS NULL, OR a
 *       catalog-data stats row already exists at requestedAngle → return
 *       requestedAngle unchanged.
 *   (d) otherwise → return board_climbs.angle.
 *
 * The user-created fence in rule (c) is the same fence migration 0188 puts on
 * statements A and B (`bc.user_id IS NULL`), and it is here for the same reason:
 * createClimb writes a non-null board_climbs.angle plus a stats row carrying
 * only fa_username, and editClimb changes board_climbs.angle while deliberately
 * leaving the old angle's stats row in place ("removing it would race with
 * concurrent ticks"). A fa_username-only row scores FALSE under
 * statsRowCarriesRealCatalogData, so without this fence a climber ticking a
 * user-created problem at the angle it was originally set at would have their
 * tick silently rewritten to the setter's newer angle. The migration refuses to
 * touch that shape; the runtime must refuse too, or the two halves disagree.
 *
 * Rule (c) tests for CATALOG DATA, not for a row: see
 * statsRowCarriesRealCatalogData. Every affected climb in prod already has a
 * stats row at the wrong angle — that row is the bug — so a bare existence test
 * would make this function a no-op on the exact population it exists for.
 *
 * FORWARD COMPAT — when rule (d) must go:
 *   - #3851 (angle-agnostic MoonBoard import) is the trigger to retire rule (d),
 *     but it does NOT retire it by itself. #3851 writes `angle: null` only in the
 *     values it INSERTS for a brand-new climb row; its `onConflictDoUpdate`
 *     set-list on board_climbs is `{ characteristics, description }` — no
 *     `angle` — and the PR ships no migration. So a re-import leaves every
 *     existing canonical row's `board_climbs.angle` exactly as it is, and rule
 *     (c)'s `board_climbs.angle IS NULL` leg keeps not matching them. Rule (c)
 *     covers rows whose angle really is null (there is a test pinning that
 *     passthrough), which is the shape newly-imported problems arrive in.
 *     Retiring rule (d) for the rows already in the table is a deliberate code
 *     change here and in the recompute seed guards — plus a migration, if the
 *     canonical rows' angles are ever to become null.
 *   - #3849 (angle dedup) does NOT null the canonical angle. In the window after
 *     #3849 merges and before an angle-agnostic re-import, a merged problem that
 *     the catalog grades at only ONE angle keeps `angle = 40` with a single stats
 *     row, and rule (d) will snap a legitimate 25° tick on it. Whoever lands the
 *     re-import closes that window; until then this is the known cost, and it is
 *     the same cost as today's behaviour being wrong in the other direction.
 *   - #3852 (moonboard-wide-angles, flag off) deliberately lets climbers tick
 *     angles the catalog does not grade. Under rule (d) the first such tick is
 *     snapped back. Whoever lands #3852 must drop rule (d) or make it flag-aware.
 *
 * NEVER THROWS on any path, and that is load-bearing: a non-retryable GraphQL
 * error dead-letters immediately in the offline drainer, so a hiccup here would
 * cost a climber a send. A missing climb, a NULL angle and a DB error all fall
 * back to requestedAngle — the exact behaviour we have today.
 */
export async function resolveMoonBoardTickAngle(
  db: DrizzleDb,
  { boardType, climbUuid, requestedAngle, onError }: MoonBoardTickAngleInput,
): Promise<number> {
  if (boardType !== 'moonboard') return requestedAngle;

  try {
    const [climb] = await db
      .select({
        gradedAngle: boardClimbs.angle,
        ownerUserId: boardClimbs.userId,
        catalogDataAtRequestedAngle: exists(
          db
            .select({ present: sql`1` })
            .from(boardClimbStats)
            .where(
              and(
                eq(boardClimbStats.boardType, boardType),
                eq(boardClimbStats.climbUuid, climbUuid),
                eq(boardClimbStats.angle, requestedAngle),
                statsRowCarriesRealCatalogData(),
              ),
            ),
        ).mapWith(Boolean),
      })
      .from(boardClimbs)
      .where(and(eq(boardClimbs.uuid, climbUuid), eq(boardClimbs.boardType, boardType)))
      .limit(1);

    if (!climb) return requestedAngle;
    if (climb.ownerUserId != null) return requestedAngle;
    if (climb.gradedAngle == null) return requestedAngle;
    if (climb.catalogDataAtRequestedAngle) return requestedAngle;

    return climb.gradedAngle;
  } catch (error) {
    // Reported, never rethrown: the tick saves at the angle the client sent,
    // which is exactly today's behaviour. Failing a send over an angle lookup
    // would be strictly worse than the bug this fixes.
    onError?.(error);
    return requestedAngle;
  }
}
