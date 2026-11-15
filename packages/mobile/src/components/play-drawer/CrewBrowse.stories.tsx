import { StyleSheet, View } from 'react-native';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { spacing } from '../../theme/tokens';
import { WallControlButton } from './WallControlButton';
import { WallStatePillView as WallStatePill } from './WallStatePillView';
import { PlayerScene } from '../../dev/stories/PlayerScene';
import { ClimbsStory } from '../climbs/Climbs.stories';
import { resolveWallControl, type WallControlModel, type WallControlState, type WallHolder } from './wall-control';

// Browsing in a crew session (#4281): the back chip in the drawer header (the
// back arrow, and the face of whoever lit the wall) and the wall button in
// each state (#7000). The busy-wall question has its own file (BusyWall.stories).
// The scenario stories put the real drawer into the same states with a fake
// second climber, since a real crew needs two phones.

const noop = () => {};

const WALL_BUTTON_STATES: readonly {
  label: string;
  state: WallControlState;
  holder: WallHolder;
  /** A swipe from here goes up on the wall: solo, not browsing (#7017). */
  driving?: boolean;
  holderIsSelfAccount?: boolean;
}[] = [
  { label: 'no board', state: 'connect', holder: null },
  { label: 'preview, no board', state: 'put_on_wall', holder: null },
  { label: 'preview, your board', state: 'put_on_wall', holder: 'self' },
  { label: "preview, Sam's board", state: 'put_on_wall', holder: 'crew' },
  { label: 'your board, this climb dark', state: 'dark', holder: 'self' },
  { label: 'lit, solo: driving the board', state: 'lit', holder: 'self', driving: true },
  { label: 'lit, in a crew: swipes browse', state: 'lit', holder: 'self' },
  { label: "Sam's board", state: 'crew', holder: 'crew' },
  { label: 'your other phone has the board', state: 'crew', holder: null, holderIsSelfAccount: true },
];

/** The model the player would build for one state, so the story draws what the app draws. */
function storyModel(
  state: WallControlState,
  holder: WallHolder,
  driving = false,
  holderIsSelfAccount = false,
): WallControlModel {
  const selfHolds = holder === 'self';
  return resolveWallControl({
    commitButton: state === 'put_on_wall' ? 'putOnWall' : null,
    pressAction: state === 'connect' ? 'connect' : state === 'crew' ? 'relay' : selfHolds ? 'disconnect' : 'noop',
    holderIsAuthoritative: state === 'crew',
    localConnected: selfHolds,
    pending: false,
    displayedLit: state === 'lit',
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount,
    selfFace: { name: 'You', avatarUrl: null },
    crewFace: { name: 'Sam', avatarUrl: null },
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    navigationCommits: driving,
  });
}

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
                  <WallStatePill
                    driver={null}
                    driverName="Sam"
                    state="browsing"
                    backTarget={backTarget}
                    onPress={noop}
                  />
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
          {WALL_BUTTON_STATES.map(({ label, state, holder, driving, holderIsSelfAccount }) => (
            <StoryVariant key={label} label={label}>
              <StorySurface>
                <View style={styles.buttonRow}>
                  <WallControlButton
                    model={storyModel(state, holder, driving, holderIsSelfAccount)}
                    onPress={noop}
                    onLongPress={noop}
                  />
                </View>
              </StorySurface>
            </StoryVariant>
          ))}
        </View>
      ),
    },
    crewFlagOn: {
      name: 'Crew of two, browsing',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <PlayerScene {...controls} state="crew" />,
    },
    crewFlagOff: {
      name: 'Crew of two, driving',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <PlayerScene {...controls} state="lit" />,
    },
    crewList: {
      name: 'Climb list',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <ClimbsStory {...controls} scene="populated" />,
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
