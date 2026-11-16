import { useHorizontalSafeArea } from '../../hooks/use-horizontal-safe-area';
import { playContentSideInsets } from '../../components/play-drawer/play-content-side-insets';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { resolveDisplayGrade } from '../../lib/boardsesh-grade-display';
import { StorySprayBoard } from './StorySprayBoard';
import type { StoryBoardFixture } from '../fixtures/boards';
import { boardSupportsMirroring } from '@boardsesh/board-config';
import { useCallback, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChromeIconButton } from '../../components/ChromeIconButton';
import { PlayTopChromeView } from '../../components/play-drawer/PlayTopChromeView';
import { PlayStageView } from '../../components/play-drawer/PlayStageView';
import { PlayDrawerHeader } from '../../components/play-drawer/PlayDrawerHeaderView';
import { PlayDrawerActionBar } from '../../components/play-drawer/PlayDrawerActionBar';
import { WallStatePillView } from '../../components/play-drawer/WallStatePillView';
import { resolveWallControl } from '../../components/play-drawer/wall-control';
import { resolveBusyWallQuestion } from '../../components/play-drawer/busy-wall-question';
import { useTheme } from '../../providers/theme-provider';
import { STORY_BOARD, STORY_CLIMBS } from '../fixtures/climbs';
import { spacing } from '../../theme/tokens';
import { StoryBoard } from './StoryBoard';
import type { StoryRenderControls } from './types';

const noop = () => {};
export type PlayerSceneState = 'lit' | 'preview' | 'crew' | 'dark' | 'disconnected' | 'busy';
/** The production player's layout, header, board and actions driven entirely by local story state. */
export function PlayerScene({
  state = 'lit',
  fixture = { board: STORY_BOARD, climbs: STORY_CLIMBS },
  boardControl = 'wallButton',
  onReady,
  onError,
}: StoryRenderControls & {
  state?: PlayerSceneState;
  boardControl?: 'wallButton' | 'lightbulb';
  fixture?: StoryBoardFixture;
}) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const sideInsets = playContentSideInsets('route', useHorizontalSafeArea());
  const [index, setIndex] = useState(0);
  const [mirrored, setMirrored] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [lit, setLit] = useState(state === 'lit');
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
  });
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
          fixture.spray ? (
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
