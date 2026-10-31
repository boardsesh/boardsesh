import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Climb } from '@boardsesh/queue';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { useTheme } from '../../providers/theme-provider';
import { NativeHeaderActionContext, NativeTitleMaxWidthContext } from '../chrome/native-header-action-context';
import { borderRadius, spacing } from '../../theme/tokens';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { BoardHeldCapsule, HeldClimbCapsule } from './BoardHeldCapsule';
import { WallStatusCapsule } from './WallStatusCapsule';

// The Climbs header's status capsules, laid out like the tab-bar accessory
// platter (#6902): a face, then the climb's name over "V7 · 1.4k sends".
// Drawn inside the native header context at the width UIKit leaves the title
// view on a 402pt iPhone, so the truncation matches the real header. The held
// capsules' taps are inert here; the real one disconnects the board.

// UIKit's title slot between the two bar groups on an iPhone 17 Pro.
const TITLE_SLOT_WIDTH = 210;

const noop = () => {};

const wallClimb = (over: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb => ({
  climbUuid: 'story-wall-climb',
  name: 'unknown #60',
  grade: '7a/V6',
  angle: 40,
  sentByDisplayName: 'Casey',
  sentAt: '2026-10-27T09:00:00.000Z',
  seq: 1,
  ...over,
});

const heldClimb: Climb = {
  uuid: 'story-held-climb',
  name: 'Kish Mud Prison',
  frames: '',
  setter_username: 'setter',
  angle: 40,
  ascensionist_count: 1400,
  difficulty: '7a+/V7',
  quality_average: '3.2',
  stars: 3,
  difficulty_error: '',
  benchmark_difficulty: null,
};

function TitleSlot({ children }: { children: ReactNode }) {
  return (
    <StorySurface>
      <NativeHeaderActionContext.Provider value={true}>
        <View style={styles.titleSlot}>{children}</View>
      </NativeHeaderActionContext.Provider>
    </StorySurface>
  );
}

function HeldClimb({ ledless }: { ledless: boolean }) {
  const { brandColors } = useTheme();
  return (
    <HeldClimbCapsule
      climb={heldClimb}
      ledless={ledless}
      toneColor={ledless ? brandColors.primary : brandColors.warning}
      compact={false}
      onPress={noop}
      onLongPress={noop}
      accessibilityActions={undefined}
      onAccessibilityAction={noop}
      accessibilityHint=""
    />
  );
}

function InteractiveWallCapsule() {
  const [sequence, setSequence] = useState(1);
  const [dismissed, setDismissed] = useState(false);
  const [history, setHistory] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const { systemColors } = useTheme();
  return (
    <>
      <StoryVariant label="Swipe left to dismiss; tap the capsule to preview">
        <StorySurface>
          <NativeHeaderActionContext.Provider value={true}>
            <NativeTitleMaxWidthContext.Provider value={narrow ? 80 : TITLE_SLOT_WIDTH}>
              <View style={[styles.titleSlot, narrow && styles.narrowTitleSlot]}>
                {dismissed ? null : (
                  <WallStatusCapsule
                    climb={wallClimb({ name: 'Swans A-Swimming', seq: sequence })}
                    boardName="tension"
                    presentation={history ? { kind: 'history', ageLabel: '20m' } : { kind: 'live' }}
                    occurrenceKey={`story-board:${sequence}`}
                    onDismiss={() => setDismissed(true)}
                  />
                )}
              </View>
            </NativeTitleMaxWidthContext.Provider>
          </NativeHeaderActionContext.Provider>
          <Text testID="capsule-story-state">
            {dismissed ? 'Capsule dismissed' : `Capsule visible · event ${sequence}`}
          </Text>
        </StorySurface>
      </StoryVariant>
      <View style={styles.storyControls}>
        <PressableSurface
          onPress={() => {
            setSequence((previous) => previous + 1);
            setDismissed(false);
          }}
          style={[styles.storyControl, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <Text>Re-light same climb</Text>
        </PressableSurface>
        <PressableSurface
          onPress={() => setHistory((previous) => !previous)}
          style={[styles.storyControl, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <Text>{history ? 'Show live' : 'Show history'}</Text>
        </PressableSurface>
        <PressableSurface
          onPress={() => setNarrow((previous) => !previous)}
          style={[styles.storyControl, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <Text>{narrow ? 'Use normal title' : 'Use narrow title'}</Text>
        </PressableSurface>
      </View>
    </>
  );
}

const stories: StoryModule = {
  title: 'Climbs header / Status capsules',
  stories: {
    interactive: {
      name: 'Dismiss and re-light the same climb',
      render: () => <InteractiveWallCapsule />,
    },
    every: {
      name: 'On the wall and You have the board, every state',
      render: () => (
        <>
          <StoryVariant label="On the wall, named sender">
            <TitleSlot>
              <WallStatusCapsule climb={wallClimb()} boardName="kilter" />
            </TitleSlot>
          </StoryVariant>
          <StoryVariant label="On the wall, anonymous sender, long name">
            <TitleSlot>
              <WallStatusCapsule
                climb={wallClimb({ sentByDisplayName: null, name: 'Kiel Training 1:4 variant (hard start)' })}
                boardName="kilter"
              />
            </TitleSlot>
          </StoryVariant>
          <StoryVariant label="Last on the wall, disconnected 20 minutes ago">
            <TitleSlot>
              <WallStatusCapsule
                climb={wallClimb()}
                boardName="kilter"
                presentation={{ kind: 'history', ageLabel: '20m' }}
              />
            </TitleSlot>
          </StoryVariant>
          <StoryVariant label="You're driving, your climb">
            <TitleSlot>
              <HeldClimb ledless={false} />
            </TitleSlot>
          </StoryVariant>
          <StoryVariant label="You have the wall (no lights), your climb">
            <TitleSlot>
              <HeldClimb ledless />
            </TitleSlot>
          </StoryVariant>
          <StoryVariant label="You're driving, no climb up">
            <TitleSlot>
              <BoardHeldCapsule ledless={false} />
            </TitleSlot>
          </StoryVariant>
        </>
      ),
    },
  },
};

export default stories;

const styles = StyleSheet.create({
  titleSlot: {
    width: TITLE_SLOT_WIDTH,
    alignItems: 'center',
    minHeight: 44,
  },
  narrowTitleSlot: {
    width: 80,
  },
  storyControls: {
    gap: spacing[3],
  },
  storyControl: {
    padding: spacing[4],
    borderRadius: borderRadius.lg,
  },
});
