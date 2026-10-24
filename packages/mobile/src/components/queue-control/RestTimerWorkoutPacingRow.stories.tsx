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

const FOUR_BY_FOUR: RestTimerStagePacing = {
  sessionId: STORY_SESSION_ID,
  stageId: 'story-4x4',
  kind: 'fourByFour',
  queueItemUuid: 'story-climb-a1',
  mode: 'afterTick',
  targetSeconds: 10,
  advanceOn: 'tick',
  closesRound: false,
  stagePacing: { mode: 'afterTick', restSeconds: 0, restBetweenRoundsSeconds: 30, advanceOn: 'tick' },
};

const FOUR_BY_FOUR_ROUND_END: RestTimerStagePacing = {
  ...FOUR_BY_FOUR,
  queueItemUuid: 'story-climb-b1',
  targetSeconds: 30,
  closesRound: true,
};

const LIMIT: RestTimerStagePacing = {
  sessionId: STORY_SESSION_ID,
  stageId: 'story-limit',
  kind: 'limitBouldering',
  queueItemUuid: 'story-climb-l1',
  mode: 'afterTick',
  targetSeconds: 180,
  advanceOn: 'send',
  closesRound: false,
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
  closesRound: false,
  stagePacing: { mode: 'onTheMinute', restSeconds: 15 },
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
      name: 'Rest timer sheet, 4x4 climb (0:10 changeover)',
      render: () => <StagePacedSheet stage={FOUR_BY_FOUR} />,
    },
    sheetFourByFourRoundEnd: {
      name: 'Rest timer sheet, last climb of a 4x4 round (0:30 round rest)',
      render: () => <StagePacedSheet stage={FOUR_BY_FOUR_ROUND_END} />,
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
        </>
      ),
    },
  },
};

export default stories;
