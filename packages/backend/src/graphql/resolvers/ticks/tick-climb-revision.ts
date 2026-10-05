import { and, eq, lte, max } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';

/**
 * Which revision of a climb a new tick is stored against (#6023).
 *
 * A published climb can be edited, on a spray wall without limit, so "I sent
 * this" needs to say which version of it. `boardsesh_ticks.climb_revision` holds
 * a `board_climbs.revision_number`: 1 for a climb nobody has edited, NULL when
 * the revision is not known.
 *
 * The client is the better witness, because it knows what it drew: a send logged
 * offline on revision 3 and drained after the setter saved revision 4 was still
 * climbed on 3. The server's own answer, "the revision that was live at
 * `climbedAt`", is the fallback for a client that does not send one.
 *
 * No integer the client sends may fail a tick. A refusal that is not retryable
 * dead-letters the send in the offline drainer, and a wrong revision number
 * costs far less than a lost send. Every doubtful value is replaced, never
 * rejected. (A value that is not an integer at all never gets this far: the
 * GraphQL `Int` scalar refuses it as a malformed request, like any other field.)
 */

export type TickClimbRevisionDecision = {
  /**
   * The client named a revision the climb has not reached, and it was replaced.
   * Not a reason to fail anything; the caller logs it.
   */
  clientRevisionAhead: boolean;
} & (
  | {
      /** Store this value as it is. Null is "unknown". */
      kind: 'store';
      revision: number | null;
    }
  | {
      /**
       * Store the revision that was live when the climb was climbed, which takes
       * a read of `board_climb_revisions`.
       */
      kind: 'live-at-climbed-at';
    }
);

/**
 * Decide what to store from what is already in hand, without touching the
 * database.
 *
 * | Case | Result |
 * | --- | --- |
 * | No `board_climbs` row | store NULL |
 * | The client's uuid was an alias of another climb | the fallback |
 * | Client sent r, 1 <= r <= current | store r |
 * | Client sent r > current | the fallback, with `clientRevisionAhead` set |
 * | Nothing sent | the fallback |
 *
 * The fallback is 1 outright when the climb is still on revision 1, and a lookup
 * by date otherwise.
 *
 * An in-range r is stored even when its revision row has been pruned past the
 * cap: the number is still true, there is only nothing left to show for it.
 *
 * A client revision is not trusted across an alias. Revision numbers belong to
 * one `board_climbs` row, and the client counted them on the retired row, not on
 * the canonical one the tick is about to be stored under.
 */
export function decideTickClimbRevision(params: {
  /** `board_climbs.revision_number` of the canonical climb. Null when there is no such row. */
  currentRevision: number | null;
  /** What the client sent, after validation. Null or undefined when it sent nothing usable. */
  clientRevision: number | null | undefined;
  /** Whether the uuid the client named was resolved to a different, canonical one. */
  aliasRemapped: boolean;
}): TickClimbRevisionDecision {
  const { currentRevision, clientRevision, aliasRemapped } = params;
  if (currentRevision == null) return { kind: 'store', revision: null, clientRevisionAhead: false };

  const usableClientRevision = aliasRemapped ? null : (clientRevision ?? null);
  const clientRevisionAhead = usableClientRevision != null && usableClientRevision > currentRevision;
  if (usableClientRevision != null && usableClientRevision >= 1 && !clientRevisionAhead) {
    return { kind: 'store', revision: usableClientRevision, clientRevisionAhead };
  }

  // Never edited: the only revision there has ever been.
  if (currentRevision <= 1) return { kind: 'store', revision: 1, clientRevisionAhead };
  return { kind: 'live-at-climbed-at', clientRevisionAhead };
}

/**
 * The value for `boardsesh_ticks.climb_revision` on a tick about to be inserted.
 *
 * One primary-key read of `board_climbs` in every case. A second read, of
 * `board_climb_revisions`, only for an edited climb whose client sent no usable
 * revision: the highest revision created at or before `climbedAt`, or 1 when the
 * tick predates them all.
 *
 * A database error propagates, like `resolveCanonicalClimbUuid`'s. It reaches
 * the client as the masked `INTERNAL_SERVER_ERROR`, which the offline drainer
 * classifies as retryable (`isRetryable` in `@boardsesh/offline-sync`), and a
 * replay is idempotent on the tick uuid, so the send is delivered again and
 * stamped properly. Storing NULL instead would save the tick now and leave it
 * without a revision for good, to spare a retry that costs nothing.
 */
export async function resolveTickClimbRevision(params: {
  boardType: string;
  /** The uuid the client sent. */
  inputClimbUuid: string;
  /** The uuid the tick is stored under, after alias resolution. */
  canonicalClimbUuid: string;
  clientRevision: number | null | undefined;
  /** The tick's `climbedAt` as stored: UTC, ISO 8601. */
  climbedAt: string;
}): Promise<number | null> {
  const { boardType, inputClimbUuid, canonicalClimbUuid, clientRevision, climbedAt } = params;
  const [climb] = await db
    .select({ revisionNumber: dbSchema.boardClimbs.revisionNumber })
    .from(dbSchema.boardClimbs)
    .where(and(eq(dbSchema.boardClimbs.uuid, canonicalClimbUuid), eq(dbSchema.boardClimbs.boardType, boardType)))
    .limit(1);

  const decision = decideTickClimbRevision({
    currentRevision: climb?.revisionNumber ?? null,
    clientRevision,
    aliasRemapped: canonicalClimbUuid !== inputClimbUuid,
  });
  if (decision.clientRevisionAhead) {
    logger.warn(
      `[saveTick] client sent climbRevision=${clientRevision} past the current ${climb?.revisionNumber} — ` +
        (decision.kind === 'store' ? `storing ${decision.revision}` : 'storing the revision live at climbedAt') +
        `: ${boardType}/${canonicalClimbUuid}`,
    );
  }
  if (decision.kind === 'store') return decision.revision;

  const [liveAtClimbedAt] = await db
    .select({ revisionNumber: max(dbSchema.boardClimbRevisions.revisionNumber) })
    .from(dbSchema.boardClimbRevisions)
    .where(
      and(
        eq(dbSchema.boardClimbRevisions.climbUuid, canonicalClimbUuid),
        eq(dbSchema.boardClimbRevisions.boardType, boardType),
        lte(dbSchema.boardClimbRevisions.createdAt, new Date(climbedAt)),
      ),
    );
  return liveAtClimbedAt?.revisionNumber ?? 1;
}
