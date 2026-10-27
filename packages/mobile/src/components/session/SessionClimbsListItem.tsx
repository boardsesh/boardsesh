// One row of the session detail's Climbs list: a tick, or, on a workout session
// (#6903), a block's section row, a 4x4 set, a skipped climb, or the "Off plan"
// and crew labels. Every branch is a memoized row, so FlashList recycling stays
// cheap.

import type { SessionDetailTick, SessionFeedParticipant } from '@boardsesh/shared-schema';
import { SessionTickRow } from './SessionTickRow';
import {
  WorkoutBlockSectionRow,
  WorkoutListSectionLabel,
  WorkoutSetRow,
  WorkoutSkippedClimbRow,
} from './workout/WorkoutClimbsListRows';
import type { WorkoutClimbsRow } from './workout/workout-climb-rows';

type SessionClimbsListItemProps = {
  row: WorkoutClimbsRow;
  isMultiUser: boolean;
  participantById: ReadonlyMap<string, SessionFeedParticipant>;
  onPress: (tick: SessionDetailTick) => void;
};

export function SessionClimbsListItem({ row, isMultiUser, participantById, onPress }: SessionClimbsListItemProps) {
  switch (row.type) {
    case 'tick':
      return (
        <SessionTickRow
          tick={row.tick}
          isMultiUser={isMultiUser}
          participant={participantById.get(row.tick.userId)}
          onPress={onPress}
        />
      );
    case 'block':
      return <WorkoutBlockSectionRow stage={row.stage} />;
    case 'set':
      return (
        <WorkoutSetRow
          climb={row.climb}
          setNumber={row.setNumber}
          repsPerSet={row.repsPerSet}
          tick={row.tick}
          onPress={onPress}
        />
      );
    case 'skipped':
      return <WorkoutSkippedClimbRow climb={row.climb} />;
    case 'offPlan':
      return <WorkoutListSectionLabel kind="offPlan" count={row.count} />;
    case 'crew':
      return <WorkoutListSectionLabel kind="crew" count={row.count} />;
  }
}
