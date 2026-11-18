import { readFlashListViewport } from '../../../dev/stories/use-visible-art-readiness';
import { useVariantValue } from '../../../theme/variants';
import type { FlashListRef, FlashListProps } from '@shopify/flash-list';
import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { HorizontalSafeAreaApplied, useHorizontalSafeArea } from '../../../hooks/use-horizontal-safe-area';
import { useTranslation } from 'react-i18next';
import { useStorySessionFooterBottom } from '../../../dev/stories/use-story-bottom-inset';
import { formatGradeByDifficultyId } from '@boardsesh/play-view';
import { summarizePlanFill, DEFAULT_VOLUME_OPTIONS } from '@boardsesh/playlist-generator';
import type { StoryModule, StoryRenderControls } from '../../../dev/stories/types';
import { useStoryBoardFixture } from '../../../dev/stories/story-board-fixture';
import { buildStoryWorkout } from '../../../dev/fixtures/workout';
import { StorySprayBoard } from '../../../dev/stories/StorySprayBoard';
import { StoryBoard } from '../../../dev/stories/StoryBoard';
import { StoryClimbArtObserverProvider, renderStoryClimbContent } from '../../../dev/stories/StoryClimbRow';
import { useNativeRootHeader } from '../../../hooks/use-native-root-header';
import { useGlassCapability } from '../../../hooks/use-glass-capability';
import { DEFAULT_CLIMB_ROW_DISPLAY } from '../../../lib/climb-row-display';
import { climbToQueueItem } from '../../../lib/climb-to-queue-item';
import { BoardSummaryCardView } from '../../boards/BoardSummaryCard';
import { UserAvatarToolbarActionView } from '../../user-drawer/UserAvatarToolbarActionView';
import { RecordTopChromeView } from '../RecordTopChrome';
import { RestTimerArmRowView } from '../RestTimerArmRow';
import { SessionVisibilityRow } from '../SessionVisibilityRow';
import { SessionStartFab, SESSION_START_FAB_HEIGHT } from '../SessionStartFab';
import { RestTimerLengthSettingView } from '../../queue-control/RestTimerSheetViews';
import { GeneratorPickerCardView } from './GeneratorPickerCard';
import { PreSessionHeaderView } from './PreSessionHeaderView';
import { PreSessionPresentation } from './PreSessionPresentation';
import { WorkoutPreviewSection } from './WorkoutPreviewSection';
import { WorkoutPreviewRowView } from './WorkoutPreviewRow';
import { singleBlockSelection } from './workout-blocks';
import { buildPreviewListRows, type PreviewListRow } from './workout-preview-sections';
import type { WorkoutPresentation } from './workout-presentation';
const noop = () => {};
const VIEWABILITY = { minimumViewTime: 0, itemVisiblePercentThreshold: 1 };
const presentation: WorkoutPresentation = {
  isAuthenticated: true,
  formatGradeByDifficultyId: (grade, board) => formatGradeByDifficultyId(grade, 'v-grade', board),
};
const rowAssetId = (row: PreviewListRow) => (row.kind === 'climb' ? (row.preview.item.climb?.uuid ?? null) : null);
function WorkoutGeneratorStory({ onReady, onError }: StoryRenderControls) {
  const fixture = useStoryBoardFixture();
  const { left, right } = useHorizontalSafeArea();
  const STORY_BOARD = fixture.board;
  const workout = useMemo(() => buildStoryWorkout(fixture), [fixture]);
  const previews = useMemo(
    () =>
      workout.climbs.map((climb, index) => ({
        item: climbToQueueItem(climb),
        slot: { grade: workout.targetGrade, section: 'main' as const, index },
      })),
    [workout],
  );
  const rows = useMemo(() => buildPreviewListRows(previews), [previews]);
  const summary = useMemo(
    () =>
      summarizePlanFill(
        previews.map(({ slot }) => slot),
        previews.map(({ slot }) => slot),
      ),
    [previews],
  );
  const startQueue = useMemo(() => ({ climbCount: previews.length, estimatedMinutes: null }), [previews]);
  const board = useMemo(
    () => ({ ...STORY_BOARD, boardType: STORY_BOARD.boardName, name: fixture.label, sizeName: '' }),
    [STORY_BOARD, fixture.label],
  );
  const emptyBoard = useMemo(() => ({ ...fixture.climbs[0], frames: '' }), [fixture]);
  const renderRow = useCallback(
    ({ item: row }: { item: PreviewListRow }) =>
      row.kind === 'climb' ? (
        <WorkoutPreviewRowView
          item={row.preview.item}
          board={STORY_BOARD}
          isActive={false}
          isRefreshing={false}
          refreshDisabled={false}
          rowDisplay={DEFAULT_CLIMB_ROW_DISPLAY}
          renderContent={renderStoryClimbContent}
          onRefresh={noop}
        />
      ) : null,
    [STORY_BOARD],
  );
  const { t } = useTranslation('session');
  const footerBottom = useStorySessionFooterBottom();
  const nativeRootHeader = useNativeRootHeader();
  const chromeTitle = useVariantValue({
    material: t('mobile.session.recordTab'),
    liquidGlass: t('mobile.session.headerStart'),
  });
  const glassCapability = useGlassCapability();
  const [selection, setSelection] = useState(() =>
    singleBlockSelection(
      { ...DEFAULT_VOLUME_OPTIONS, targetGrade: workout.targetGrade, mainSetClimbs: workout.requestedCount },
      'volume',
    ),
  );
  const [armed, setArmed] = useState(false);
  const [isPublic, setPublic] = useState(true);
  const [restSeconds, setRestSeconds] = useState<number | null>(120);
  const [chromeHeight, setChromeHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(SESSION_START_FAB_HEIGHT);
  const listRef = useRef<FlashListRef<PreviewListRow>>(null);
  const boardReady = useRef(false);
  const expected = useRef<Set<string> | null>(null);
  const displayed = useRef(new Set<string>());
  const reportReady = useCallback(() => {
    if (boardReady.current && expected.current && [...expected.current].every((id) => displayed.current.has(id)))
      onReady();
  }, [onReady]);
  const onDisplayed = useCallback(
    (id: string) => {
      displayed.current.add(id);
      reportReady();
    },
    [reportReady],
  );
  const markBoardReady = useCallback(() => {
    boardReady.current = true;
    reportReady();
  }, [reportReady]);
  // onLoad follows the list's first committed item measurements. Read geometry
  // so a header-only viewport does not wait for unmounted preview thumbnails.
  const onLoad = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    expected.current = new Set(
      readFlashListViewport(list, rows).flatMap((row) => {
        const id = rowAssetId(row);
        return id ? [id] : [];
      }),
    );
    reportReady();
  }, [reportReady, rows]);
  const onViewableItemsChanged = useCallback<NonNullable<FlashListProps<PreviewListRow>['onViewableItemsChanged']>>(
    ({ viewableItems }) => {
      expected.current = new Set(
        viewableItems.flatMap(({ item }) => {
          const id = rowAssetId(item);
          return id ? [id] : [];
        }),
      );
      reportReady();
    },
    [reportReady],
  );
  const header = useMemo(
    () => (
      <PreSessionHeaderView
        showTitle={!nativeRootHeader}
        board={
          <BoardSummaryCardView
            board={board}
            hasNoBoard={false}
            isRestoreError={false}
            onBrowseClimbs={noop}
            onChangeBoard={noop}
            onRetry={noop}
            thumbnail={
              <View style={{ width: 44, height: 56 }}>
                {fixture.spray ? (
                  <StorySprayBoard geometry={fixture.spray} frames="" onReady={markBoardReady} onError={onError} />
                ) : (
                  <StoryBoard board={STORY_BOARD} climb={emptyBoard} onReady={markBoardReady} onError={onError} />
                )}
              </View>
            }
          />
        }
        timer={
          <RestTimerArmRowView
            armed={armed}
            onArm={setArmed}
            controls={
              <RestTimerLengthSettingView inset targetSeconds={restSeconds} setTargetSeconds={setRestSeconds} />
            }
          />
        }
        visibility={<SessionVisibilityRow isPublic={isPublic} onChange={setPublic} />}
        generator={
          <GeneratorPickerCardView
            {...STORY_BOARD}
            presentation={presentation}
            selection={selection}
            onChange={setSelection}
          />
        }
        preview={
          <WorkoutPreviewSection
            boardName={STORY_BOARD.boardName}
            hasPreviewItems
            summary={summary}
            startQueue={startQueue}
            onShuffle={noop}
            shuffleDisabled={false}
            stateMessage={null}
          />
        }
      />
    ),
    [
      nativeRootHeader,
      markBoardReady,
      onError,
      armed,
      restSeconds,
      isPublic,
      selection,
      fixture,
      STORY_BOARD,
      emptyBoard,
      board,
      summary,
      startQueue,
    ],
  );
  return (
    <StoryClimbArtObserverProvider onDisplayed={onDisplayed} onError={onError}>
      <HorizontalSafeAreaApplied>
        <View style={[styles.fill, { paddingLeft: left, paddingRight: right }]}>
          <PreSessionPresentation
            listRef={listRef}
            rows={rows}
            renderItem={renderRow}
            header={header}
            listProps={{
              onLoad,
              onViewableItemsChanged,
              viewabilityConfig: VIEWABILITY,
            }}
            automaticInsets={nativeRootHeader}
            paddingTop={nativeRootHeader ? 0 : chromeHeight}
            paddingBottom={footerHeight + footerBottom}
            indicatorTop={chromeHeight}
            chrome={
              <RecordTopChromeView
                title={chromeTitle}
                nativeRootHeader={nativeRootHeader}
                glassCapability={glassCapability}
                onHeightChange={setChromeHeight}
                materialAvatar={<UserAvatarToolbarActionView variant="material" avatarName="Alex" onPress={noop} />}
                glassAvatar={<UserAvatarToolbarActionView variant="glass" avatarName="Alex" onPress={noop} />}
              />
            }
            footer={
              <SessionStartFab
                testID="pre-session-footer"
                actionTestID="session-start"
                bottomOffset={footerBottom}
                onHeightChange={setFooterHeight}
                label={t('mobile.session.preStart')}
                icon="play.fill"
                onPress={noop}
                disabled={false}
                loading={false}
              />
            }
          />
        </View>
      </HorizontalSafeAreaApplied>
    </StoryClimbArtObserverProvider>
  );
}
export default {
  title: 'Screens / Workout generator',
  stories: {
    volume: {
      name: 'Volume workout',
      layout: 'fullscreen',
      tab: 'record',
      readiness: 'explicit',
      render: (controls) => <WorkoutGeneratorStory {...controls} />,
    },
  },
} satisfies StoryModule;

const styles = StyleSheet.create({ fill: { flex: 1 } });
