import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Climb } from '@boardsesh/queue';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { useTheme } from '../../providers/theme-provider';
import { NativeHeaderActionContext } from '../chrome/native-header-action-context';
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

const stories: StoryModule = {
  title: 'Climbs header / Status capsules',
  stories: {
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
  },
});
