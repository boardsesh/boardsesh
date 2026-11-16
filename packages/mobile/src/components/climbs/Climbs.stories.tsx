import { selectByVariant } from '../../theme/variants';
import { useStoryBottomInset } from '../../dev/stories/use-story-bottom-inset';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { Appbar } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import type { StoryModule } from '../../dev/stories/types';
import { useStoryBoardFixture } from '../../dev/stories/story-board-fixture';
import { DEFAULT_CLIMB_ROW_DISPLAY } from '../../lib/climb-row-display';
import { NO_LOCKED_DIMENSIONS } from '../../lib/dimension-chips';
import { useHorizontalSafeArea } from '../../hooks/use-horizontal-safe-area';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { useTheme } from '../../providers/theme-provider';
import { ClimbListRowView, type ClimbListRowViewProps } from '../ClimbListRow';
import {
  ClimbListItemContentView,
  ClimbSubtitleView,
  ClimbAscentStatusView,
  type ClimbRowLeaves,
  type ClimbRowThumbnailLeafProps,
} from '../ClimbListItemContent';
import { StoryClimbThumbnail, StoryClimbGrade } from '../../dev/stories/StoryClimbRow';
import { ClimbListRowSkeletonView } from '../ClimbListRowSkeleton';
import { climbListThumbnailSize } from '../climb-list-thumbnail-metrics';
import { ClimbTopChromeView } from '../search/ClimbTopChrome';
import { FilterChipRow } from '../search/FilterChipRow';
import { NativeRootHeader } from '../chrome/NativeRootHeader';
import { CollapsingLargeTitleHeader } from '../chrome/CollapsingLargeTitleHeader';
import { GlassActionToolbar, GlassToolbarAction } from '../chrome/GlassActionToolbar';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { iconMap } from '../icon-map';
import { buildClimbMenuItems } from '../climb-actions/climb-menu-items';
import { buildPlayDrawerMenuRows } from '../play-drawer/play-drawer-menu-rows';
import { LIST_GROUPS, ALL_BUTTONS_HIDDEN } from '../climb-actions/climb-list-menu-options';
import { ClimbsView } from './ClimbsView';
import { ClimbsEmptyState, type ClimbsEmptyStateProps } from './ClimbsEmptyState';

const noop = () => {};
const noContent = () => null;
const thumbnailSize = climbListThumbnailSize(1);
const keyExtractor = (climb: Climb) => climb.uuid;
const ReadyContext = createContext<(uuid: string) => void>(noop);
const ErrorContext = createContext<(error: unknown) => void>(noop);

const StoryThumbnail = memo(function StoryThumbnail(props: ClimbRowThumbnailLeafProps) {
  const reportReady = useContext(ReadyContext);
  const onArtError = useContext(ErrorContext);
  const onArtDisplayed = useCallback(() => reportReady(props.climbUuid ?? ''), [reportReady, props.climbUuid]);
  return <StoryClimbThumbnail {...props} onArtDisplayed={onArtDisplayed} onArtError={onArtError} />;
});

const leaves: Required<ClimbRowLeaves> = {
  Thumbnail: StoryThumbnail,
  Grade: StoryClimbGrade,
  Subtitle: (props) => <ClimbSubtitleView {...props} communityGrade={null} />,
  AscentStatus: (props) => <ClimbAscentStatusView {...props} ascentStatus={null} mirrorStatus={null} />,
  Favorite: noContent,
  Progress: noContent,
  PlaylistChips: noContent,
};

const renderContent: NonNullable<ClimbListRowViewProps['renderContent']> = (props) => (
  <ClimbListItemContentView {...props} display={DEFAULT_CLIMB_ROW_DISPLAY} leaves={leaves} />
);

type Scene = 'populated' | 'loading' | 'refreshing' | 'empty' | 'error' | 'offline' | 'filtered' | 'actions';

