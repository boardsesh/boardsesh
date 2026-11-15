import { getBoulderGradesForBoard, MOONBOARD_DIFFICULTY_IDS } from '@boardsesh/board-constants/boulder-grade-mapping';
import { getTallWideScope } from '@boardsesh/board-constants';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { isVerifiedBoard } from '../../lib/benchmark-term';
import { selectByVariant } from '../../theme/variants';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  PROGRESS_FILTER_VALUES,
  type ProgressFilter,
  progressToFlags,
  flagsToProgress,
} from '@boardsesh/climb-filters';
import type { StoryModule } from '../../dev/stories/types';
import { DEFAULT_FILTERS, type ClimbFilters } from '../../lib/climb-filter-types';
import { progressFilterLabel } from '../../lib/filter-labels';
import { getCollectionFilter, collectionPatch, offersBenchmarksFilter } from '../../lib/collection-filter';
import { ClimbFilterSheetContent } from '../ClimbFilterSheetContent';
import { SwitchRow } from '../SwitchRow';
import { NO_LOCKED_DIMENSIONS } from '../../lib/dimension-chips';
import { useTheme } from '../../providers/theme-provider';
import {
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  climbTypePatch,
  getClimbTypeFilter,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import { buildClimbFilterFormModel, type ClimbFilterFormInput } from '../filter-sheet/climb-filter-form-model';
import { ClimbFilterForm } from '../ClimbFilterForm';
import { ClimbFilterSurface } from '../ClimbFilterSurface';
import type { ClimbFilterSurfaceHandle } from '../ClimbFilterSurface.types';
import { MEDIUM_LARGE_SNAP_POINTS, LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { GradeRangeRail } from '../grade';
import { useStoryBoardFixture } from '../../dev/stories/story-board-fixture';
import { ClimbsStory } from './Climbs.stories';
const noop = () => {};
function FiltersStory({ onReady, onError }: { onReady: () => void; onError: (error: unknown) => void }) {
  const fixture = useStoryBoardFixture();
  const STORY_BOARD = fixture.board;
  const { t } = useTranslation('climbs');
  const { variant } = useTheme();
  const nativeForm = Platform.OS === 'ios' && selectByVariant(variant, { liquidGlass: true, material: false });
  const [boardFilters, setBoardFilters] = useState<ClimbBoardFilterState>(DEFAULT_CLIMB_BOARD_FILTER_STATE);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [sheetReady, setSheetReady] = useState(false);
  const markBackgroundReady = useCallback(() => setBackgroundReady(true), []);
  const markSheetReady = useCallback(() => setSheetReady(true), []);
  useEffect(() => {
    if (backgroundReady && sheetReady) onReady();
  }, [backgroundReady, sheetReady, onReady]);
  const [filters, setFilters] = useState<ClimbFilters>(() =>
    fixture.gradeRange
      ? { ...DEFAULT_FILTERS, minGrade: fixture.gradeRange.minGrade, maxGrade: fixture.gradeRange.maxGrade }
      : DEFAULT_FILTERS,
  );
  const isSprayWall = STORY_BOARD.boardName === 'spray';
  const offerBenchmarks = offersBenchmarksFilter(isSprayWall, !!boardFilters.onlyBenchmarks);
  const { hasShorter, hasNarrower } = getTallWideScope(STORY_BOARD.boardName, STORY_BOARD.layoutId, STORY_BOARD.sizeId);
  const showOtherAngles = getBoardCapabilities(STORY_BOARD.boardName).angleBoundClimbs;
  const showClimbType = !isSprayWall || getClimbTypeFilter(filters) === 'routes';
  const handleBenchmarksChange = (onlyBenchmarks: boolean) =>
    setBoardFilters((previous) => ({ ...previous, onlyBenchmarks }));
  const [name, setName] = useState('');
  const [visible, setVisible] = useState(true);
  const ref = useRef<ClimbFilterSurfaceHandle>(null);
  const setFiltersPatch = useCallback(
    (patch: Partial<ClimbFilters>) => setFilters((previous) => ({ ...previous, ...patch })),
    [],
  );
  const onReset = () => {
    setFilters(DEFAULT_FILTERS);
    setBoardFilters(DEFAULT_CLIMB_BOARD_FILTER_STATE);
    setName('');
  };
  const grade = {
    grades: getBoulderGradesForBoard(STORY_BOARD.boardName)
      .filter((grade) => STORY_BOARD.boardName !== 'moonboard' || MOONBOARD_DIFFICULTY_IDS.has(grade.difficulty_id))
      .map((grade) => ({ difficultyId: grade.difficulty_id, name: grade.difficulty_name })),
    bound: { minGradeId: filters.minGrade, maxGradeId: filters.maxGrade },
    boardName: STORY_BOARD.boardName,
    onChange: (bound: { minGradeId?: number; maxGradeId?: number }) =>
      setFiltersPatch({ minGrade: bound.minGradeId, maxGrade: bound.maxGradeId }),
  };
  const input: ClimbFilterFormInput = {
    t,
    filters,
    isAuthenticated: true,
    name: {
      value: name,
      placeholder: t('search.placeholders.climbs'),
      clearLabel: t('mobile.filter.clearAll'),
      onChangeText: setName,
      onClear: () => setName(''),
      onFocus: noop,
    },
    recent: { items: [], currentId: undefined, onSelect: noop },
    grade: { rail: <GradeRangeRail {...grade} />, native: grade, height: 60 },
    accuracy: {
      options: [
        { key: 'off', label: t('mobile.filter.accuracy.off') },
        { key: '0.2', label: t('mobile.filter.accuracy.loose') },
        { key: '0.1', label: t('mobile.filter.accuracy.moderate') },
        { key: '0.05', label: t('mobile.filter.accuracy.tight') },
      ],
      onSelect: (gradeAccuracy) =>
        setFiltersPatch({ gradeAccuracy: gradeAccuracy === 'off' ? undefined : gradeAccuracy }),
    },
    progress: {
      labels: Object.fromEntries(PROGRESS_FILTER_VALUES.map((key) => [key, progressFilterLabel(key, t)])) as Record<
        ProgressFilter,
        string
      >,
      selected: flagsToProgress(filters),
      onSelect: (progress) => setFiltersPatch(progressToFlags(progress)),
      showMyRating: true,
    },
    collection: {
      options: [
        { key: 'any', label: t('mobile.filter.collection.any') },
        { key: 'drafts', label: t('mobile.filter.drafts') },
        { key: 'liked', label: t('mobile.filter.collection.liked') },
      ],
      selected: getCollectionFilter(filters),
      onSelect: (key) => setFiltersPatch(collectionPatch(key, filters).filters),
    },
    benchmarks: offerBenchmarks
      ? {
          label: isVerifiedBoard(STORY_BOARD.boardName)
            ? t('mobile.filter.onlyVerified')
            : t('mobile.filter.onlyBenchmarks'),
          subtitle: isVerifiedBoard(STORY_BOARD.boardName) ? t('mobile.filter.verifiedDescription') : undefined,
          value: !!boardFilters.onlyBenchmarks,
          onValueChange: handleBenchmarksChange,
        }
      : null,
    popularity: {
      onStatusChange: (status) => setFiltersPatch({ status }),
      onBucket: (minAscents) => setFiltersPatch({ minAscents }),
    },
    climbType: {
      show: showClimbType,
      options: [
        { key: 'boulders', label: t('mobile.filter.climbType.boulders') },
        { key: 'routes', label: t('mobile.filter.climbType.routes') },
      ],
      selected: getClimbTypeFilter(filters),
      onSelect: (key) => setFiltersPatch(climbTypePatch(key)),
    },
    showOtherAngles,
    tall: { show: hasShorter, locked: false },
    wide: { show: hasNarrower, locked: false },
    showFollowing: true,
    showBeta: true,
    boardFit: null,
    pickers: {
      setters: { show: true, disabled: false, value: t('mobile.filter.none'), onPress: noop },
      holds: { show: true, disabled: false, value: t('mobile.filter.none'), onPress: noop },
      zone: { show: true, disabled: false, value: t('mobile.filter.none'), onPress: noop },
    },
    sort: {
      kind: 'climbs',
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      labels: {
        ascents: t('mobile.filter.sort.ascents'),
        quality: t('mobile.filter.sort.quality'),
        difficulty: t('mobile.filter.sort.difficulty'),
        name: t('mobile.filter.sort.name'),
        popular: t('mobile.filter.sort.popular'),
        creation: t('mobile.filter.sort.creation'),
        random: t('mobile.filter.sort.random'),
      },
      orderOptions: [
        { key: 'asc', label: t('mobile.filter.sortOrder.asc') },
        { key: 'desc', label: t('mobile.filter.sortOrder.desc') },
      ],
      onSortBy: (sortBy) => setFiltersPatch({ sortBy }),
      onSortOrder: (order) => setFiltersPatch({ sortOrder: order === 'asc' ? 'asc' : 'desc' }),
      onReshuffle: noop,
    },
    quickFilters: {
      label: t('mobile.filter.quickFiltersLink'),
      footer: t('mobile.filter.quickFiltersFooter'),
      onPress: noop,
    },
    setFiltersPatch,
  };
  const model = buildClimbFilterFormModel(input);
  useEffect(() => {
    if (Platform.OS === 'android') ref.current?.present();
  }, [onError]);
  return (
    <View style={{ flex: 1 }}>
      <ClimbsStory scene="populated" onReady={markBackgroundReady} onError={onError} />
      {Platform.OS === 'android' ? (
        <ClimbFilterSurface
          ref={ref}
          model={model}
          title={t('mobile.filter.title')}
          subtitle={t('mobile.filter.matchingCount', { count: fixture.climbs.length })}
          closeLabel={t('mobile.filter.close')}
          resetLabel={t('mobile.filter.reset')}
          resetDisabled={false}
          onClosePress={() => ref.current?.dismiss()}
          onReset={onReset}
          onPresented={markSheetReady}
          onChange={noop}
        />
      ) : (
        <ModalSheet
          visible={visible}
          snapPoints={nativeForm ? MEDIUM_LARGE_SNAP_POINTS : LARGE_SNAP_POINTS}
          scrollable={false}
          onPresented={markSheetReady}
          onClose={() => setVisible(false)}
          header={
            <SheetTopBar
              title={t('mobile.filter.title')}
              subtitle={t('mobile.filter.matchingCount', { count: fixture.climbs.length })}
              leading={{
                kind: 'close',
                onPress: () => setVisible(false),
                accessibilityLabel: t('mobile.filter.close'),
              }}
              trailing={{ kind: 'forward', label: t('mobile.filter.reset'), onPress: onReset }}
            />
          }
        >
          {nativeForm ? (
            <ClimbFilterForm model={model} />
          ) : (
            <ClimbFilterSheetContent
              subRoute={{}}
              scrollContentStyle={{ paddingBottom: 32 }}
              nameDraft={name}
              handleNameTextChange={setName}
              handleClearNameField={() => setName('')}
              namePlaceholder={input.name.placeholder}
              shownSections={{
                recent: true,
                drafts: true,
                setters: true,
                holds: true,
                zone: true,
                otherAngles: true,
                progress: true,
                myRating: true,
                liked: true,
                following: true,
                beta: true,
              }}
              recentFilters={[]}
              pinProps={() => ({})}
              currentRecentId={undefined}
              handleSelectRecent={noop}
              grades={grade.grades}
              selectedFilters={filters}
              lastUsedGradeId={undefined}
              gradesBoardName={STORY_BOARD.boardName}
              handleGradeChange={grade.onChange}
              accuracyOptions={input.accuracy.options}
              accuracyValue={filters.gradeAccuracy ?? 'off'}
              handleAccuracyChange={input.accuracy.onSelect}
              isAuthenticated
              progressLabels={input.progress!.labels}
              handleProgressChange={input.progress!.onSelect}
              showMyRating
              handleClearMyRating={() => setFiltersPatch({ minUserRating: undefined })}
              setFiltersPatch={setFiltersPatch}
              collectionOptions={input.collection.options}
              collectionFilter={input.collection.selected}
              handleCollectionChange={input.collection.onSelect}
              offerBenchmarks={offerBenchmarks}
              boardName={STORY_BOARD.boardName}
              selectedBoardFilters={boardFilters}
              handleBenchmarksChange={handleBenchmarksChange}
              handleClearMinRating={() => setFiltersPatch({ minRating: undefined })}
              handleStatusChange={input.popularity.onStatusChange}
              popularityLabel={(bucket) => (bucket == null ? t('mobile.filter.anyRating') : String(bucket))}
              handlePopularity={input.popularity.onBucket}
              showClimbTypeControl={showClimbType}
              climbTypeOptions={input.climbType.options}
              climbTypeKey={input.climbType.selected}
              handleClimbTypeChange={input.climbType.onSelect}
              showOtherAnglesControl={showOtherAngles}
              showTallControl={hasShorter}
              lockedDimensions={NO_LOCKED_DIMENSIONS}
              showWideControl={hasNarrower}
              formatSetterSelection={(names) => names.join(', ')}
              openSetters={noop}
              settersRowNeedsBoard
              boardConfig={STORY_BOARD}
              followingSwitch={
                <SwitchRow
                  label={t('authors.followingClimbs')}
                  value={!!filters.onlyFollowedAuthors}
                  onValueChange={(onlyFollowedAuthors) => setFiltersPatch({ onlyFollowedAuthors })}
                />
              }
              holdFilterCount={0}
              openHoldFilter={noop}
              zoneActive={false}
              openZoneFilter={noop}
              boardFit={undefined}
              sortControl={undefined}
              sortLabels={input.sort.kind === 'climbs' ? input.sort.labels : ({} as never)}
              handleSortByChange={(sortBy) => setFiltersPatch({ sortBy })}
              handleReshuffle={noop}
              sortOrderOptions={input.sort.orderOptions ?? []}
              handleSortOrderChange={(order) => setFiltersPatch({ sortOrder: order === 'asc' ? 'asc' : 'desc' })}
            />
          )}
        </ModalSheet>
      )}
    </View>
  );
}
const stories: StoryModule = {
  title: 'Screens / Climb filters',
  stories: {
    open: {
      name: 'Filters open',
      layout: 'fullscreen',
      tab: 'climbs',
      readiness: 'explicit',
      render: ({ onReady, onError }) => <FiltersStory onReady={onReady} onError={onError} />,
    },
  },
};
export default stories;
