import type { ComponentProps, ComponentRef, ReactNode, Ref } from 'react';
import { View, StyleSheet } from 'react-native';
import { BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../providers/theme-provider';
import type { Grade } from '@boardsesh/shared-schema';
import {
  SORT_OPTIONS,
  PROGRESS_FILTER_VALUES,
  flagsToProgress,
  type SortOption,
  type StatusFilter,
  type GradeAccuracyValue,
  type ClimbBoardFilterState,
  type BoardSearchConfig,
  type ProgressFilter,
  type ClimbTypeFilter,
} from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../lib/climb-filter-types';
import type { RecentFilter } from '../lib/recent-filter-store';
import type { FilterChipKind } from '../lib/pinnable-chips';
import type { CollectionFilter } from '../lib/collection-filter';
import type { LockedDimensions } from '../lib/dimension-chips';
import type { SegmentOption } from './SegmentedControl.types';
import type { ClimbFilterSheetBoardFit, FilterSortControl } from './ClimbFilterSheet';
import { spacing } from '../theme/tokens';
import { filterSheetStyles } from './filter-sheet/filter-sheet-styles';
import { FilterSheetSection } from './filter-sheet/FilterSheetSection';
import { FilterNameField } from './filter-sheet/FilterNameField';
import { FilterLabelRow } from './filter-sheet/FilterLabelRow';
import { RecentSearchRail } from './filter-sheet/RecentSearchRail';
import { GradeRangeRail } from './grade';
import { SegmentedControl } from './SegmentedControl';
import { FilterChip, FilterChipGroup } from './filter-sheet/FilterChip';
import { StarRating } from './StarRating';
import { SwitchRow } from './SwitchRow';
import { benchmarkFilterLabel, isVerifiedBoard } from '../lib/benchmark-term';
import { FilterTappableRow } from './filter-sheet/FilterTappableRow';
import { Button } from './Button';
export type ClimbFilterSheetContentProps = {
  subRoute: Pick<ComponentProps<typeof BottomSheetScrollView>, 'onScroll' | 'onContentSizeChange'> & {
    scrollRef?: Ref<ComponentRef<typeof BottomSheetScrollView>>;
  };
  scrollContentStyle: { paddingBottom: number };
  nameDraft: string;
  handleNameTextChange: (text: string) => void;
  handleClearNameField: () => void;
  namePlaceholder: string | undefined;
  shownSections: {
    recent: boolean;
    drafts: boolean;
    setters: boolean;
    holds: boolean;
    zone: boolean;
    otherAngles: boolean;
    progress: boolean;
    myRating: boolean;
    liked: boolean;
    following: boolean;
    beta: boolean;
  };
  recentFilters: readonly RecentFilter[];
  pinProps: (
    kind: FilterChipKind,
  ) => { pinned?: undefined; onTogglePin?: undefined } | { pinned: boolean; onTogglePin: () => void };
  currentRecentId: string | undefined;
  handleSelectRecent: (id: string) => void;
  grades: NoInfer<Grade[]> | undefined;
  selectedFilters: ClimbFilters;
  lastUsedGradeId: number | undefined;
  gradesBoardName: string;
  handleGradeChange: (grade: { minGradeId: number | undefined; maxGradeId: number | undefined }) => void;
  accuracyOptions: { key: GradeAccuracyValue | 'off'; label: string }[];
  accuracyValue: '0' | '0.2' | '0.1' | '0.05' | 'off';
  handleAccuracyChange: (value: GradeAccuracyValue | 'off') => void;
  isAuthenticated: boolean;
  progressLabels: Record<'projects' | 'all' | 'unsent' | 'untried' | 'sent', string>;
  handleProgressChange: (progress: ProgressFilter) => void;
  showMyRating: boolean;
  handleClearMyRating: () => void;
  setFiltersPatch: (patch: Partial<ClimbFilters>) => void;
  collectionOptions: (
    | { key: 'any'; label: string }
    | { key: 'drafts'; label: string }
    | { key: 'liked'; label: string }
  )[];
  collectionFilter: 'drafts' | 'liked' | 'any';
  handleCollectionChange: (collection: CollectionFilter) => void;
  offerBenchmarks: boolean;
  boardName: string;
  selectedBoardFilters: ClimbBoardFilterState;
  handleBenchmarksChange: (onlyBenchmarks: boolean) => void;
  handleClearMinRating: () => void;
  handleStatusChange: (status: StatusFilter) => void;
  popularityLabel: (bucket: number | undefined) => string;
  handlePopularity: (bucket: number | undefined) => void;
  showClimbTypeControl: boolean;
  climbTypeOptions: SegmentOption<'boulders' | 'routes' | 'both'>[];
  climbTypeKey: 'boulders' | 'routes' | 'both';
  handleClimbTypeChange: (key: ClimbTypeFilter) => void;
  showOtherAnglesControl: boolean;
  showTallControl: boolean;
  lockedDimensions: LockedDimensions;
  showWideControl: boolean;
  formatSetterSelection: (setters: readonly string[]) => string;
  openSetters: () => void;
  settersRowNeedsBoard: boolean;
  boardConfig: BoardSearchConfig | null;
  followingSwitch: ReactNode;
  holdFilterCount: number;
  openHoldFilter: () => void;
  zoneActive: boolean;
  openZoneFilter: () => void;
  boardFit: ClimbFilterSheetBoardFit | undefined;
  sortControl: FilterSortControl | undefined;
  sortLabels: Record<'ascents' | 'quality' | 'difficulty' | 'name' | 'popular' | 'creation' | 'random', string>;
  handleSortByChange: (sortBy: SortOption) => void;
  handleReshuffle: () => void;
  sortOrderOptions: { key: string; label: string }[];
  handleSortOrderChange: (sortOrder: string) => void;
};
const POPULARITY_BUCKETS: readonly (number | undefined)[] = [undefined, 2, 10, 100, 1000];
export function ClimbFilterSheetContent({
  subRoute,
  scrollContentStyle,
  nameDraft,
  handleNameTextChange,
  handleClearNameField,
  namePlaceholder,
  shownSections,
  recentFilters,
  pinProps,
  currentRecentId,
  handleSelectRecent,
  grades,
  selectedFilters,
  lastUsedGradeId,
  gradesBoardName,
  handleGradeChange,
  accuracyOptions,
  accuracyValue,
  handleAccuracyChange,
  isAuthenticated,
  progressLabels,
  handleProgressChange,
  showMyRating,
  handleClearMyRating,
  setFiltersPatch,
  collectionOptions,
  collectionFilter,
  handleCollectionChange,
  offerBenchmarks,
  boardName,
  selectedBoardFilters,
  handleBenchmarksChange,
  handleClearMinRating,
  handleStatusChange,
  popularityLabel,
  handlePopularity,
  showClimbTypeControl,
  climbTypeOptions,
  climbTypeKey,
  handleClimbTypeChange,
  showOtherAnglesControl,
  showTallControl,
  lockedDimensions,
  showWideControl,
  formatSetterSelection,
  openSetters,
  settersRowNeedsBoard,
  boardConfig,
  followingSwitch,
  holdFilterCount,
  openHoldFilter,
  zoneActive,
  openZoneFilter,
  boardFit,
  sortControl,
  sortLabels,
  handleSortByChange,
  handleReshuffle,
  sortOrderOptions,
  handleSortOrderChange,
}: ClimbFilterSheetContentProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const trackColor = systemColors.fill;
  return (
    <BottomSheetScrollView
      ref={subRoute.scrollRef}
      style={styles.scrollView}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={scrollContentStyle}
      onScroll={subRoute.onScroll}
      scrollEventThrottle={32}
      onContentSizeChange={subRoute.onContentSizeChange}
      // This sheet never hosted a text input before the name field below —
      // without this, a first tap on Close/Reset/another row while the
      // keyboard is up over the field can be swallowed (standard RN
      // ScrollView gotcha; the tap dismisses the keyboard instead of firing).
      keyboardShouldPersistTaps="handled"
    >
      {/* Flat, labeled sections — no accordions. The scroll body is one column
              child (filterSheetStyles.body) so the native sheet scrolls. */}
      <View style={filterSheetStyles.body}>
        {/* 1 · NAME — the climb-name search: no list has a search field of its
                own, so this first row is where it lives (#3606). Committed live via
                onNameChange/onClearName. */}
        <FilterSheetSection title={t('mobile.filter.section.name')} first>
          <FilterNameField
            value={nameDraft}
            onChangeText={handleNameTextChange}
            onClear={handleClearNameField}
            placeholder={namePlaceholder ?? t('search.placeholders.climbs')}
            accessibilityLabel={t('mobile.filter.section.name')}
          />
          {/* Recent: the saved searches as chips, a tap applies one. The
                  row and its pin (the toolbar Recent chip's) show with no
                  history too, with a line saying where searches will appear. */}
          {shownSections.recent ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow
                label={t('mobile.search.recentFilters')}
                description={recentFilters.length > 0 ? undefined : t('mobile.filter.recentDescription')}
                {...pinProps('recent')}
              />
              {recentFilters.length > 0 ? (
                <RecentSearchRail
                  recents={recentFilters}
                  currentId={currentRecentId}
                  onSelect={handleSelectRecent}
                  style={filterSheetStyles.inlineRail}
                />
              ) : null}
            </>
          ) : null}
        </FilterSheetSection>

        {/* 2 · DIFFICULTY — grade bound + grade accuracy. */}
        <FilterSheetSection title={t('mobile.filter.section.difficulty')}>
          {/* The inline grade rail updates the live selection. Its own title
                is replaced by a pinnable label row. */}
          <FilterLabelRow label={t('mobile.filter.gradeRange')} {...pinProps('grade')} />
          <GradeRangeRail
            grades={grades ?? []}
            bound={{ minGradeId: selectedFilters.minGrade, maxGradeId: selectedFilters.maxGrade }}
            lastUsedGradeId={lastUsedGradeId}
            boardName={gradesBoardName}
            onChange={handleGradeChange}
            style={filterSheetStyles.inlineRail}
          />

          <View style={filterSheetStyles.subsectionGap} />
          <FilterLabelRow
            label={t('mobile.filter.accuracy.label')}
            description={t('mobile.filter.accuracy.description')}
            {...pinProps('accuracy')}
          />
          <View style={filterSheetStyles.controlGap} />
          <SegmentedControl
            options={accuracyOptions}
            selectedKey={accuracyValue}
            onSelect={handleAccuracyChange}
            accessibilityLabel={t('mobile.filter.accuracy.label')}
          />
        </FilterSheetSection>

        {/* 3 · YOUR PROGRESS — auth-only; the per-user tick-flag selector plus
                the "My drafts" toggle (old Status 'drafts', with its side-effects). */}
        {isAuthenticated && shownSections.progress ? (
          <FilterSheetSection title={t('mobile.filter.progress.label')} {...pinProps('progress')}>
            {/* A single-select over the four per-user tick flags. "Projects" =
                  attempted-but-not-sent; "Unsent" = the old "hide climbs I've sent". */}
            <FilterChipGroup>
              {PROGRESS_FILTER_VALUES.map((value) => (
                <FilterChip
                  key={value}
                  label={progressLabels[value]}
                  value={value}
                  selected={flagsToProgress(selectedFilters) === value}
                  onPress={handleProgressChange}
                />
              ))}
            </FilterChipGroup>

            {/* My rating — the stars you gave, at the angle you're browsing.
                    The star row keeps climbs you never rated; the switch drops them.
                    A list whose rows all carry your stars (Five Stars) hides it,
                    unless a rating filter is already on. */}
            {showMyRating ? (
              <>
                <View style={filterSheetStyles.subsectionGap} />
                <FilterLabelRow
                  label={t('mobile.filter.myRating')}
                  description={t('mobile.filter.myRatingDescription')}
                />
                <View style={filterSheetStyles.ratingRow}>
                  <FilterChip
                    label={t('mobile.filter.anyRating')}
                    value={undefined}
                    selected={selectedFilters.minUserRating == null}
                    onPress={handleClearMyRating}
                  />
                  <StarRating
                    value={selectedFilters.minUserRating}
                    onChange={(value) => setFiltersPatch({ minUserRating: value })}
                    clearValue={undefined}
                  />
                </View>
                <SwitchRow
                  label={t('mobile.filter.onlyRatedByMe')}
                  value={!!selectedFilters.onlyRatedByMe}
                  onValueChange={(value) => setFiltersPatch({ onlyRatedByMe: value || undefined })}
                />
              </>
            ) : null}
          </FilterSheetSection>
        ) : null}

        {/* 4 · QUALITY — benchmarks, min rating, popularity (incl. Unrepeated). */}
        <FilterSheetSection title={t('mobile.filter.section.quality')}>
          {/* Collection — My drafts and Liked are mutually exclusive, and
                  offered only when signed in. */}
          <FilterLabelRow label={t('mobile.filter.collection.label')} {...pinProps('collection')} />
          <View style={filterSheetStyles.controlGap} />
          <SegmentedControl
            options={collectionOptions}
            selectedKey={collectionFilter}
            onSelect={handleCollectionChange}
            accessibilityLabel={t('mobile.filter.collection.label')}
          />

          {/* Benchmarks only (Verified only on Kilter) — its own switch, so it
                  combines with My drafts or Liked. */}
          {offerBenchmarks ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow
                label={benchmarkFilterLabel(boardName, t)}
                description={isVerifiedBoard(boardName) ? t('mobile.filter.verifiedDescription') : undefined}
                {...pinProps('benchmarks')}
              />
              <SwitchRow
                label={isVerifiedBoard(boardName) ? t('mobile.filter.onlyVerified') : t('mobile.filter.onlyBenchmarks')}
                value={!!selectedBoardFilters.onlyBenchmarks}
                onValueChange={handleBenchmarksChange}
              />
            </>
          ) : null}

          <View style={filterSheetStyles.subsectionGap} />
          <FilterLabelRow label={t('mobile.filter.minRating')} {...pinProps('rating')} />
          <View style={filterSheetStyles.ratingRow}>
            <FilterChip
              label={t('mobile.filter.anyRating')}
              value={undefined}
              selected={selectedFilters.minRating == null}
              onPress={handleClearMinRating}
            />
            <StarRating
              value={selectedFilters.minRating}
              onChange={(value) => setFiltersPatch({ minRating: value })}
              clearValue={undefined}
            />
          </View>

          <View style={filterSheetStyles.subsectionGap} />
          <FilterLabelRow label={t('mobile.filter.popularity')} {...pinProps('popularity')} />
          {/* "Unrepeated" (status='projects') leads the group, then Any + the
                numeric min-ascents buckets. The whole row reads as single-select:
                picking any bucket clears projects (see handlePopularity), and the
                Unrepeated chip is selected iff status==='projects'. */}
          <FilterChipGroup>
            <FilterChip
              label={t('mobile.filter.popularityUnrepeated')}
              value="projects"
              selected={selectedFilters.status === 'projects'}
              onPress={handleStatusChange}
            />
            {POPULARITY_BUCKETS.map((bucket) => (
              <FilterChip
                key={bucket ?? 'any'}
                label={popularityLabel(bucket)}
                value={bucket}
                selected={selectedFilters.minAscents === bucket && selectedFilters.status !== 'projects'}
                onPress={handlePopularity}
              />
            ))}
          </FilterChipGroup>
        </FilterSheetSection>

        {/* 5 · THE CLIMB — type, angle, shape, setters, holds, zones, beta. */}
        <FilterSheetSection title={t('mobile.filter.section.theClimb')}>
          {showClimbTypeControl ? (
            <>
              <FilterLabelRow label={t('mobile.filter.climbType.label')} {...pinProps('climbType')} />
              <View style={filterSheetStyles.controlGap} />
              <SegmentedControl
                options={climbTypeOptions}
                selectedKey={climbTypeKey}
                onSelect={handleClimbTypeChange}
                textVariant="footnote"
                trackColor={trackColor}
              />
            </>
          ) : null}

          {showOtherAnglesControl ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <SwitchRow
                label={t('mobile.filter.otherAngles')}
                description={t('mobile.filter.otherAnglesDescription')}
                value={!!selectedFilters.includeOtherAngles}
                onValueChange={(value) => setFiltersPatch({ includeOtherAngles: value || undefined })}
              />
            </>
          ) : null}

          {/* Tall / Wide — shown wherever a shorter/narrower sibling size exists
                  (Kilter homewall, Tension Board 2, Decoy, Grasshopper); each only
                  where it applies. Matches the chip row so the filter stays
                  reachable here even when its chip is unpinned. They're separate
                  chips, so each gets a header naming its chip with the pin (the
                  Beta videos layout), keeping the switches aligned with the rest. */}
          {showTallControl ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.search.chips.tall')} {...pinProps('tall')} />
              {/* A locked Tall (iOS chip-row lock) reads on and can't be switched
                      off here; its hint says how to unlock it from the chip. */}
              <SwitchRow
                label={t('mobile.filter.tall')}
                description={
                  lockedDimensions.tall ? t('mobile.filter.tallLockedHint') : t('mobile.filter.tallDescription')
                }
                value={lockedDimensions.tall || !!selectedFilters.onlyTallClimbs}
                disabled={lockedDimensions.tall}
                onValueChange={(value) => setFiltersPatch({ onlyTallClimbs: value || undefined })}
              />
            </>
          ) : null}
          {showWideControl ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.search.chips.wide')} {...pinProps('wide')} />
              <SwitchRow
                label={t('mobile.filter.wide')}
                description={
                  lockedDimensions.wide ? t('mobile.filter.wideLockedHint') : t('mobile.filter.wideDescription')
                }
                value={lockedDimensions.wide || !!selectedFilters.onlyWideClimbs}
                disabled={lockedDimensions.wide}
                onValueChange={(value) => setFiltersPatch({ onlyWideClimbs: value || undefined })}
              />
            </>
          ) : null}

          {shownSections.setters ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterTappableRow
                label={t('mobile.filter.setters')}
                value={
                  selectedFilters.setter && selectedFilters.setter.length > 0
                    ? formatSetterSelection(selectedFilters.setter)
                    : t('mobile.filter.none')
                }
                onPress={openSetters}
                disabled={settersRowNeedsBoard && !boardConfig}
              />
            </>
          ) : null}

          {/* Following sits under the Setters row it belongs with; without
                  that row it takes the usual gap instead. */}
          {isAuthenticated && shownSections.following && shownSections.setters ? (
            <View style={styles.followingSection}>{followingSwitch}</View>
          ) : null}
          {isAuthenticated && shownSections.following && !shownSections.setters ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              {followingSwitch}
            </>
          ) : null}

          {shownSections.holds ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterTappableRow
                label={t('mobile.holdFilter.title')}
                value={
                  holdFilterCount > 0
                    ? t('mobile.holdFilter.summaryCount', { count: holdFilterCount })
                    : t('mobile.filter.none')
                }
                onPress={openHoldFilter}
                disabled={!boardConfig}
              />
            </>
          ) : null}

          {shownSections.zone ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterTappableRow
                label={t('mobile.zoneFilter.title')}
                value={zoneActive ? t('mobile.zoneFilter.summaryActive') : t('mobile.filter.none')}
                onPress={openZoneFilter}
                disabled={!boardConfig}
              />
            </>
          ) : null}

          {/* Beta videos — a content property of the climb, not a quality signal.
                  A group header carries the pin; the switch uses the descriptive line
                  as its label so "Beta videos" isn't worded twice. */}
          {shownSections.beta ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.filter.betaVideos')} {...pinProps('beta')} />
              <SwitchRow
                label={t('mobile.filter.betaVideosDescription')}
                value={!!selectedFilters.onlyWithBetaVideos}
                onValueChange={(value) => setFiltersPatch({ onlyWithBetaVideos: value || undefined })}
              />
            </>
          ) : null}

          {/* Fits my board — a playlist-only lever: hides the climbs set for
                  another board or size, the rows the list dims. */}
          {boardFit ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.filter.boardFit.label')} {...pinProps('boardFit')} />
              <SwitchRow
                label={t('mobile.filter.boardFit.switch')}
                description={t('mobile.filter.boardFit.description')}
                value={boardFit.value}
                onValueChange={boardFit.onChange}
              />
            </>
          ) : null}
        </FilterSheetSection>

        {/* 6 · SORT — sort key + direction (or reshuffle for random). */}
        <FilterSheetSection title={t('mobile.filter.section.sort')}>
          <FilterLabelRow label={t('mobile.filter.sortBy')} {...pinProps('sort')} />
          {/* Flex-wrap (matching the popularity/rating chip rows above), not a
                  horizontal ScrollView: a gesture-handler ScrollView nested in the
                  native bottom sheet collapsed the chip row's height on iOS and
                  clipped the labels. SORT_OPTIONS is short, so wrapping is fine. */}
          {sortControl ? (
            // A list's own sorts: its keys, then its directions in words
            // ("Easiest first"), Shuffle again for Random, nothing for a
            // one-direction key such as the playlist's own order.
            <>
              <FilterChipGroup>
                {sortControl.options.map((option) => (
                  <FilterChip
                    key={option.key}
                    label={option.label}
                    value={option.key}
                    selected={sortControl.selected === option.key}
                    onPress={sortControl.onSelect}
                  />
                ))}
              </FilterChipGroup>
              {sortControl.showReshuffle ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <Button
                    title={t('mobile.filter.sort.reshuffle')}
                    onPress={sortControl.onReshuffle}
                    variant="tonal"
                    size="medium"
                    icon="shuffle"
                  />
                </>
              ) : sortControl.orderOptions ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterLabelRow label={t('mobile.filter.sortOrderLabel')} />
                  <View style={filterSheetStyles.controlGap} />
                  <SegmentedControl
                    options={sortControl.orderOptions}
                    selectedKey={sortControl.order}
                    onSelect={sortControl.onOrderChange}
                    accessibilityLabel={t('mobile.filter.sortOrderLabel')}
                  />
                </>
              ) : null}
            </>
          ) : (
            <FilterChipGroup>
              {SORT_OPTIONS.map((option) => (
                <FilterChip
                  key={option}
                  label={sortLabels[option]}
                  value={option}
                  selected={selectedFilters.sortBy === option}
                  onPress={handleSortByChange}
                />
              ))}
            </FilterChipGroup>
          )}
          {/* For random, direction is meaningless — swap the asc/desc control for
                  an explicit reshuffle button (re-tapping the Random chip also works). */}
          {sortControl ? null : selectedFilters.sortBy === 'random' ? (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <Button
                title={t('mobile.filter.sort.reshuffle')}
                onPress={handleReshuffle}
                variant="tonal"
                size="medium"
                icon="shuffle"
              />
            </>
          ) : (
            <>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.filter.sortOrderLabel')} />
              <View style={filterSheetStyles.controlGap} />
              <SegmentedControl
                options={sortOrderOptions}
                selectedKey={selectedFilters.sortOrder}
                onSelect={handleSortOrderChange}
                textVariant="footnote"
                trackColor={trackColor}
              />
            </>
          )}
        </FilterSheetSection>
      </View>
    </BottomSheetScrollView>
  );
}
const styles = StyleSheet.create({ scrollView: { flex: 1 }, followingSection: { marginTop: spacing[4] } });
