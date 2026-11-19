import { useHorizontalSafeArea } from '../../hooks/use-horizontal-safe-area';
import { playContentSideInsets } from '../../components/play-drawer/play-content-side-insets';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { resolveDisplayGrade } from '../../lib/boardsesh-grade-display';
import { StorySprayBoard } from './StorySprayBoard';
import type { StoryBoardFixture } from '../fixtures/boards';
import { boardSupportsMirroring } from '@boardsesh/board-config';
import { useCallback, useMemo, useState } from 'react';
import { useAnimatedReaction, useSharedValue } from 'react-native-reanimated';
import { useWallSwap } from '../../components/play-drawer/use-wall-swap';
import { PLAYER_SWAP_LOOK } from '../../components/play-drawer/player-swap-look';
import { swapLookTransition } from '../../components/play-drawer/swap-look-driver';
import { WALL_SWAP_NATIVE_API } from '../../components/play-drawer/wall-swap';
import { climbOverlayGpuApiVersion } from '../../lib/board-render/gpu-native-capability';
import { SwipeBoardCarousel } from '../../components/play-drawer/SwipeBoardCarousel';
import { useSwipeNavigation, useSwipePager, useSwipePages } from '../../components/play-drawer/use-swipe-pager';
import type { WallControlSwap } from '../../components/play-drawer/WallControlButton';
import type { BoardSwapFrame } from '../../components/play-drawer/swap-look';
import { PLAYER_SWAP_LOOK_ENCODED } from '../../components/play-drawer/player-swap-look';
import { getBoardRenderData } from '../../lib/board-details';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChromeIconButton } from '../../components/ChromeIconButton';
import { PlayTopChromeView } from '../../components/play-drawer/PlayTopChromeView';
import { PlayStageView } from '../../components/play-drawer/PlayStageView';
import { PlayDrawerHeader } from '../../components/play-drawer/PlayDrawerHeaderView';
import { PlayDrawerActionBar } from '../../components/play-drawer/PlayDrawerActionBar';
import { WallStatePillView } from '../../components/play-drawer/WallStatePillView';
import { resolveWallControl } from '../../components/play-drawer/wall-control';
import { wallControlUsesFrost } from '../../components/play-drawer/wall-control-frost';
import { useStoryWallGlow } from './use-story-wall-glow';
import { resolveBusyWallQuestion } from '../../components/play-drawer/busy-wall-question';
import { useTheme } from '../../providers/theme-provider';
import { STORY_BOARD, STORY_CLIMBS } from '../fixtures/climbs';
import { spacing } from '../../theme/tokens';
import { StoryBoard } from './StoryBoard';
import type { StoryRenderControls } from './types';

const noop = () => {};
/**
 * Where the board cannot swap (the iOS Simulator reports native API 1, so it
 * pages PNGs), the story runs the player's swap look on the pager itself and
 * hands its frames to the frost, so the frost's side can still be checked there.
 */