export function ClimbsStory({
  scene,
  onReady,
  onError = noop,
}: {
  scene: Scene;
  onReady: () => void;
  onError?: (error: unknown) => void;
}) {
  const fixture = useStoryBoardFixture();
  const STORY_BOARD = useMemo(() => ({ ...fixture.board, name: fixture.label }), [fixture]);
  const climbs = useMemo(() => fixture.climbs.slice(0, 3), [fixture]);
  const { t } = useTranslation('climbs');
  const bottomInset = useStoryBottomInset();
  const { t: tCommon } = useTranslation('common');
  const { systemColors, variant, actionColors } = useTheme();
  const nativeHeader = useNativeRootHeader();
  const [chromeHeight, setChromeHeight] = useState(0);
  const { left, right } = useHorizontalSafeArea();
  const clipStyle = useMemo(
    () => [{ left, right }, selectByVariant(variant, { material: { top: chromeHeight }, liquidGlass: undefined })],
    [variant, chromeHeight, left, right],
  );
  const [filtered, setFiltered] = useState(scene === 'filtered' || !!fixture.gradeRange);
  const [selected, setSelected] = useState<string | null>(null);
  const [laidOut, setLaidOut] = useState(false);
  const [artReady, setArtReady] = useState(false);
  const [menuPresented, setMenuPresented] = useState(false);
  const onMenuPresented = useCallback(() => setMenuPresented(true), []);
  const readyClimbs = useRef(new Set<string>());
  const showRows = scene === 'populated' || scene === 'refreshing' || scene === 'filtered' || scene === 'actions';
  const markArtReady = useCallback(
    (uuid: string) => {
      readyClimbs.current.add(uuid);
      if (climbs.every((climb) => readyClimbs.current.has(climb.uuid))) setArtReady(true);
    },
    [climbs],
  );
  useEffect(() => {
    if (!laidOut || (showRows && !artReady) || (scene === 'actions' && !menuPresented)) return;
    const frame = requestAnimationFrame(onReady);
    return () => cancelAnimationFrame(frame);
  }, [laidOut, showRows, artReady, onReady, scene, menuPresented]);
  const onLayout = useCallback(() => setLaidOut(true), []);
  const onPress = useCallback((climb: Climb) => setSelected(climb.uuid), []);
  const menu = useMemo<ClimbListRowViewProps['menu']>(
    () => ({
      rows: buildPlayDrawerMenuRows(
        buildClimbMenuItems(
          { climb: climbs[0], boardConfig: STORY_BOARD, currentUserId: 'story-user', isAuthenticated: true },
          {
            t,
            actionColors,
            activeClimbUuid: null,
            wallArchived: false,
            moderationEnabled: true,
            isFavorited: false,
            canReplay: false,
          },
          noop,
        ),
        { hidden: ALL_BUTTONS_HIDDEN, boardMismatch: false, isActiveClimb: false, groups: LIST_GROUPS },
      ),
      onSelectIndex: noop,
      menuKey: 'story-climb-actions',
      accessibilityActions: [],
      onAccessibilityAction: noop,
    }),
    [t, actionColors, climbs, STORY_BOARD],
  );
  const renderItem = useCallback(
    ({ item }: { item: Climb }) => (
      <ClimbListRowView
        {...STORY_BOARD}
        climb={item}
        onPress={onPress}
        selected={selected === item.uuid}
        quickActionsEnabled
        thumbnailEnabled
        showMoreButton
        openMenuRequest={scene === 'actions' && artReady && item.uuid === climbs[0].uuid ? 'story-open' : undefined}
        onMenuPresented={onMenuPresented}
        renderContent={renderContent}
        menu={menu}
      />
    ),
    [onPress, selected, menu, scene, artReady, onMenuPresented, climbs, STORY_BOARD],
  );
  const toggleFilter = useCallback(() => setFiltered((current) => !current), []);
  const filterChrome = (
    <FilterChipRow
      pinnedChips={['grade', 'progress', 'sort']}
      activeFilterCount={filtered ? 1 : 0}
      onOpenFilters={toggleFilter}
      gradeLabel={filtered ? (fixture.gradeRange?.label ?? 'V4–V6') : t('mobile.filter.grade')}
      gradeActive={filtered}
      onOpenGrade={toggleFilter}
      gradeRailOpen={false}
      onCloseGrade={noop}
      dimensionChips={[]}
      minAscents={undefined}
      onChangePopularity={noop}
      minRating={undefined}
      onChangeRating={noop}
      progress="all"
      onChangeProgress={noop}
      canFilterProgress
      collection="any"
      onChangeCollection={noop}
      canFilterPersonalCollections
      isSprayWall={STORY_BOARD.boardName === 'spray'}
      boardName={STORY_BOARD.boardName}
      accuracyValue="off"
      onChangeAccuracy={noop}
      climbType="boulders"
      onChangeClimbType={noop}
      betaActive={false}
      onToggleBeta={noop}
      benchmarksActive={false}
      onToggleBenchmarks={noop}
      sortBy="ascents"
      onChangeSort={noop}
      dense={selectByVariant(variant, { material: true, liquidGlass: false })}
    />
  );
  const leftActions = (
    <GlassActionToolbar actionCount={2}>
      <GlassToolbarAction onPress={noop} accessibilityLabel={tCommon('mobile.nav.you')}>
        <Icon name="person" size={22} color={systemColors.label} />
      </GlassToolbarAction>
      <GlassToolbarAction onPress={noop} accessibilityLabel="40°">
        <Text variant="subheadline">40°</Text>
      </GlassToolbarAction>
    </GlassActionToolbar>
  );
  const rightActions = (
    <GlassActionToolbar actionCount={2}>
      <GlassToolbarAction onPress={noop} accessibilityLabel={STORY_BOARD.name}>
        <Icon name="boards" size={22} color={systemColors.label} />
      </GlassToolbarAction>
      <GlassToolbarAction onPress={noop} accessibilityLabel={t('mobile.filter.title')}>
        <Icon name="more.actions" size={22} color={systemColors.label} />
      </GlassToolbarAction>
    </GlassActionToolbar>
  );
  const glassHeader = (children: ReactNode) =>
    nativeHeader ? (
      <NativeRootHeader
        titleHidden
        leftActions={leftActions}
        rightActions={rightActions}
        centerActionWidths={{ leading: 76, trailing: 76 }}
        onHeightChange={setChromeHeight}
      >
        {children}
      </NativeRootHeader>
    ) : (
      <CollapsingLargeTitleHeader
        leftActions={leftActions}
        rightActions={rightActions}
        onHeightChange={setChromeHeight}
      >
        {children}
      </CollapsingLargeTitleHeader>
    );
  const emptyStatus: ClimbsEmptyStateProps['status'] =
    scene === 'loading' ? 'loading' : scene === 'error' ? 'error' : scene === 'offline' ? 'offline-filter' : 'empty';
  return (
    <ErrorContext.Provider value={onError}>
      <ReadyContext.Provider value={markArtReady}>
        <View style={styles.fill} onLayout={onLayout}>
          <ClimbsView
            thumbnailSize={thumbnailSize}
            clipStyle={clipStyle}
            listProps={{
              data: showRows ? climbs : [],
              renderItem,
              keyExtractor,
              contentInsetAdjustmentBehavior: nativeHeader ? 'automatic' : 'never',
              contentContainerStyle: {
                paddingTop: selectByVariant(variant, { material: 0, liquidGlass: chromeHeight }),
                paddingBottom: bottomInset,
              },
              refreshControl: <RefreshControl refreshing={scene === 'refreshing'} onRefresh={noop} />,
              ListEmptyComponent: (
                <ClimbsEmptyState
                  status={emptyStatus}
                  offlineFilterReason="offline"
                  boardName={STORY_BOARD.name}
                  angle={40}
                  query=""
                  tokens={[]}
                  lockedDimensions={NO_LOCKED_DIMENSIONS}
                  canCreateClimb
                  onRetry={noop}
                  onClearFilters={toggleFilter}
                  onCreate={noop}
                  onOpenFilters={toggleFilter}
                  loadingContent={
                    <View>
                      {[0, 1, 2].map((index) => (
                        <ClimbListRowSkeletonView key={index} display={DEFAULT_CLIMB_ROW_DISPLAY} />
                      ))}
                    </View>
                  }
                />
              ),
            }}
            chrome={
              <ClimbTopChromeView
                canCreate
                onCreate={noop}
                onOpenBoardDetail={noop}
                onHeightChange={setChromeHeight}
                onCloseGrade={noop}
                onDismissGradePopover={noop}
                boardName={STORY_BOARD.boardName}
                onOpenFilters={toggleFilter}
                filterChrome={filterChrome}
                showPersistentChips
                glassGradeRail={false}
                materialCreateInMenu
                wallCapsule={undefined}
                glassHeader={glassHeader}
                materialLeading={
                  <>
                    <Appbar.Action icon={iconMap.person.android} onPress={noop} />
                    <Appbar.Content title="40°" />
                  </>
                }
                materialTrailing={
                  <>
                    <Appbar.Action icon={iconMap.boards.android} onPress={noop} />
                    <Appbar.Action icon={iconMap['more.actions'].android} onPress={noop} />
                  </>
                }
              />
            }
          />
        </View>
      </ReadyContext.Provider>
    </ErrorContext.Provider>
  );
}

const scenes: Scene[] = ['populated', 'loading', 'refreshing', 'empty', 'error', 'offline', 'filtered', 'actions'];
const stories: StoryModule = {
  title: 'Screens / Climbs',
  stories: Object.fromEntries(
    scenes.map((scene) => [
      scene,
      {
        name: `Climbs · ${scene}`,
        layout: 'fullscreen' as const,
        tab: 'climbs' as const,
        readiness: 'explicit' as const,
        render: ({ onReady, onError }) => <ClimbsStory scene={scene} onReady={onReady} onError={onError} />,
      },
    ]),
  ),
};
export default stories;
const styles = StyleSheet.create({ fill: { flex: 1 } });
