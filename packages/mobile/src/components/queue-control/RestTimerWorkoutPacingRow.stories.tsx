import { useEffect, useState } from 'react';
import type { SessionUser } from '@boardsesh/shared-schema';
import type { ScenarioOverrides } from '../../dev/stories/scenario-overrides';
import type { StoryModule } from '../../dev/stories/types';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import { nowMs } from '../../lib/clock';
import type { RestTimerStagePacing } from '../../lib/rest-timer-pacing';
import {
  applyRestTimerStagePacing,
  armRestTimer,
  disarmRestTimer,
  noteRestTimerTick,
} from '../../lib/rest-timer-store';
import { RestTimerSheet } from './RestTimerSheet';
import { RestTimerWorkoutPacingRow } from './RestTimerWorkoutPacingRow';

// "Set by your workout" (#5380, #6231). The timed blocks are not offered yet, so
// nothing in the app reaches this state: these stories put a stage pacing in the
// rest-timer store themselves (in the app only RestTimerPacingSync writes it),
// arm the timer with a tick 20 s ago, and open the real sheet. The tick names no
// queue item, so a tick or send stage can never move the wall from here; the
// on-the-minute story would beat after its interval, on an empty queue.

const STORY_SESSION_ID = 'story-workout-session';

// Triples with 0:45 between reps, after rep 2 of 3.
const FOUR_BY_FOUR: RestTimerStagePacing = {
  sessionId: STORY_SESSION_ID,
  stageId: 'story-4x4',
  kind: 'fourByFour',
  queueItemUuid: 'story-climb-a1',
  mode: 'afterTick',
  targetSeconds: 45,
  advanceOn: 'tick',
  closesSet: false,
  reps: { logged: 2, perSet: 3 },
  stagePacing: {
    mode: 'afterTick',
    restSeconds: 45,
    advanceOn: 'set',
    sets: { repsPerSet: 3, restBetweenSetsSeconds: 30 },
  },
};

// The same set with its last rep logged: the set rest.
const FOUR_BY_FOUR_SET_END: RestTimerStagePacing = {
  ...FOUR_BY_FOUR,
  targetSeconds: 30,
  closesSet: true,
  reps: { logged: 3, perSet: 3 },
};

const LIMIT: RestTimerStagePacing = {
  sessionId: STORY_SESSION_ID,
  stageId: 'story-limit',
  kind: 'limitBouldering',
  queueItemUuid: 'story-climb-l1',
  mode: 'afterTick',
  targetSeconds: 180,
  advanceOn: 'send',
  closesSet: false,
  stagePacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
};

const ON_THE_MINUTE: RestTimerStagePacing = {
  sessionId: STORY_SESSION_ID,
  stageId: 'story-emom',
  kind: 'onTheMinute',
  queueItemUuid: 'story-climb-e1',
  mode: 'onTheMinute',
  targetSeconds: 15,
  advanceOn: 'deadline',
  closesSet: false,
  stagePacing: { mode: 'onTheMinute', restSeconds: 15 },
};

const COOL_DOWN: RestTimerStagePacing = {
  sessionId: STORY_SESSION_ID,
  stageId: 'story-cool-down',
  kind: 'warmUp',
  queueItemUuid: 'story-climb-c1',
  mode: 'afterTick',
  targetSeconds: 30,
  advanceOn: 'tick',
  closesSet: false,
  isCoolDown: true,
  stagePacing: { mode: 'afterTick', restSeconds: 30, advanceOn: 'tick' },
};

const CREW: SessionUser[] = [
  { id: 'story-me', username: 'You', isLeader: true, connectionState: 'CONNECTED' },
  { id: 'story-sam', username: 'Sam', isLeader: false, userId: 'story-sam-user', connectionState: 'CONNECTED' },
];

// Sam holds the wall, so this phone's timer must not move it, stage or not.
const PASSENGER_IN_A_CREW: ScenarioOverrides = {
  queue: { isSharedSession: false, isCrewSession: true, sessionId: 'story-crew-session', sessionUsers: CREW },
};

function StagePacedSheet({ stage }: { stage: RestTimerStagePacing }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const startedAtMs = nowMs();
    applyRestTimerStagePacing(stage, startedAtMs, 'none');
    // A pre-session arm (no session id): the story app has no session, and the
    // session sync turns off an arm whose session is gone.
    armRestTimer(stage.mode, startedAtMs, null);
    noteRestTimerTick(new Date(startedAtMs - 20_000).toISOString(), stage.mode, startedAtMs, {
      status: 'send',
      queueItemUuid: null,
    });
    return () => {
      disarmRestTimer();
      applyRestTimerStagePacing(null, nowMs(), 'none');
    };
  }, [stage]);

  return <RestTimerSheet visible={visible} onClose={() => setVisible(false)} />;
}

const stories: StoryModule = {
  title: 'Rest timer / Set by your workout',
  stories: {
    sheetFourByFour: {
      name: 'Rest timer sheet, 4x4 between reps (0:45)',
      render: () => <StagePacedSheet stage={FOUR_BY_FOUR} />,
    },
    sheetFourByFourSetEnd: {
      name: 'Rest timer sheet, 4x4 after a set’s last rep (0:30 set rest)',
      render: () => <StagePacedSheet stage={FOUR_BY_FOUR_SET_END} />,
    },
    sheetLimit: {
      name: 'Rest timer sheet, limit bouldering',
      render: () => <StagePacedSheet stage={LIMIT} />,
    },
    sheetOnTheMinute: {
      name: 'Rest timer sheet, on the minute every 0:15',
      render: () => <StagePacedSheet stage={ON_THE_MINUTE} />,
    },
    sheetPassenger: {
      name: 'Rest timer sheet, limit bouldering, crew passenger',
      overrides: PASSENGER_IN_A_CREW,
      render: () => <StagePacedSheet stage={LIMIT} />,
    },
    rows: {
      name: 'The workout row, every timed block',
      render: () => (
        <>
          <StoryVariant label="4x4">
            <StorySurface>
              <RestTimerWorkoutPacingRow stage={FOUR_BY_FOUR} />
            </StorySurface>
          </StoryVariant>
          <StoryVariant label="Limit bouldering">
            <StorySurface>
              <RestTimerWorkoutPacingRow stage={LIMIT} />
            </StorySurface>
          </StoryVariant>
          <StoryVariant label="On the minute">
            <StorySurface>
              <RestTimerWorkoutPacingRow stage={ON_THE_MINUTE} />
            </StorySurface>
          </StoryVariant>
          <StoryVariant label="Cool-down">
            <StorySurface>
              <RestTimerWorkoutPacingRow stage={COOL_DOWN} />
            </StorySurface>
          </StoryVariant>
        </>
      ),
    },
  },
};

export default stories;
