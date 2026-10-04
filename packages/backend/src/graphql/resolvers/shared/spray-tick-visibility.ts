import type { SQL } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { sprayReferenceClimbExistsCondition } from '@boardsesh/db/queries';

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
