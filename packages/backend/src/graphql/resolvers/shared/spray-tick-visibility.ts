import { sql, type SQL } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { sprayReferenceClimbExistsCondition, sprayReferenceVisibilityCondition } from '@boardsesh/db/queries';

/**
 * The fail-closed half of the spray wall rule for a reader that lists TICKS and
 * LEFT JOINs `board_climbs`.
 *
 * Those readers gate with `sprayClimbVisibilityCondition` on the joined climb
 * columns, which starts `board_type IS DISTINCT FROM 'spray'`. That is true when
 * the join found no row, on purpose: a tick whose climb is missing renders as
 * "Unknown Climb", and an Aurora tick can arrive before its climb. For a spray
 * tick it is wrong. `deleteDraftClimb` and account deletion hard-delete a climb
 * and leave its ticks, there is then no wall to check, and "no climb row" read
 * as "not a spray climb", so the log reached everybody (#6031).
 *
 * The tick still carries `board_type = 'spray'`, so this keys on the tick: a
 * spray tick is returned only while its climb row exists, or to the climber who
 * logged it. Their own logbook keeps the entry. Every other board type passes
 * untouched.
 *
 * AND it next to `sprayClimbVisibilityCondition`; it does not replace it. Pass
 * null for an anonymous caller, never a hopeful id.
 */
export function sprayTickClimbExistsCondition(viewerUserId: string | null | undefined): SQL {
  return sprayReferenceClimbExistsCondition(
    { boardType: dbSchema.boardseshTicks.boardType, climbUuid: dbSchema.boardseshTicks.climbUuid },
    { authorId: dbSchema.boardseshTicks.userId, viewerUserId },
  );
}

/**
 * The WHOLE spray wall rule for a tick, for raw SQL that SELECTS a tick before
 * it joins `board_climbs`: the session feed's hardest send, its daily highlight
 * and its featured beta.
 *
 * Those queries rank ticks in a CTE and hydrate the winner afterwards. A wall
 * rule in the hydrating JOIN only nulls the climb's columns: the tick that was
 * picked still comes back with its own uuid, climb uuid and comment, and a beta
 * link with its url. So the rule has to sit where the tick is CHOSEN, and then
 * the next visible one is picked instead (#6031).
 *
 * True for a tick on any other board. For a spray tick: the viewer can see the
 * wall (the reference form), and the climb row still exists or the viewer logged
 * the tick themselves.
 *
 * `tickAlias` is the tick's alias in the surrounding SQL. A closed set of
 * literals, never caller input, because it is spliced in raw.
 */
export function sprayTickVisibleSql(tickAlias: 't' | 'dt', viewerUserId: string | null | undefined): SQL {
  const boardType = sql.raw(`${tickAlias}.board_type`);
  const climbUuid = sql.raw(`${tickAlias}.climb_uuid`);
  const authorId = sql.raw(`${tickAlias}.user_id`);
  return sql`(
    ${boardType} IS DISTINCT FROM 'spray'
    OR (
      ${sprayReferenceVisibilityCondition({ boardType, climbUuid }, viewerUserId)}
      AND ${sprayReferenceClimbExistsCondition({ boardType, climbUuid }, { authorId, viewerUserId })}
    )
  )`;
}
