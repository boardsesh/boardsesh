import { StyleSheet, View } from 'react-native';
import type { SessionUser } from '@boardsesh/shared-schema';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { ScenarioOverrides } from '../../dev/stories/scenario-overrides';
import type { StoryModule } from '../../dev/stories/types';
import { setSetting } from '../../settings';
import { spacing } from '../../theme/tokens';
import { PlayDrawerCommitBar } from './PlayDrawerCommitBar';
import { WallStateCallout } from './WallStateCallout';
import { WallStatePill, type WallStatePillState } from './WallStatePill';

// Browsing in a crew session (#4281): the pill in the drawer header, the card it
// opens, and the commit row. The scenario stories put the real drawer into the
// same states with a fake second climber, since a real crew needs two phones.

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
// two people, but the gate never arms, so every tap takes the wall.
const IN_A_CREW_FLAG_OFF: ScenarioOverrides = {
  queue: { isSharedSession: false, sessionId: 'story-crew-session', sessionUsers: CREW },
};

// In a crew, browsing comes from the session, not from the solo "light on
// swipe" setting. Pin it on so a simulator that ran a solo preview shot (which
// turns it off) doesn't fake the crew behaviour.
const asCrewClimber = () => {
  setSetting('lightOnSwipe', true);
};

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
      name: 'Commit row',
      render: () => (
        <View style={styles.stack}>
          <StoryVariant label="browsing, wall reachable">
            <StorySurface>
              <PlayDrawerCommitBar
                showBackToLive
                showPutOnWall
                showConfirm={false}
                wallClimbName="Moonlight Sonata"
                commitLabel="putOnWall"
                onBackToLive={noop}
                onCommit={noop}
              />
            </StorySurface>
          </StoryVariant>
          <StoryVariant label="browsing, no wall">
            <StorySurface>
              <PlayDrawerCommitBar
                showBackToLive
                showPutOnWall
                showConfirm={false}
                wallClimbName={null}
                commitLabel="setActive"
                onBackToLive={noop}
                onCommit={noop}
              />
            </StorySurface>
          </StoryVariant>
          <StoryVariant label="someone else moved the wall">
            <StorySurface>
              <View style={styles.confirmRoom}>
                <PlayDrawerCommitBar
                  showBackToLive={false}
                  showPutOnWall={false}
                  showConfirm
                  wallClimbName="Moonlight Sonata"
                  commitLabel="putOnWall"
                  onBackToLive={noop}
                  onCommit={noop}
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
          <StoryVariant label="notice: you're browsing now">
            <View style={styles.calloutRoom}>
              <WallStateCallout state="browsing" presentation="notice" top={0} onDismiss={noop} />
            </View>
          </StoryVariant>
        </View>
      ),
    },
    crewFlagOn: {
      name: 'Real drawer, crew of two, flag on',
      overrides: IN_A_CREW,
      prepare: asCrewClimber,
      route: '/climbs?screenshotOpenFirst=1',
    },
    crewFlagOff: {
      name: 'Real drawer, crew of two, flag off (today)',
      overrides: IN_A_CREW_FLAG_OFF,
      prepare: asCrewClimber,
      route: '/climbs?screenshotOpenFirst=1',
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
  calloutRoom: {
    height: 160,
  },
});
