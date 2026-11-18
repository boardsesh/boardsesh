import { PlayerScene } from '../../dev/stories/PlayerScene';
import { FeatureFlagsProvider } from '../../providers/feature-flags-provider';
import { AURA_GPU_FAMILIES, AURA_GPU_FLAG } from '../../lib/board-render/gpu-rollout';
import { StyleSheet, View } from 'react-native';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { spacing } from '../../theme/tokens';
import { BusyWallQuestionGroup } from './BusyWallQuestionGroup';
import { resolveBusyWallQuestion, type BusyWallQuestionInput } from './busy-wall-question';

// The busy-wall question (#7017): Test2 put up a different climb while this
// climber, who holds the board, looked around. The caption in the header says
// so, and the wall button's row is Keep Test2's / Put mine up. The scenario
// stories put the real drawer in that state with a fake crew; the first one is
// also the place to check the first row's spacing with ⏮ and ⏭ live.

const noop = () => {};

/** The GPU board on every family, and the moving frost forced on, as the board motion lab does. */
const FROST_SWIPE_FLAGS = { [AURA_GPU_FLAG]: true, 'wall-frost-motion': true };
const FROST_SWIPE_PAYLOADS = {
  [AURA_GPU_FLAG]: { version: 1, enabledFamilies: [...AURA_GPU_FAMILIES], disabledFamilies: [] },
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
  { label: 'Put mine up leads', input: {} },
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
      name: 'Another climber is on the wall',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <PlayerScene {...controls} state="busy" />,
    },
    questionBulb: {
      name: 'Busy wall with lightbulb control',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <PlayerScene {...controls} state="busy" boardControl="lightbulb" />,
    },
    wallClimb: {
      name: 'The wall climb',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <PlayerScene {...controls} state="lit" />,
    },
    // Option I: swipe the board (or tap Next) and the driving wall button's
    // frost follows it, light by light. Needs a binary with the frost's
    // swapFrameApi; story mode holds the breathing still.
    frostSwipe: {
      name: 'Driving: the frost follows the board swipe',
      layout: 'fullscreen',
      render: (controls) => (
        <FeatureFlagsProvider flags={FROST_SWIPE_FLAGS} payloads={FROST_SWIPE_PAYLOADS}>
          <PlayerScene {...controls} state="driving" swipeBoard />
        </FeatureFlagsProvider>
      ),
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
