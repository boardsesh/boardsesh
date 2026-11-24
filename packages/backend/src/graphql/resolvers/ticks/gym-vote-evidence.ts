import { and, eq } from 'drizzle-orm';
import { gymReportingTickVotes, type BoardseshTick } from '@boardsesh/db/schema';
import type { TickReportingVoteField } from '@boardsesh/shared-schema';
import type { GymReportingTransaction } from '../social/gym-reporting';

/** Called only under the native writer's tick lock or immediately after the new row insert. */
export async function attestGymTickVotes(
  tx: GymReportingTransaction,
  tick: BoardseshTick,
  fields: readonly TickReportingVoteField[],
): Promise<void> {
  if (
    fields.length === 0 ||
    tick.origin !== 'native' ||
    tick.kilterDetachedAt !== null ||
    tick.boardId === null ||
    tick.boardId !== tick.reportingBoardId ||
    tick.reportingGymId === null ||
    tick.reportingAttribution === null ||
    tick.reportingTimePrecision === null ||
    tick.reportingClimbedAt !== tick.climbedAt
  ) {
    return;
  }

  for (const metric of fields) {
    const attestedValue = metric === 'QUALITY' ? tick.quality : tick.difficulty;
    if (attestedValue === null) {
      await tx
        .delete(gymReportingTickVotes)
        .where(and(eq(gymReportingTickVotes.tickId, tick.id), eq(gymReportingTickVotes.metric, metric)));
      continue;
    }
    await tx
      .insert(gymReportingTickVotes)
      .values({ tickId: tick.id, metric, attestedValue })
      .onConflictDoUpdate({
        target: [gymReportingTickVotes.tickId, gymReportingTickVotes.metric],
        set: { attestedValue },
      });
  }
}
