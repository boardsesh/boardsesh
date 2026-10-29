import { StyleSheet, View } from 'react-native';
import type { SessionUser } from '@boardsesh/shared-schema';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { ScenarioOverrides } from '../../dev/stories/scenario-overrides';
import type { StoryModule } from '../../dev/stories/types';
import { setSetting } from '../../settings';
import { spacing } from '../../theme/tokens';
import { WallControlButton } from './WallControlButton';
import { WallStatePill } from './WallStatePill';
import { resolveWallControl, type WallControlModel, type WallControlState, type WallHolder } from './wall-control';

// Browsing in a crew session (#4281): the back chip in the drawer header (a back
// glyph, "Back", and the face of whoever lit the wall) and the wall button in
// each state (#7000). The busy-wall question has its own file (BusyWall.stories).
// The scenario stories put the real drawer into the same states with a fake
// second climber, since a real crew needs two phones.

const noop = () => {};

const WALL_BUTTON_STATES: readonly { label: string; state: WallControlState; holder: WallHolder }[] = [
  { label: 'no board', state: 'connect', holder: null },
  { label: 'preview, no board', state: 'put_on_wall', holder: null },
  { label: 'preview, your board', state: 'put_on_wall', holder: 'self' },
  { label: "preview, Sam's board", state: 'put_on_wall', holder: 'crew' },
  { label: 'your board, this climb dark', state: 'dark', holder: 'self' },
  { label: 'lit', state: 'lit', holder: 'self' },
  { label: "Sam's board", state: 'crew', holder: 'crew' },
];

/** The model the player would build for one state, so the story draws what the app draws. */
function storyModel(state: WallControlState, holder: WallHolder): WallControlModel {
  const selfHolds = holder === 'self';
  return resolveWallControl({
    commitButton: state === 'put_on_wall' ? 'putOnWall' : null,
    pressAction: state === 'connect' ? 'connect' : holder === 'crew' ? 'relay' : selfHolds ? 'disconnect' : 'noop',
    holderIsAuthoritative: holder === 'crew',
    localConnected: selfHolds,
    pending: false,
    displayedLit: state === 'lit',
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount: false,
    selfFace: { name: 'You', avatarUrl: null },
    crewFace: { name: 'Sam', avatarUrl: null },
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    autoDisconnectWarning: false,
  });
}

const CREW: SessionUser[] = [
  { id: 'story-me', username: 'You', isLeader: true, connectionState: 'CONNECTED' },
  { id: 'story-sam', username: 'Sam', isLeader: false, userId: 'story-sam-user', connectionState: 'CONNECTED' },
];

const IN_A_CREW: ScenarioOverrides = {
  queue: { isSharedSession: true, sessionId: 'story-crew-session', sessionUsers: CREW },
};

// What a crew looks like today with `shared-session-browse` off: the session has
// two people, but the gate never arms, so every tap takes the wall. It is still a
// crew, so only the wall holder's rest timer may advance it.
const IN_A_CREW_FLAG_OFF: ScenarioOverrides = {
  queue: { isSharedSession: false, isCrewSession: true, sessionId: 'story-crew-session', sessionUsers: CREW },
};

// In a crew, browsing comes from the session, not from the solo "light on
// swipe" setting. Pin it on so a simulator that ran a solo preview shot (which
// turns it off) doesn't fake the crew behaviour.
const asCrewClimber = () => {
  setSetting('lightOnSwipe', true);
};

// A real crew always has a climb up. The drawer scenarios open the first climb
// solo (which commits it and lights the wall), then the crew arrives, so a swipe
// browses away from a climb the back chip can return to.
const CREW_JOINS_AFTER_MS = 6000;

const stories: StoryModule = {
  title: 'Play drawer / Crew browse',
  stories: {
    pills: {
      name: 'Back chip, to your climb and to the wall',
      render: () => (
        <View style={styles.stack}>
          {(['current', 'wall'] as const).map((backTarget) => (
            <StoryVariant key={backTarget} label={`back to ${backTarget}`}>
              <StorySurface>
                <View style={styles.pillRow}>
                  <WallStatePill state="browsing" backTarget={backTarget} onPress={noop} />
                </View>
              </StorySurface>
            </StoryVariant>
          ))}
        </View>
      ),
    },
    commitBar: {
      name: 'The wall button in each state',
      render: () => (
        <View style={styles.stack}>
          {WALL_BUTTON_STATES.map(({ label, state, holder }) => (
            <StoryVariant key={label} label={label}>
              <StorySurface>
                <View style={styles.buttonRow}>
                  <WallControlButton model={storyModel(state, holder)} onPress={noop} onLongPress={noop} />
                </View>
              </StorySurface>
            </StoryVariant>
          ))}
        </View>
      ),
    },
    crewFlagOn: {
      name: 'Real drawer, crew of two, flag on',
      overrides: IN_A_CREW,
      prepare: asCrewClimber,
      route: '/climbs?screenshotOpenFirst=1',
      overridesDelayMs: CREW_JOINS_AFTER_MS,
    },
    crewFlagOff: {
      name: 'Real drawer, crew of two, flag off (today)',
      overrides: IN_A_CREW_FLAG_OFF,
      prepare: asCrewClimber,
      route: '/climbs?screenshotOpenFirst=1',
      overridesDelayMs: CREW_JOINS_AFTER_MS,
    },
    crewList: {
      name: 'Climb list, crew of two, flag on',
      overrides: IN_A_CREW,
      prepare: asCrewClimber,
      route: '/climbs',
    },
  },
};

export default stories;

const styles = StyleSheet.create({
  stack: {
    gap: spacing[5],
  },
  pillRow: {
    flexDirection: 'row',
  },
  // The width of a 375pt phone's row, so the stories show the real fit.
  buttonRow: {
    flexDirection: 'row',
    width: 343,
  },
});
