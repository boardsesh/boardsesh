import { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Climb } from '@boardsesh/queue';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { useTheme } from '../../providers/theme-provider';
import { BluetoothContext, useBluetoothContext } from '../../providers/bluetooth-provider';
import { QueueDataContext, useQueueData } from '../../providers/queue/queue-contexts';
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
const noConnection = async () => false;
const noDisconnect = async () => {};

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

function HeldClimb({ ledless, compact = false }: { ledless: boolean; compact?: boolean }) {
  const { brandColors } = useTheme();
  return (
    <HeldClimbCapsule
      climb={heldClimb}
      ledless={ledless}
      toneColor={ledless ? brandColors.primary : brandColors.warning}
      compact={compact}
      onPress={noop}
      onLongPress={noop}
      accessibilityActions={undefined}
      onAccessibilityAction={noop}
      accessibilityHint=""
    />
  );
}

/** Story-local transport/queue inputs; rendering the real capsule never writes hardware. */
function EmptyHeldCapsule({ ledless }: { ledless: boolean }) {
  const bluetooth = useBluetoothContext();
  const queue = useQueueData();
  const storyBluetooth = useMemo(
    () => ({
      ...bluetooth,
      isConnected: !ledless,
      loading: false,
      ledless,
      virtualWallHeld: ledless,
      canDriveWall: true,
      connect: noConnection,
      connectAfterBoardSwitch: noConnection,
      disconnect: noDisconnect,
      takeVirtualWall: noop,
      releaseVirtualWall: noop,
    }),
    [bluetooth, ledless],
  );
  const emptyQueue = useMemo(() => ({ ...queue, currentClimbQueueItem: null }), [queue]);
  return (
    <BluetoothContext.Provider value={storyBluetooth}>
      <QueueDataContext.Provider value={emptyQueue}>
        <TitleSlot>
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <BoardHeldCapsule ledless={ledless} />
          </View>
        </TitleSlot>
      </QueueDataContext.Provider>
    </BluetoothContext.Provider>
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
            <HeldClimb ledless={false} compact />
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
