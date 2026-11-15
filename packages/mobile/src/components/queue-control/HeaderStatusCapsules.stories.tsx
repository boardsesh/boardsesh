import { formatGrade } from '@boardsesh/play-view';
import type { Climb } from '@boardsesh/queue';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { Avatar } from '../Avatar';
import { NativeHeaderActionContext, NativeTitleMaxWidthContext } from '../chrome/native-header-action-context';
import type { WallGlowInput } from '../play-drawer/use-wall-glow';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { BoardHeldCapsuleView, HeldClimbCapsuleView } from './BoardHeldCapsuleView';
import { WallStatusCapsuleView, type WallStatusCapsuleProps } from './WallStatusCapsuleView';

// The Climbs header's status capsules: a face, then the climb's name, with
// "20m ago" under it on a stale capsule (#7281). Drawn inside the native header
// context; the narrow toggle shows the compact form a phone gets beside the
// angle. The held capsules' taps are inert here; the real one disconnects the
// board. Under the Material theme the wall capsule is the Android app bar's M3
// pill: it fills the slot and reads its width from its own layout (the face
// shows from 130dp, so the narrow toggle drops it), not from the native bound.

// UIKit's title slot between the two bar groups on an iPhone 17 Pro.
const TITLE_SLOT_WIDTH = 210;

const noop = () => {};
const GLOW: WallGlowInput = {
  key: 'header-held-climb',
  boardWidth: 100,
  boardHeight: 150,
  holds: [
    { x: 30, y: 8, color: '#FF00FF' },
    { x: 75, y: 16, color: '#4DF5FD' },
    { x: 50, y: 30, color: '#FFA500' },
    { x: 25, y: 55, color: '#4DF5FD' },
    { x: 70, y: 75, color: '#FFA500' },
    { x: 40, y: 100, color: '#4DF5FD' },
    { x: 65, y: 125, color: '#00DD00' },
  ],
};
const emptyHeldProps: Pick<
  ComponentProps<typeof BoardHeldCapsuleView>,
  'onPress' | 'onLongPress' | 'accessibilityActions' | 'onAccessibilityAction' | 'accessibilityHint'
> = {
  onPress: noop,
  onLongPress: noop,
  accessibilityActions: undefined,
  onAccessibilityAction: noop,
  accessibilityHint: '',
};
function WallCapsule(props: WallStatusCapsuleProps) {
  return (
    <WallStatusCapsuleView
      {...props}
      formattedGrade={formatGrade(props.climb.grade, 'v-grade', props.boardName)}
      senderIsYou={false}
      senderPending={false}
      statsDetail="1,862 sends"
      onPress={noop}
      avatar={<Avatar name={props.climb.sentByDisplayName} size={24} />}
    />
  );
}

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
  uuid: 'A6E04278AE294E03AD9DD2A8E0CDE31F',
  name: 'Lightest Pair of Shorts',
  // The recorded Kilter climb's real hold roles, also used by screenshot replay.
  frames:
    'p4131r44p4156r43p4158r43p4189r44p4201r45p4214r43p4225r45p4272r43p4292r45p4296r43p4328r43p4352r42p4408r45p4412r42',
  boardType: 'kilter',
  layoutId: 8,
  setter_username: 'KilterStudio',
  angle: 35,
  ascensionist_count: 1862,
  difficulty: '6b/V4',
  quality_average: '3.2',
  stars: 3,
  difficulty_error: '',
  benchmark_difficulty: null,
};

function TitleSlot({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return (
    <StorySurface>
      <NativeHeaderActionContext.Provider value={true}>
        <NativeTitleMaxWidthContext.Provider value={narrow ? 80 : TITLE_SLOT_WIDTH}>
          <View style={[styles.titleSlot, narrow && styles.narrowTitleSlot]}>{children}</View>
        </NativeTitleMaxWidthContext.Provider>
      </NativeHeaderActionContext.Provider>
    </StorySurface>
  );
}

function HeldClimb({ ledless }: { ledless: boolean }) {
  const { brandColors } = useTheme();
  return (
    <HeldClimbCapsuleView
      grade="V4"
      sendsDetail="1,862 sends"
      glow={ledless ? null : GLOW}
      climb={heldClimb}
      ledless={ledless}
      toneColor={ledless ? brandColors.primary : brandColors.warning}
      onPress={noop}
      onLongPress={noop}
      accessibilityActions={undefined}
      onAccessibilityAction={noop}
      accessibilityHint=""
    />
  );
}

function EmptyHeldCapsule({ ledless }: { ledless: boolean }) {
  return (
    <TitleSlot>
      <BoardHeldCapsuleView {...emptyHeldProps} ledless={ledless} localConnected={!ledless} />
    </TitleSlot>
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
                  <WallCapsule
                    climb={wallClimb({ name: 'Swans A-Swimming', seq: sequence })}
                    boardName="tension"
                    presentation={
                      history ? { kind: 'history', ageLabel: '20m', ageByline: '20m ago' } : { kind: 'live' }
                    }
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
    emptyHeld: {
      name: 'You have the board, no climb up: LED and no lights',
      render: () => (
        <>
          <StoryVariant label="LED board held, no climb up">
            <EmptyHeldCapsule ledless={false} />
          </StoryVariant>
          <StoryVariant label="No-lights wall held, no climb up">
            <EmptyHeldCapsule ledless />
          </StoryVariant>
        </>
      ),
    },
    interactive: {
      name: 'Dismiss and re-light the same climb',
      render: () => <InteractiveWallCapsule />,
    },
    heldCompact: {
      name: 'Held climb in an 80-point native title',
      render: () => (
        <StoryVariant label="You're driving, compact title">
          <TitleSlot narrow>
            <HeldClimb ledless={false} />
          </TitleSlot>
        </StoryVariant>
      ),
    },
    every: {
      name: 'On the wall and You have the board, every state',
      render: () => (
        <>
          <StoryVariant label="On the wall, named sender">
            <TitleSlot>
              <WallCapsule climb={wallClimb()} boardName="kilter" />
            </TitleSlot>
          </StoryVariant>
          <StoryVariant label="On the wall, anonymous sender, long name">
            <TitleSlot>
              <WallCapsule
                climb={wallClimb({ sentByDisplayName: null, name: 'Kiel Training 1:4 variant (hard start)' })}
                boardName="kilter"
              />
            </TitleSlot>
          </StoryVariant>
          <StoryVariant label="Last on the wall, disconnected 20 minutes ago">
            <TitleSlot>
              <WallCapsule
                climb={wallClimb()}
                boardName="kilter"
                presentation={{ kind: 'history', ageLabel: '20m', ageByline: '20m ago' }}
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
              <BoardHeldCapsuleView {...emptyHeldProps} ledless={false} localConnected />
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
