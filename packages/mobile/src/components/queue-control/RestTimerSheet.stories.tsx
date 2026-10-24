import { useState } from 'react';
import type { SessionUser } from '@boardsesh/shared-schema';
import type { ScenarioOverrides } from '../../dev/stories/scenario-overrides';
import type { StoryModule } from '../../dev/stories/types';
import { RestTimerSheet } from './RestTimerSheet';

// Who may let the rest timer move the wall (#5382, #5397). In a crew only the
// phone holding the wall may, so the sheet's auto-advance switch is off with the
// reason spelled out everywhere else. A real crew needs two phones; these fake
// the second climber. With EXPO_PUBLIC_SCREENSHOT_FAKE_BLE=1 this phone holds the
// wall and the switch comes back.

const CREW: SessionUser[] = [
  { id: 'story-me', username: 'You', isLeader: true, connectionState: 'CONNECTED' },
  { id: 'story-sam', username: 'Sam', isLeader: false, userId: 'story-sam-user', connectionState: 'CONNECTED' },
];

// A crew with the `shared-session-browse` flag off: gestures behave as solo, but
// it is still a crew, so a passenger's timer must not move the wall.
const IN_A_CREW_FLAG_OFF: ScenarioOverrides = {
  queue: { isSharedSession: false, isCrewSession: true, sessionId: 'story-crew-session', sessionUsers: CREW },
};

function OpenRestTimerSheet() {
  const [visible, setVisible] = useState(true);
  return <RestTimerSheet visible={visible} onClose={() => setVisible(false)} />;
}

const stories: StoryModule = {
  title: 'Rest timer / Who moves the wall',
  stories: {
    sheetInACrew: {
      name: 'Rest timer sheet, crew of two, flag off',
      overrides: IN_A_CREW_FLAG_OFF,
      render: () => <OpenRestTimerSheet />,
    },
    sheetSolo: {
      name: 'Rest timer sheet, solo',
      render: () => <OpenRestTimerSheet />,
    },
  },
};

export default stories;
