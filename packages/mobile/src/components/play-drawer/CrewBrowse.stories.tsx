import { StyleSheet, View } from 'react-native';
import type { SessionUser } from '@boardsesh/shared-schema';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { ScenarioOverrides } from '../../dev/stories/scenario-overrides';
import type { StoryModule } from '../../dev/stories/types';
import { setSetting } from '../../settings';
import { spacing } from '../../theme/tokens';
import { PlayDrawerCommitBar, PutOnWallButton } from './PlayDrawerCommitBar';
import { WallStateCallout } from './WallStateCallout';
import { WallStatePill, type WallStatePillState } from './WallStatePill';

// Browsing in a crew session (#4281): the chip in the drawer header (the wall
// driver's face, with a back glyph while you browse), the Put on the wall button
// and the busy-wall question, and the explainer the On the wall / Live chips open.
// The scenario stories put the real drawer into the same states with a fake
// second climber, since a real crew needs two phones.

const noop = () => {};

const PILL_STATES: readonly WallStatePillState[] = ['onWall', 'live', 'browsing'];

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
      name: 'Wall-state pill, every state',
      render: () => (
        <View style={styles.stack}>
          {PILL_STATES.map((state) => (
            <StoryVariant key={state} label={state}>
              <StorySurface>
                <View style={styles.pillRow}>
                  <WallStatePill state={state} onPress={noop} />
                </View>
              </StorySurface>
            </StoryVariant>
          ))}
        </View>
      ),
    },
    commitBar: {
      name: 'Put on the wall, and the busy-wall question',
      render: () => (
        <View style={styles.stack}>
          <StoryVariant label="browsing, wall reachable">
            <StorySurface>
              <View style={styles.buttonRow}>
                <PutOnWallButton commitLabel="putOnWall" onPress={noop} />
              </View>
            </StorySurface>
          </StoryVariant>
          <StoryVariant label="browsing, no wall">
            <StorySurface>
              <View style={styles.buttonRow}>
                <PutOnWallButton commitLabel="setActive" onPress={noop} />
              </View>
            </StorySurface>
          </StoryVariant>
          <StoryVariant label="someone else lit the wall">
            <StorySurface>
              <View style={styles.confirmRoom}>
                <PlayDrawerCommitBar
                  wallClimbName="Moonlight Sonata"
                  wallClimbUuid={null}
                  onKeepTheirs={noop}
                  onConfirm={noop}
                />
              </View>
            </StorySurface>
          </StoryVariant>
        </View>
      ),
    },
    callouts: {
      name: 'Pill callout, every state',
      render: () => (
        <View style={styles.stack}>
          {PILL_STATES.map((state) => (
            <StoryVariant key={state} label={`explainer: ${state}`}>
              <View style={styles.calloutRoom}>
                <WallStateCallout state={state} top={0} onBackToLive={noop} onDismiss={noop} />
              </View>
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
  confirmRoom: {
    paddingTop: spacing[16],
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  calloutRoom: {
    height: 160,
  },
});