const BOARD_SWAPS = climbOverlayGpuApiVersion >= WALL_SWAP_NATIVE_API;
const STORY_SWAP_LOOK = swapLookTransition(PLAYER_SWAP_LOOK);
/** `driving`: this phone drives the wall (a live drive), so the wall button wears the frost. */
export type PlayerSceneState = 'lit' | 'driving' | 'preview' | 'crew' | 'dark' | 'disconnected' | 'busy';
/** The production player's layout, header, board and actions driven entirely by local story state. */
export function PlayerScene({
  state = 'lit',
  fixture = { board: STORY_BOARD, climbs: STORY_CLIMBS },
  boardControl = 'wallButton',
  onReady,
  onError,
  swipeBoard = false,
}: StoryRenderControls & {
  state?: PlayerSceneState;
  boardControl?: 'wallButton' | 'lightbulb';
  fixture?: StoryBoardFixture;
  /**
   * The player's own swipeable board (the stationary GPU carousel and its wall
   * swap) instead of a still board, with the wall button's frost following its
   * frames as `PlayCore` wires it. Swipe the board to see the frost follow.
   */
  swipeBoard?: boolean;
}) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const sideInsets = playContentSideInsets('route', useHorizontalSafeArea());
  const [index, setIndex] = useState(0);
  const [mirrored, setMirrored] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [lit, setLit] = useState(state === 'lit' || state === 'driving');
  const { board, climbs } = fixture;
  const climb = climbs[index];
  const { gradeFormat } = useGradeFormat();
  const grade = resolveDisplayGrade(climb, { useBoardseshGrades: false, gradeFormat, boardName: board.boardName });
  const previous = useCallback(() => setIndex((position) => Math.max(0, position - 1)), []);
  const next = useCallback(() => setIndex((position) => Math.min(climbs.length - 1, position + 1)), [climbs.length]);
  const toggleMirror = useCallback(() => setMirrored((current) => !current), []);
  const toggleFavorite = useCallback(() => setFavorite((current) => !current), []);
  const preview = state === 'preview' || state === 'crew' || state === 'busy';
  const wallControl = resolveWallControl({
    commitButton: preview ? 'putOnWall' : null,
    pressAction: fixture.spray
      ? lit
        ? 'releaseWall'
        : 'takeWall'
      : state === 'disconnected'
        ? 'connect'
        : state === 'crew'
          ? 'relay'
          : 'disconnect',
    holderIsAuthoritative: state === 'crew',
    localConnected: !fixture.spray && state !== 'disconnected' && state !== 'crew',
    pending: false,
    displayedLit: lit,
    offWall: false,
    wallHeldLocally: !!fixture.spray && lit,
    holderIsSelfAccount: false,
    selfFace: { name: 'You', avatarUrl: null },
    crewFace: { name: 'Sam', avatarUrl: null },
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: preview,
    writing: false,
    navigationCommits: !preview,
    driveMode: state === 'driving' ? 'live' : undefined,
  });
  // Driving draws the frost from the climb's lit holds, as the real player
  // does; a spray wall has no lights, so it never frosts.
  const wallGlow = useStoryWallGlow({
    board,
    climb,
    mirrored,
    shown: !fixture.spray && wallControlUsesFrost(wallControl),
  });
  // The swipeable board, and the frost following it (as PlayCore wires both).
  const { pager, stepSignal } = useSwipePager();
  useSwipeNavigation(pager, next, previous);
  const previousClimb = index > 0 ? climbs[index - 1] : null;
  const nextClimb = index < climbs.length - 1 ? climbs[index + 1] : null;
  const centerPage = useSwipePages(pager, stepSignal, previousClimb?.uuid ?? null, climb.uuid, nextClimb?.uuid ?? null);
  const swapFrames = useSharedValue<BoardSwapFrame | null>(null);
  const storyFrames = useWallSwap(pager, centerPage, swipeBoard && !BOARD_SWAPS, STORY_SWAP_LOOK);
  const drivesFrames = swipeBoard && !BOARD_SWAPS;
  useAnimatedReaction(
    () => (drivesFrames ? storyFrames.value : undefined),
    (frame) => {
      if (frame !== undefined) swapFrames.value = frame;
    },
  );
  const followsBoard = swipeBoard && wallGlow !== null;
  const previousGlow = useStoryWallGlow({
    board,
    climb: previousClimb ?? climb,
    mirrored,
    shown: followsBoard && previousClimb !== null,
  });
  const nextGlow = useStoryWallGlow({
    board,
    climb: nextClimb ?? climb,
    mirrored,
    shown: followsBoard && nextClimb !== null,
  });
  const wallSwap = useMemo<WallControlSwap | undefined>(
    () =>
      followsBoard
        ? { frames: swapFrames, centerPage, previous: previousGlow, next: nextGlow, look: PLAYER_SWAP_LOOK_ENCODED }
        : undefined,
    [followsBoard, swapFrames, centerPage, previousGlow, nextGlow],
  );
  const boardRenderData = useMemo(
    () => getBoardRenderData({ ...board, setIds: board.setIds.split(',').map(Number) }),
    [board],
  );
  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: systemColors.background,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: sideInsets.left,
          paddingRight: sideInsets.right,
        },
      ]}
    >
      <PlayStageView
        topChrome={
          <PlayTopChromeView
            onDismiss={noop}
            closeLabel="Close"
            chromeButtonSize={44}
            trailing={<ChromeIconButton icon="more" onPress={noop} accessibilityLabel="More actions" />}
          />
        }
        header={
          <PlayDrawerHeader
            name={climb.name}
            difficulty={grade.label}
            rawDifficulty={climb.difficulty}
            gradeColor={grade.color}
            qualityAverage={climb.quality_average}
            ascensionistCount={climb.ascensionist_count ?? 0}
            setterUsername={climb.setter_username ?? ''}
            boardName={board.boardName}
            angle={board.angle}
            leading={
              preview ? (
                <WallStatePillView
                  state="browsing"
                  backTarget="current"
                  onPress={() => setLit(true)}
                  driver={null}
                  driverName={null}
                />
              ) : undefined
            }
          />
        }
        board={
          swipeBoard && boardRenderData && !fixture.spray ? (
            <SwipeBoardCarousel
              boardName={board.boardName}
              boardRenderData={boardRenderData}
              layoutId={board.layoutId}
              sizeId={board.sizeId}
              setIds={board.setIds}
              currentFrames={climb.frames}
              nextFrames={nextClimb?.frames ?? null}
              prevFrames={previousClimb?.frames ?? null}
              pager={pager}
              centerPage={centerPage}
              mirrored={mirrored}
              canSwipeNext={nextClimb !== null}
              canSwipePrevious={previousClimb !== null}
              onSwipeNext={next}
              onSwipePrevious={previous}
              swapFrameMirror={BOARD_SWAPS ? swapFrames : undefined}
            />
          ) : fixture.spray ? (
            <StorySprayBoard
              geometry={fixture.spray}
              frames={climb.frames}
              mirrored={mirrored}
              onReady={onReady}
              onError={onError}
            />
          ) : (
            <StoryBoard
              key={climb.uuid + String(mirrored)}
              climb={climb}
              board={board}
              mirrored={mirrored}
              onReady={onReady}
              onError={onError}
            />
          )
        }
        controls={
          <PlayDrawerActionBar
            canSwipePrevious={index > 0}
            canSwipeNext={index < climbs.length - 1}
            isMirrored={mirrored}
            supportsMirroring={boardSupportsMirroring(board.boardName, board.layoutId)}
            isFavorited={favorite}
            remainingQueueCount={climbs.length - index - 1}
            wallControl={wallControl}
            wallGlow={wallGlow}
            wallSwap={wallSwap}
            boardControl={boardControl}
            onWallControlPress={() => setLit((current) => !current)}
            currentAngle={board.angle}
            ascentCount={0}
            onPrevClick={previous}
            onNextClick={next}
            onMirror={toggleMirror}
            onToggleFavorite={toggleFavorite}
            onOpenQueue={noop}
            onTickPress={noop}
            onTickLongPress={noop}
            commitButton={state === 'busy' ? 'confirm' : preview ? 'putOnWall' : null}
            busyWall={
              state === 'busy'
                ? resolveBusyWallQuestion({
                    holder: { name: 'Sam', avatarUrl: null },
                    wallClimbName: 'Crimp Ladder',
                    selfHoldsBoard: true,
                    ready: true,
                  })
                : null
            }
            onKeepTheirs={noop}
            onCommit={() => setLit(true)}
          />
        }
      />
    </View>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 }, grabber: { height: spacing[4] } });
