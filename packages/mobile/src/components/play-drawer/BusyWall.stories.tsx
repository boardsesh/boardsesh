import { StyleSheet, View } from 'react-native';
import type { SessionUser } from '@boardsesh/shared-schema';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { ScenarioOverrides } from '../../dev/stories/scenario-overrides';
import type { StoryModule } from '../../dev/stories/types';
import { setPlayerBoardControl } from '../../lib/player-buttons-preference';
import { setSetting } from '../../settings';
import { spacing } from '../../theme/tokens';
import { BusyWallQuestionGroup } from './BusyWallQuestionGroup';
import { resolveBusyWallQuestion, type BusyWallQuestionInput } from './busy-wall-question';

// The busy-wall question (#7017): Test2 put up a different climb while this
// climber, who holds the board, looked around. The caption in the header says
// so, and the wall button's row is Keep Test2's / Put mine up. The scenario
// stories put the real drawer in that state with a fake crew; the first one is
// also the place to check the first row's spacing with ⏮ and ⏭ live.

const noop = () => {};

const CREW: SessionUser[] = [
  { id: 'story-me', username: 'You', isLeader: true, connectionState: 'CONNECTED' },
  { id: 'story-test2', username: 'Test2', isLeader: false, userId: 'story-test2-user', connectionState: 'CONNECTED' },
];

const ROUTE = '/climbs?screenshotOpenFirst=1';
// A real crew always has a climb up: the drawer opens the first climb solo
// (which puts it up), then the crew arrives.
const CREW_JOINS_AFTER_MS = 6000;

/** A crew of two, this phone holding the board, and ⏮ ⏭ drawn live. */
function crew(player: NonNullable<ScenarioOverrides['player']>): ScenarioOverrides {
  return {
    queue: { isSharedSession: true, sessionId: 'story-crew-session', sessionUsers: CREW },
    player: { selfHoldsBoard: true, previousNextEnabled: true, ...player },
  };
}

const QUESTION = crew({
  wallPill: 'browsing',
  wallLit: 'notLit',
  busyWall: { holderName: 'Test2', climbName: 'Crimp Ladder' },
});

const withWallButton = () => {
  setSetting('lightOnSwipe', true);
  setPlayerBoardControl('wallButton');
};
const withBulb = () => {
  setSetting('lightOnSwipe', true);
  setPlayerBoardControl('lightbulb');
};

const question = (overrides: Partial<BusyWallQuestionInput> = {}) =>
  resolveBusyWallQuestion({
    holder: { name: 'Test2', avatarUrl: null },
    wallClimbName: 'Crimp Ladder',
    selfHoldsBoard: true,
    ready: true,
    ...overrides,
  });

const VARIANTS: readonly { label: string; input: Partial<BusyWallQuestionInput>; width?: number }[] = [
  { label: 'Put mine up leads (default)', input: {} },
  { label: 'Keep leads (the alternative)', input: { primary: 'keep' } },
  { label: 'nobody to name', input: { holder: null } },
  { label: 'a long name: Keep theirs', input: { holder: { name: 'Bartholomew-Alexander', avatarUrl: null } } },
  { label: 'no room: stacked, Put mine up on top', input: {}, width: 220 },
  { label: 'this phone holds no board', input: { selfHoldsBoard: false } },
];

const stories: StoryModule = {
  title: 'Play drawer / Busy wall',
  stories: {
    pair: {
      name: 'The pair, each look',
      render: () => (
        <View style={styles.stack}>
          {VARIANTS.map(({ label, input, width }) => (
            <StoryVariant key={label} label={label}>
              <StorySurface>
                <View style={[styles.row, width !== undefined && { width }]}>
                  <BusyWallQuestionGroup model={question(input)} onKeep={noop} onPut={noop} />
                </View>
              </StorySurface>
            </StoryVariant>
          ))}
        </View>
      ),
    },
    question: {
      name: 'Real drawer: Test2 just put up another climb (wall button)',
      overrides: QUESTION,
      prepare: withWallButton,
      route: ROUTE,
    },
    questionBulb: {
      name: 'Real drawer: the same question, Board control set to the bulb',
      overrides: QUESTION,
      prepare: withBulb,
      route: ROUTE,
    },
    // #7017 bug 1: the first row's five slots stay evenly spaced on the wall's
    // climb with ⏮ and ⏭ both live.
    wallClimb: {
      name: 'Real drawer: the wall’s climb, this phone holding it, ⏮ ⏭ live',
      overrides: crew({ wallPill: null, wallLit: 'lit' }),
      prepare: withWallButton,
      route: ROUTE,
      overridesDelayMs: CREW_JOINS_AFTER_MS,
    },
  },
};

export default stories;

const styles = StyleSheet.create({
  stack: {
    gap: spacing[5],
  },
  // As wide as the story's surface: a phone's row less the canvas padding.
  row: {
    flexDirection: 'row',
    alignSelf: 'stretch',
  },
});
