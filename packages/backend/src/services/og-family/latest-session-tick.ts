import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';
import { sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
import { db } from '../../db/client';
import { sessionTickVisibleCondition } from '../../graphql/resolvers/shared/activity-privacy';
import { sprayTickClimbExistsCondition } from '../../graphql/resolvers/shared/spray-tick-visibility';
import { canAccessResource } from '../privacy';
import type { BoardConfig } from './card-model';

/**
 * How many of a session's newest ticks are considered. The privacy rules are
 * correlated subqueries, so applying them across a whole session cost as much as
 * `sessionDetail` (measured: 951ms against 992ms on 3,000 ticks). A session whose
 * newest 50 ticks are all hidden draws the unlit board, which is still true.
 */
const NEWEST_TICKS_CONSIDERED = 50;

/**
 * The frames of a session's newest tick a stranger may see on this board, or null.
 *
 * The invite card draws one tick, and `sessionDetail` builds every tick of the
 * session plus votes, clips and attempt totals to answer that, in front of every
 * cache. This is one bounded row with the same anonymous rules applied where the
 * row is chosen, so the next visible tick is picked rather than the newest being
 * dropped afterwards: session access, the tick's privacy (which also hides a tick
 * on someone's draft climb from a stranger) and the spray-wall rule.
 *
 * A policy read, so the primary: a lagging replica must not restore a revoked tick.
 */
export async function readLatestSessionTickFrames(sessionId: string, board: BoardConfig): Promise<string | null> {
  if (!(await canAccessResource('session', sessionId, undefined))) return null;

  const ticks = dbSchema.boardseshTicks;
  const climbs = dbSchema.boardClimbs;
  const aliases = dbSchema.boardClimbAliases;
  const newestTicks = alias(ticks, 'og_family_newest_ticks');

  const [latest] = await db
    .select({ frames: climbs.frames })
    .from(ticks)
    // Same alias resolution as `sessionDetail`: a tick can point at a climb that
    // was deduplicated away.
    .leftJoin(aliases, and(eq(ticks.climbUuid, aliases.aliasUuid), eq(ticks.boardType, aliases.boardType)))
    .innerJoin(
      climbs,
      and(
        sql`COALESCE(${aliases.canonicalUuid}, ${ticks.climbUuid}) = ${climbs.uuid}`,
        eq(ticks.boardType, climbs.boardType),
      ),
    )
    .where(
      and(
        inArray(
          ticks.uuid,
          db
            .select({ uuid: newestTicks.uuid })
            .from(newestTicks)
            .where(and(eq(newestTicks.sessionId, sessionId), eq(newestTicks.boardType, board.boardName)))
            .orderBy(desc(newestTicks.climbedAt))
            .limit(NEWEST_TICKS_CONSIDERED),
        ),
        // Frames from another layout would light meaningless holds.
        eq(climbs.layoutId, board.layoutId),
        isNotNull(climbs.frames),
        sessionTickVisibleCondition(null),
        sprayClimbVisibilityCondition({ boardType: climbs.boardType, layoutId: climbs.layoutId }, null),
        sprayTickClimbExistsCondition(null),
      ),
    )
    .orderBy(desc(ticks.climbedAt))
    .limit(1);

  return latest?.frames ?? null;
}
