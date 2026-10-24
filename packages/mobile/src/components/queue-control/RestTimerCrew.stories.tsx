import { useEffect, useState } from 'react';
import type { SessionUser } from '@boardsesh/shared-schema';
import type { ScenarioOverrides } from '../../dev/stories/scenario-overrides';
import type { StoryModule } from '../../dev/stories/types';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import { useQueueSessionId } from '../../providers/queue-provider';
import { nowMs } from '../../lib/clock';
import { handleCrewCadenceChange } from '../../lib/crew-rest-cadence';
import { disarmRestTimer } from '../../lib/rest-timer-store';
import { RestTimerHeroClock, RestTimerPill } from './RestTimerPill';
import { RestTimerSheet } from './RestTimerSheet';

// The rest timer in a crew (#5382). A simulator is one participant, so these
// stories fake the rest: a crew (ScenarioOverrides.queue), who holds the wall
// (ScenarioOverrides.wall) and the crew's clock, taken the way the session's
// subscribe seed would hand it over. The clock was set by Sam 40 s ago: two
// minutes on the minute, moving the wall. Nothing exists on the server under
// the story session, so nothing a story does reaches anyone.

const STORY_SESSION_ID = 'story-crew-session';

const CREW: SessionUser[] = [
  { id: 'story-me', username: 'You', isLeader: true, connectionState: 'CONNECTED' },
  { id: 'story-sam', username: 'Sam', isLeader: false, userId: 'story-sam-user', connectionState: 'CONNECTED' },
];

function crewOverrides(wall: NonNullable<ScenarioOverrides['wall']>): ScenarioOverrides {
  return {
    queue: { isSharedSession: true, isCrewSession: true, sessionId: STORY_SESSION_ID, sessionUsers: CREW },
    wall,
  };
}

/** Take Sam's clock once the story's session is the one on screen, and let it go after. */
function useStoryCrewClock() {
  const { sessionId } = useQueueSessionId();
  useEffect(() => {
    if (sessionId !== STORY_SESSION_ID) return undefined;
    const startedAtMs = nowMs();
    handleCrewCadenceChange(
      {
        restCadence: {
          mode: 'onTheMinute',
          targetSeconds: 120,
          autoAdvance: true,
          advanceOn: 'deadline',
          source: 'settings',
          isRunning: true,
          anchorAt: String(startedAtMs - 40_000),
          pausedElapsedSeconds: 0,
          lastFiredBeatAt: null,
          lastTickQueueItemUuid: null,
          lastTickStatus: null,
          setByParticipantId: 'story-sam',
        },
        revision: 1,
        serverNow: String(startedAtMs),
        isSnapshot: true,
        action: null,
      },
      { sessionId: STORY_SESSION_ID, ownParticipantId: 'story-me', receivedAtMs: startedAtMs },
    );
    return () => disarmRestTimer();
  }, [sessionId]);
}

function CrewPills() {
  useStoryCrewClock();
  return (
    <>
      <StoryVariant label="Pill">
        <StorySurface>
          <RestTimerPill onPress={() => {}} />
        </StorySurface>
      </StoryVariant>
      <StoryVariant label="Drawer header pill">
        <StorySurface>
          <RestTimerPill onPress={() => {}} compact />
        </StorySurface>
      </StoryVariant>
      <StoryVariant label="Sheet clock">
        <StorySurface>
          <RestTimerHeroClock />
        </StorySurface>
      </StoryVariant>
    </>
  );
}

function CrewSheet() {
  useStoryCrewClock();
  const [visible, setVisible] = useState(true);
  return <RestTimerSheet visible={visible} onClose={() => setVisible(false)} />;
}

const PASSENGER = crewOverrides({ connection: 'heldByPeer', holderDisplayName: 'Sam' });
const HOLDER = crewOverrides({ connection: 'connectedByMe' });
const UNHELD = crewOverrides({ connection: 'disconnected' });

const stories: StoryModule = {
  title: 'Rest timer / Crew',
  stories: {
    crewPassenger: {
      name: 'Pill and clock, Sam holds the board',
      overrides: PASSENGER,
      render: () => <CrewPills />,
    },
    crewHolder: {
      name: 'Pill and clock, this phone holds the board',
      overrides: HOLDER,
      render: () => <CrewPills />,
    },
    crewUnheld: {
      name: 'Pill and clock, nobody holds the board',
      overrides: UNHELD,
      render: () => <CrewPills />,
    },
    sheetCrewPassenger: {
      name: 'Rest timer sheet, Sam holds the board',
      overrides: PASSENGER,
      render: () => <CrewSheet />,
    },
    sheetCrewHolder: {
      name: 'Rest timer sheet, this phone holds the board',
      overrides: HOLDER,
      render: () => <CrewSheet />,
    },
  },
};

export default stories;
