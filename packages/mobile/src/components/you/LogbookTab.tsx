import { ReadableColumn } from '../ReadableColumn';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { ScrollEdgeListReset, type ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { useLogbookDeleteActions, usePendingLogbookDeletes } from '../../providers/logbook-delete-provider';
import { PressableSurface } from '../PressableSurface';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, RefreshControl, StyleSheet, useWindowDimensions } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import {
  toAscentFeedInput,
  DEFAULT_LOGBOOK_FILTERS,
  buildLogbookListRows,
  dedupeLogbookItems,
  shouldShowLogbookDividers,
  pickBestGroupEntry,
  sumGroupTries,
  logbookDayKey,
  logbookSortKeyOf,
  type LogbookFilterState,
  type LogbookSortState,
  type LogbookListRow,
} from '@boardsesh/logbook';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { FilterTokenRow } from '../search/FilterTokenRow';
import { LogbookRow } from './LogbookRow';
import { LogbookDayDivider, LogbookWallSubDivider } from './LogbookDayDivider';
import { LogbookEditSheet } from './LogbookEditSheet';
import { BoardLinkPrompt } from './BoardLinkPrompt';
import { LogbookFilterSheet } from './LogbookFilterSheet';
import { LogbookEntryChooserSheet } from './LogbookEntryChooserSheet';
import { LogbookChipRow } from './LogbookChipRow';
import { LogbookFacetRail } from './LogbookFacetRail';
import {
  buildLogbookFilterTokens,
  countLogbookFilters,
  logbookBoardLabel,
  type LogbookRailKind,
} from './logbook-capsules';
import { useLogbookSearch } from './use-logbook-search';
import { useLogbookBoardOptions } from './use-logbook-board-options';
import { useUserAscentsFeed, useUserGroupedAscentsFeed, useGrades } from '../../lib/graphql/hooks';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useToday } from '../../hooks/use-today';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { OfflineState } from '../OfflineState';
import type { Grade } from '@boardsesh/shared-schema';
import { useTickListActivation } from '../../lib/playlists/use-tick-list-activation';
import { tickToClimb } from '../../lib/tick-to-climb';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { buildGradeRailStops } from '../../lib/grade-stops';
import { useLogbookPinnedChips } from '../../lib/logbook-pinned-chips-store';
import { subscribeToLogbookSetterSelection } from '../../lib/logbook-setter-handoff';
import { createFilterPickerHandoffId } from '../../lib/filter-picker-handoff-id';
import { useScopedRouter } from '../../lib/routing/scoped-navigation';
import { getLayoutDisplayName } from '@boardsesh/profile-stats';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { normalizeSearchName } from '../../lib/search-name';
import { hapticSelection } from '../../lib/haptics';
import { opacity, spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

const SEARCH_DEBOUNCE_MS = 300;
// How long a setter push blocks another one if its picks never come back (a
// push that didn't land). Longer than the native push animation.
const SETTER_PUSH_RELEASE_MS = 1500;

// Kilter and Tension share an identical difficulty-id scale, so one board's grade
// list is the canonical scale for the grade capsule's label, the inline rail and
// the sheet's rail, so they never word a grade differently.
const GRADE_SCALE_BOARD = 'kilter';

// Stable empty grade list so the memo'd rails keep their `grades` prop identity
// while the grade query is still loading (undefined).
const EMPTY_GRADES: Grade[] = [];

/** Where a filter or sort change came from, for `Logbook Filter Changed` / `Logbook Sort Changed`. */
type LogbookChangeSurface = 'capsule' | 'rail' | 'sheet' | 'token' | 'setter_picker' | 'empty_state';

type LogbookTabProps = {
  userId: string | undefined;
  /** CPP captures scope the genuine server feed to the advertised board family. */
  screenshotBoardType?: string;
  /** Measured chrome height — the fixed toolbar insets its top by this so it
   *  rests below the floating chrome and results scroll beneath the toolbar. */
  topInset?: number;
  /**
   * Whether the signed-in user owns this logbook. Defaults to true (the You
   * tab). When false (viewing another climber's profile) a row opens the climb
   * read-only in the play drawer instead of the editable LogbookEditSheet.
   */
  viewerIsOwner?: boolean;
  /** Compose controls into a measured profile header instead of the in-flow toolbar. */
  renderHeader?: (controls: ReactNode, onHeightChange: (height: number) => void) => ReactNode;
  scrollEdge?: ScrollEdgeBackdrop;
};

// One list unit for both modes: in grouped (date-ordered) views it is the
// group's best-outcome entry extended with the day's summed tries and the
// sibling entries (for the chooser); in flat views the optional fields stay
// absent and the unit is just the tick.
type LogbookGroupUnit = AscentFeedItem & {
  wall?: string;
  groupTries?: number;
  groupItems?: AscentFeedItem[];
};

type GroupedFeedPages = NonNullable<ReturnType<typeof useUserGroupedAscentsFeed>['data']>['pages'];
type FlatFeedPages = NonNullable<ReturnType<typeof useUserAscentsFeed>['data']>['pages'];

type LogbookRowsInput = {
  groupedMode: boolean;
  showDividers: boolean;
  groupedPages: GroupedFeedPages | undefined;
  flatPages: FlatFeedPages | undefined;
  groupedHasMore: boolean;
  flatHasMore: boolean;
  hiddenTickUuids: ReadonlySet<string>;
};

// Wall label ("Alex's board") feeds the divider/subdivider context; board
// identity only — the angle stays on every row. Derivation needs the app's
// board metadata so it happens here, not in the shared builder.
const wallOf = (item: AscentFeedItem) => item.boardDisplayName ?? getLayoutDisplayName(item.boardType, item.layoutId);

/**
 * The logbook's rows from the loaded feed pages. A plain function of the pages
 * so a swipe track paging past the loaded rows (issue #6665) reads the list in
 * exactly the order the screen shows it.
 */
function buildLogbookRows({
  groupedMode,
  showDividers,
  groupedPages,
  flatPages,
  groupedHasMore,
  flatHasMore,
  hiddenTickUuids,
}: LogbookRowsInput): LogbookListRow<LogbookGroupUnit>[] {
  if (groupedMode) {
    const groups = groupedPages?.flatMap((page) => page.userGroupedAscentsFeed.groups) ?? [];
    // RE-BUCKET the backend groups client-side by (climb, LOCAL day, angle):
    // the resolver cuts groups on the stored UTC calendar day, which
    // disagrees with the local-day dividers on any non-UTC device (an
    // evening session would split), and its key ignores angle, which would
    // sum tries across angles under one row — the exact honesty rules the
    // redesign set. Flattening items and regrouping fixes both without a
    // backend timezone parameter; item-level dedupe absorbs group overlap
    // from offset pagination.
    const itemsByLocalKey = new Map<string, AscentFeedItem[]>();
    const seenTickUuids = new Set<string>();
    for (const group of groups) {
      for (const item of group.items) {
        if (seenTickUuids.has(item.uuid) || hiddenTickUuids.has(item.uuid)) continue;
        seenTickUuids.add(item.uuid);
        // isMirror splits the bucket: on Tension/Decoy the mirrored ascent is
        // its own problem — collapsing it with the normal orientation would
        // sum tries across orientations and mislabel the row's mirror tag.
        const localKey = `${item.climbUuid}|${logbookDayKey(item.climbedAt)}|${item.angle}|${item.isMirror}`;
        const bucket = itemsByLocalKey.get(localKey);
        if (bucket) bucket.push(item);
        else itemsByLocalKey.set(localKey, [item]);
      }
    }
    const units: LogbookGroupUnit[] = Array.from(itemsByLocalKey.values()).map((bucketItems) => {
      const best = pickBestGroupEntry(bucketItems);
      // The unit's timestamp is the bucket's LATEST activity (not the best
      // entry's) so ordering reads "when did I last touch this today".
      const latestClimbedAt = bucketItems.reduce(
        (latest, item) => (item.climbedAt > latest ? item.climbedAt : latest),
        bucketItems[0].climbedAt,
      );
      return {
        ...best,
        climbedAt: latestClimbedAt,
        wall: wallOf(best),
        groupTries: sumGroupTries(bucketItems),
        groupItems: bucketItems,
      };
    });
    units.sort((a, b) => (a.climbedAt < b.climbedAt ? 1 : a.climbedAt > b.climbedAt ? -1 : 0));
    return buildLogbookListRows(units, { hasMore: groupedHasMore });
  }
  const items =
    flatPages?.flatMap((page) => page.userAscentsFeed.items).filter((item) => !hiddenTickUuids.has(item.uuid)) ?? [];
  if (showDividers) {
    // Date-ASC custom sort: dividers without grouping (the grouped resolver
    // is DESC-only) — one row per tick, exactly as before grouping existed.
    const withWalls = items.map((item) => ({ ...item, wall: wallOf(item) }));
    return buildLogbookListRows(withWalls, { hasMore: flatHasMore });
  }
  return dedupeLogbookItems(items).map((item) => ({ type: 'entry', key: item.uuid, item, wallCovered: false }));
}

/** The ticks a logbook's rows show, in the order it shows them. */
function logbookEntries(rows: LogbookListRow<LogbookGroupUnit>[]): LogbookGroupUnit[] {
  const entries: LogbookGroupUnit[] = [];
  for (const row of rows) if (row.type === 'entry') entries.push(row.item);
  return entries;
}

export function LogbookTab({
  userId,
  topInset = 0,
  viewerIsOwner = true,
  renderHeader,
  screenshotBoardType,
  scrollEdge,
}: LogbookTabProps) {
  const nativeRootHeader = useNativeRootHeader();
  const [headerHeight, setHeaderHeight] = useState(0);
  const hasComposedHeader = renderHeader != null;
  const headerMeasured = !hasComposedHeader || headerHeight > 0;
  const scrollHeaderInset = hasComposedHeader && nativeRootHeader ? headerHeight : 0;
  const { t, i18n } = useTranslation('you');
  const { t: tSession } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  // One grade scale for the grade capsule's label, the inline rail and the sheet.
  const { data: grades } = useGrades(GRADE_SCALE_BOARD);
  const { gradeFormat } = useGradeFormat();
  const gradeStops = useMemo(
    () => buildGradeRailStops(grades ?? EMPTY_GRADES, gradeFormat, GRADE_SCALE_BOARD),
    [grades, gradeFormat],
  );
  const boardOptions = useLogbookBoardOptions(userId);
  const { pinned: pinnedChips, isPinned } = useLogbookPinnedChips();
  const scopedRouter = useScopedRouter();
  const { openClimbActions } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  // One dimension subscription for the whole list; rows take fontScale as a prop.
  const { fontScale } = useWindowDimensions();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];
  // Day-granular: rolls over on focus and on foreground, so "Last 7 days" and
  // "This month" move with the calendar. Frozen in screenshot mode.
  const today = useToday();
  const locale = i18n.language;

  const editSheetRef = useRef<BottomSheet | null>(null);
  const [editAscent, setEditAscent] = useState<AscentFeedItem | null>(null);

  // Logbook search/filter/sort state. The name is typed in the filter sheet and
  // debounced before it commits to the query. Only your own logbook saves its
  // filters; someone else's keeps them for the visit.
  const logbookSearch = useLogbookSearch({ persist: viewerIsOwner });
  const { filters, sort, name, setName, setSort, setFilters, reset, hydrated } = logbookSearch;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // Which inline rail is open under the capsule row; one at a time. A rail only
  // shows while its capsule is pinned: the capsule is its one way out.
  const [openRail, setOpenRail] = useState<LogbookRailKind | null>(null);
  const visibleRail = openRail != null && isPinned(openRail) ? openRail : null;
  const handleToggleRail = useCallback((rail: LogbookRailKind) => {
    hapticSelection();
    setOpenRail((current) => (current === rail ? null : rail));
  }, []);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimeout(debounceTimerRef.current ?? undefined), []);

  // Each change is instrumented before it commits. Privacy: the changed field
  // NAMES go as a sorted comma-joined string (analytics values are scalar), never
  // the grade, date or setter values; `surface` says which control made it.
  const changeFilters = useCallback(
    (patch: Partial<LogbookFilterState>, surface: LogbookChangeSurface) => {
      track(SHARED_EVENTS.LogbookFilterChanged, { fields: Object.keys(patch).sort().join(','), surface });
      setFilters(patch);
    },
    [setFilters],
  );
  const changeSort = useCallback(
    (nextSort: LogbookSortState, surface: LogbookChangeSurface) => {
      const { key, direction } = logbookSortKeyOf(nextSort);
      track(SHARED_EVENTS.LogbookSortChanged, {
        preset: nextSort.mode === 'preset' ? nextSort.preset : 'custom',
        sortKey: key,
        direction,
        surface,
      });
      setSort(nextSort);
    },
    [setSort],
  );
  // One stable handler per surface, so the memo'd row, rail and sheet hold.
  const handleCapsuleFilters = useCallback(
    (patch: Partial<LogbookFilterState>) => changeFilters(patch, 'capsule'),
    [changeFilters],
  );
  const handleRailFilters = useCallback(
    (patch: Partial<LogbookFilterState>) => changeFilters(patch, 'rail'),
    [changeFilters],
  );
  const handleSheetFilters = useCallback(
    (patch: Partial<LogbookFilterState>) => changeFilters(patch, 'sheet'),
    [changeFilters],
  );
  const handleTokenFilters = useCallback(
    (patch: Partial<LogbookFilterState>) => changeFilters(patch, 'token'),
    [changeFilters],
  );
  const handleCapsuleSort = useCallback((nextSort: LogbookSortState) => changeSort(nextSort, 'capsule'), [changeSort]);
  const handleSheetSort = useCallback((nextSort: LogbookSortState) => changeSort(nextSort, 'sheet'), [changeSort]);
  const handleTokenSort = useCallback((nextSort: LogbookSortState) => changeSort(nextSort, 'token'), [changeSort]);

  // The sheet's name field reports every keystroke; the term commits 300 ms after
  // the last one. Privacy: only the committed term's length is tracked, never
  // its text, and clearing back to '' is not a search.
  const handleNameChange = useCallback(
    (text: string) => {
      const nextName = normalizeSearchName(text);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        setName(nextName);
        if (nextName) track(SHARED_EVENTS.LogbookSearched, { length: nextName.length });
      }, SEARCH_DEBOUNCE_MS);
    },
    [setName],
  );
  // The field's ×, the name token and Reset clear the committed term at once.
  const clearName = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setName('');
  }, [setName]);

  const handleReset = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    track(SHARED_EVENTS.LogbookFilterChanged, { fields: 'reset', surface: 'sheet' });
    reset();
  }, [reset]);

  // The empty state's "Clear filters": every filter and the name, not the sort.
  const handleClearFilters = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    track(SHARED_EVENTS.LogbookFilterChanged, { fields: 'all', surface: 'empty_state' });
    setName('');
    setFilters(DEFAULT_LOGBOOK_FILTERS);
  }, [setName, setFilters]);

  // Which section the sheet opens scrolled to: the top, or When for "Custom…".
  const [sheetSection, setSheetSection] = useState<'when' | undefined>(undefined);
  const handleOpenFilters = useCallback(() => {
    hapticSelection();
    // Close any open inline rail so it doesn't linger under the sheet.
    setOpenRail(null);
    setSheetSection(undefined);
    setFilterSheetOpen(true);
  }, []);
  const handleOpenCustomDates = useCallback(() => {
    setOpenRail(null);
    setSheetSection('when');
    setFilterSheetOpen(true);
  }, []);

  const handleCloseFilters = useCallback(() => setFilterSheetOpen(false), []);

  // The setter picker is a route (native sheets can't stack). The capsule pushes
  // it directly; the sheet suspends itself first. The picks come back through
  // the handoff below, addressed to this Logbook alone.
  const [setterHandoffId] = useState(createFilterPickerHandoffId);
  // One picker at a time: set on push, cleared when its picks come back (every
  // removal hands them back) or, should the push never land, after a beat.
  const setterPushInFlightRef = useRef(false);
  const setterPushReleaseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseSetterPush = useCallback(() => {
    setterPushInFlightRef.current = false;
    if (setterPushReleaseRef.current) clearTimeout(setterPushReleaseRef.current);
    setterPushReleaseRef.current = null;
  }, []);
  useEffect(() => releaseSetterPush, [releaseSetterPush]);
  /**
   * Pushes the setter picker. `beforePush` runs only once the push is going
   * ahead (the sheet suspends there), so a refused push never hides the sheet.
   * Returns whether it pushed.
   */
  const handleOpenSetters = useCallback(
    (beforePush?: () => void): boolean => {
      if (!userId || setterPushInFlightRef.current) return false;
      setterPushInFlightRef.current = true;
      setterPushReleaseRef.current = setTimeout(releaseSetterPush, SETTER_PUSH_RELEASE_MS);
      beforePush?.();
      const current = filtersRef.current;
      scopedRouter.push({
        pathname: '/users/[userId]/logbook-setters',
        params: {
          userId,
          handoffId: setterHandoffId,
          setters: JSON.stringify(current.setterUsernames),
          boardType: current.boardType,
          layoutIds: JSON.stringify(current.layoutIds),
        },
      });
      return true;
    },
    [userId, scopedRouter, setterHandoffId, releaseSetterPush],
  );

  useEffect(
    () =>
      subscribeToLogbookSetterSelection(setterHandoffId, ({ setterUsernames, apply }) => {
        releaseSetterPush();
        const current = filtersRef.current.setterUsernames;
        const unchanged =
          current.length === setterUsernames.length &&
          current.every((setter, index) => setter === setterUsernames[index]);
        if (!unchanged) changeFilters({ setterUsernames }, 'setter_picker');
        // "Show climbs": back to the list. A suspended sheet closes rather than
        // coming back over it.
        if (apply) setFilterSheetOpen(false);
      }),
    [setterHandoffId, changeFilters, releaseSetterPush],
  );

  // The query input is rebuilt only when the committed filters/sort/name or the
  // calendar day change, so the React Query key (and the FlashList data
  // identity downstream) is stable between unrelated re-renders.
  const feedInput = useMemo(() => {
    const cppBoardTypes =
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' &&
      process.env.EXPO_PUBLIC_SCREENSHOT_CPP_URL &&
      screenshotBoardType &&
      ['kilter', 'tension', 'moonboard', 'spray'].includes(screenshotBoardType)
        ? [screenshotBoardType]
        : undefined;
    // `today` (the screenshot-aware day clock) anchors the rolling date windows.
    return toAscentFeedInput({ filters, sort, name, boardTypes: cppBoardTypes, now: today });
  }, [filters, sort, name, screenshotBoardType, today]);

  // Gate on `hydrated` so the feed fetches once with the restored prefs rather
  // than once with defaults then again after persistence loads.
  // Date-DESC views use the GROUPED feed (same climb + same day collapses to
  // one row; the backend shares filter semantics with the flat feed). The
  // grouped resolver orders by latest activity DESC only, so a custom date-ASC
  // sort keeps the flat feed (with dividers); grade/custom non-date sorts keep
  // the flat feed without dividers. Exactly one feed is enabled at a time.
  const showDividers = shouldShowLogbookDividers(feedInput);
  // Emergency kill switch (absent flag = grouping on): flipping the PostHog
  // flag true reverts every device to the flat feed on next flag refresh, no
  // OTA needed, if the client-side re-bucketing misbehaves in production.
  const groupingKilled = useFeatureFlag('logbook-grouping-kill') === true;
  const groupedMode =
    !groupingKilled &&
    (feedInput.sortBy === 'recent' || (feedInput.sortBy === 'date' && feedInput.sortOrder !== 'asc'));
  const flatFeed = useUserAscentsFeed(userId, feedInput, { enabled: hydrated && !groupedMode });
  const groupedFeed = useUserGroupedAscentsFeed(userId, feedInput, { enabled: hydrated && groupedMode });
  // Control-surface alias (status flags, pagination); data is read per-mode in
  // the rows memo below where the types differ.
  const feed = groupedMode ? groupedFeed : flatFeed;
  // An offline fetch pauses rather than erroring under `networkMode:
  // 'offlineFirst'`, so it lands in neither the isError nor the loaded branch
  // below — without this it spins forever.
  const offline = useOfflineQueryState(feed);

  // The sheet's subtitle: the flat feed's own total of entries. The date feed
  // has none to show: its total counts the server's (climb, day) groups, and
  // the list regroups them here by local day, angle and mirror, so the number
  // would not match the rows.
  const matchCount = groupedMode ? null : (flatFeed.data?.pages[0]?.userAscentsFeed.totalCount ?? null);

  // Removable tokens for active filters whose capsule isn't pinned, plus the
  // name, so a filtered list always says why.
  const filterTokens = useMemo(
    () =>
      buildLogbookFilterTokens(
        {
          pinned: pinnedChips,
          filters,
          sort,
          name,
          viewerIsOwner,
          gradeStops,
          boardOptions,
          locale,
          onChangeFilters: handleTokenFilters,
          onChangeSort: handleTokenSort,
          onClearName: clearName,
        },
        t,
      ),
    [
      pinnedChips,
      filters,
      sort,
      name,
      viewerIsOwner,
      gradeStops,
      boardOptions,
      locale,
      handleTokenFilters,
      handleTokenSort,
      clearName,
      t,
    ],
  );
  const isFiltered = countLogbookFilters(filters, name) > 0;

  // Day dividers render only on a date-ordered feed (the Latest preset or a
  // custom date sort) — keyed off the EFFECTIVE feedInput, so a stale
  // persisted custom sort can't suppress them wrongly. A climb-name search
  // keeps them: it filters, the
  // result is still a timeline. Both paths dedupe by uuid — offset pagination
  // can repeat a row across page boundaries (swipe-delete shifts offsets), and
  // duplicate FlashList keys throw. Memoised so the FlashList `data` identity
  // is stable between unrelated re-renders.
  const hiddenTickUuids = usePendingLogbookDeletes();
  const { scheduleDelete, getDeleteScope } = useLogbookDeleteActions();
  const listRowsInput = useMemo<Omit<LogbookRowsInput, 'groupedPages' | 'flatPages'>>(
    () => ({
      groupedMode,
      showDividers,
      groupedHasMore: groupedFeed.hasNextPage ?? false,
      flatHasMore: flatFeed.hasNextPage ?? false,
      hiddenTickUuids,
    }),
    [groupedMode, showDividers, groupedFeed.hasNextPage, flatFeed.hasNextPage, hiddenTickUuids],
  );
  const listRows = useMemo(
    () =>
      buildLogbookRows({
        ...listRowsInput,
        groupedPages: groupedFeed.data?.pages,
        flatPages: flatFeed.data?.pages,
      }),
    [listRowsInput, groupedFeed.data, flatFeed.data],
  );

  // Tap → the climb opens playing from this logbook (own and another climber's
  // alike, issue #6665): swipes walk the rows on screen, in their order, and
  // page on through the feed. Light the board when I tap a climb and the crew
  // rule decide whether it goes up or opens as a preview.
  const listRowsInputRef = useRef(listRowsInput);
  listRowsInputRef.current = listRowsInput;
  const fetchNextGroupedPage = groupedFeed.fetchNextPage;
  const fetchNextFlatPage = flatFeed.fetchNextPage;
  const loadMoreLogbookEntries = useCallback(async () => {
    const input = listRowsInputRef.current;
    if (input.groupedMode) {
      const result = await fetchNextGroupedPage({ cancelRefetch: false });
      if (result.isError) throw result.error;
      const hasMore = result.hasNextPage ?? false;
      return {
        rows: logbookEntries(
          buildLogbookRows({
            ...input,
            groupedPages: result.data?.pages,
            flatPages: undefined,
            groupedHasMore: hasMore,
          }),
        ),
        hasMore,
      };
    }
    const result = await fetchNextFlatPage({ cancelRefetch: false });
    if (result.isError) throw result.error;
    const hasMore = result.hasNextPage ?? false;
    return {
      rows: logbookEntries(
        buildLogbookRows({ ...input, flatPages: result.data?.pages, groupedPages: undefined, flatHasMore: hasMore }),
      ),
      hasMore,
    };
  }, [fetchNextGroupedPage, fetchNextFlatPage]);
  const entryRows = useMemo(() => logbookEntries(listRows), [listRows]);
  const logbookListKey = useMemo(() => `${groupedMode}|${JSON.stringify(feedInput)}`, [groupedMode, feedInput]);
  const handleActivate = useTickListActivation<AscentFeedItem>({
    sourceId: `logbook:${userId ?? ''}`,
    label: tSession('playView.track.logbook'),
    rows: entryRows,
    hasMore: feed.hasNextPage ?? false,
    loadMore: loadMoreLogbookEntries,
    listKey: logbookListKey,
  });

  // Day-entries chooser for grouped rows: swipe-edit/delete on a row that
  // collapses several same-day entries must act on ONE tick, so the climber
  // picks which. Single-entry rows act directly, as before.
  const [chooser, setChooser] = useState<{
    intent: 'edit' | 'delete';
    entries: AscentFeedItem[];
    method: 'swipe' | 'a11y';
  } | null>(null);
  const chooserOpenRef = useRef(false);
  chooserOpenRef.current = chooser != null;
  const closeChooser = useCallback(() => setChooser(null), []);

  const openEditSheet = useCallback((ascent: AscentFeedItem) => {
    setEditAscent(ascent);
    // Pin to the first detent explicitly rather than `present()`, which reopens
    // at whatever detent the sheet last rested at (sticky across opens on iOS).
    // Android is deterministic either way — `androidContentSized` gives the edit
    // sheet one content-fitted state there, so index 0 IS that state.
    editSheetRef.current?.snapToIndex(0);
  }, []);

  // Swipe left-to-right → edit this tick (owner-only). The old tap behaviour.
  const handleEdit = useCallback(
    (ascent: AscentFeedItem, method: 'swipe' | 'a11y' = 'swipe') => {
      if (chooserOpenRef.current) return;
      const unit = ascent as LogbookGroupUnit;
      if (unit.groupItems && unit.groupItems.length > 1) {
        setChooser({ intent: 'edit', entries: unit.groupItems, method });
        return;
      }
      openEditSheet(ascent);
    },
    [openEditSheet],
  );

  // Swipe right-to-left (or the a11y action) → delete this tick, owner-only and
  // confirm-guarded: DELETE_TICK is a real server-side delete synced to Aurora,
  // so a one-gesture commit is banned. The uuid is captured BEFORE the await —
  // the dialog blocks touches, not data, and FlashList can recycle the source
  // row onto a different ascent while it's up. The optimistic removal from the
  // feed is hidden locally during Undo; the persistent owner commits later.
  const confirmDialog = useConfirm();
  const deleteTickPendingRef = useRef(false);
  deleteTickPendingRef.current = hiddenTickUuids.size > 0;
  // Covers the CONFIRM window (swipe-commit → dialog resolution), where
  // isPending is still false — a second swipe there would stack a second
  // dialog. The modal itself blocks touches on both platforms; this flag makes
  // single-flight true by construction rather than by dialog behaviour.
  const deleteFlowActiveRef = useRef(false);
  // The guarded core, shared by direct deletes and chooser picks: confirm
  // dialog, then DELETE_TICK. Callers own the single-flight flag transitions
  // into this function; it owns them out.
  const startGuardedDelete = useCallback(
    (targetUuid: string, method: 'swipe' | 'a11y', viaChooser = false) => {
      const originScope = getDeleteScope();
      const runGuardedDelete = async () => {
        const confirmed = await confirmDialog({
          title: t('mobile.logbook.deleteTitle'),
          message: t('mobile.logbook.deleteConfirm'),
          confirmLabel: t('mobile.logbook.delete'),
          cancelLabel: t('mobile.cancel'),
          destructive: true,
        });
        if (!confirmed) {
          deleteFlowActiveRef.current = false;
          return;
        }
        const scheduled = scheduleDelete({
          originScope,
          uuid: targetUuid,
          method,
          viaChooser,
          onSettled: () => {
            deleteFlowActiveRef.current = false;
          },
          onSuccess: () => {
            deleteFlowActiveRef.current = false;
            // Sequential-delete flow: prune the deleted entry so the chooser
            // stays open (even down to a single entry) while any remain, and
            // closes itself once the day's group is emptied.
            if (viaChooser) {
              setChooser((current) => {
                if (!current) return current;
                const remainingEntries = current.entries.filter((chooserEntry) => chooserEntry.uuid !== targetUuid);
                return remainingEntries.length > 0 ? { ...current, entries: remainingEntries } : null;
              });
            }
          },
        });
        if (!scheduled) deleteFlowActiveRef.current = false;
      };
      // A rejected dialog promise (unmounted host, provider bug) is treated as
      // a decline: nothing was confirmed, so nothing is deleted — the safe
      // outcome for a destructive action. Never rethrow into the void.
      void runGuardedDelete().catch(() => {
        deleteFlowActiveRef.current = false;
      });
    },
    [scheduleDelete, getDeleteScope, confirmDialog, t],
  );

  const handleDeleteRequest = useCallback(
    (ascent: AscentFeedItem, method: 'swipe' | 'a11y') => {
      if (chooserOpenRef.current || deleteFlowActiveRef.current || deleteTickPendingRef.current) return;
      const unit = ascent as LogbookGroupUnit;
      if (unit.groupItems && unit.groupItems.length > 1) {
        // The chooser is part of the delete flow: chooserOpenRef blocks
        // re-entry until it resolves; the flag flips on the actual pick.
        setChooser({ intent: 'delete', entries: unit.groupItems, method });
        return;
      }
      deleteFlowActiveRef.current = true;
      startGuardedDelete(ascent.uuid, method);
    },
    [startGuardedDelete],
  );

  // Chooser pick → route to the intent that opened it. Delete re-checks the
  // single-flight guards the direct path enforces at swipe time. For DELETE the
  // chooser stays mounted through the confirm + mutation: a climber clearing a
  // day's mislogs deletes sequentially without reopening the sheet — it prunes
  // the deleted entry on success (see startGuardedDelete) and only closes when
  // the group is empty or the sheet is dismissed.
  const handleChooserPick = useCallback(
    (entry: AscentFeedItem) => {
      const active = chooser;
      if (!active) return;
      if (active.intent === 'edit') {
        setChooser(null);
        openEditSheet(entry);
        return;
      }
      if (deleteFlowActiveRef.current || deleteTickPendingRef.current) return;
      deleteFlowActiveRef.current = true;
      startGuardedDelete(entry.uuid, active.method, true);
    },
    [chooser, openEditSheet, startGuardedDelete],
  );

  // Long press → open the climb actions sheet. For the owner it carries an
  // "Edit entry" row wired back to the tick editor. No-op when the board can't
  // resolve (no frames / MoonBoard) — nothing to render in the actions sheet.
  const handleOpenActions = useCallback(
    (ascent: AscentFeedItem) => {
      // Fall back to the consensus grade so the reaction menu shows a grade even when
      // the climber didn't log a personal one (tickToClimb only reads difficultyName).
      const climb = tickToClimb({
        ...ascent,
        difficultyName: ascent.difficultyName ?? ascent.consensusDifficultyName,
      });
      const config = renderBoardToPlaylistConfig(ascent.boardType, ascent.layoutId, ascent.renderBoard);
      if (!climb || !config) return;
      openClimbActions(
        climb,
        {
          boardName: config.boardName,
          layoutId: config.layoutId,
          sizeId: config.sizeId,
          setIds: config.setIds.join(','),
          angle: ascent.angle,
        },
        viewerIsOwner ? { onEditEntry: () => handleEdit(ascent, 'a11y') } : undefined,
      );
    },
    [openClimbActions, viewerIsOwner, handleEdit],
  );

  const handleEndReached = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage]);

  const handleRetry = useCallback(() => {
    void feed.refetch();
  }, [feed.refetch]);

  const renderItem = useCallback(
    ({ item: row }: { item: LogbookListRow<LogbookGroupUnit> }) => {
      if (row.type === 'divider') {
        // The divider owns its "now" clock (focus-refreshed) so this callback's
        // identity survives tab focus — a `now` dep here would re-render every
        // climb row for a value only dividers read.
        return <LogbookDayDivider dayStartMs={row.dayStartMs} stats={row.stats} wallLabel={row.wallLabel} />;
      }
      if (row.type === 'subdivider') {
        return <LogbookWallSubDivider wallLabel={row.wallLabel} />;
      }
      return (
        <LogbookRow
          ascent={row.item}
          groupTries={row.item.groupTries}
          showBoardInMeta={!row.wallCovered}
          fontScale={fontScale}
          onActivate={handleActivate}
          onOpenActions={handleOpenActions}
          onEdit={viewerIsOwner ? handleEdit : undefined}
          onDeleteRequest={viewerIsOwner ? handleDeleteRequest : undefined}
        />
      );
    },
    [handleActivate, handleOpenActions, handleEdit, handleDeleteRequest, viewerIsOwner, fontScale],
  );

  const handleRefresh = useCallback(() => void feed.refetch(), [feed.refetch]);

  const controls = (
    <ReadableColumn>
      <View style={[styles.controls, { paddingTop: hasComposedHeader ? 0 : topInset }]}>
        {/* In a composed profile header the selected Logbook tab already names
            the page. In flow (someone else's profile) the heading stays, and
            its scope line names the board when one is picked. */}
        {hasComposedHeader ? null : (
          <View style={styles.heading}>
            <Text variant="title2" accessibilityRole="header">
              {t('tabs.logbook')}
            </Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {logbookBoardLabel(filters, boardOptions, t) ?? t('mobile.filter.allBoards')}
            </Text>
          </View>
        )}
        <LogbookChipRow
          pinned={pinnedChips}
          filters={filters}
          sort={sort}
          name={name}
          viewerIsOwner={viewerIsOwner}
          gradeStops={gradeStops}
          boardOptions={boardOptions}
          locale={locale}
          openRail={visibleRail}
          onOpenFilters={handleOpenFilters}
          onOpenCustomDates={handleOpenCustomDates}
          onToggleRail={handleToggleRail}
          onChangeFilters={handleCapsuleFilters}
          onChangeSort={handleCapsuleSort}
          onOpenSetters={handleOpenSetters}
        />
        <LogbookFacetRail
          openRail={visibleRail}
          filters={filters}
          grades={grades ?? EMPTY_GRADES}
          onUpdateFilters={handleRailFilters}
        />
        <FilterTokenRow tokens={filterTokens} />
      </View>
    </ReadableColumn>
  );

  return (
    <View style={styles.flex}>
      <ReadableColumn style={styles.flex}>
        {hasComposedHeader ? null : controls}
        {/* UIKit supplies its title inset to the full-height scroll view. Material
            uses an opaque header, so its entire results frame starts below it. */}
        <View
          pointerEvents={headerMeasured ? 'auto' : 'none'}
          accessibilityElementsHidden={!headerMeasured}
          importantForAccessibility={headerMeasured ? 'auto' : 'no-hide-descendants'}
          style={[
            styles.flex,
            hasComposedHeader && !nativeRootHeader && { paddingTop: headerHeight, overflow: 'hidden' },
            !headerMeasured && styles.unmeasuredContent,
          ]}
        >
          {!userId ? (
            <View style={[styles.centered, { paddingTop: scrollHeaderInset }]}>
              <ActivityIndicator size="large" />
            </View>
          ) : offline.isBlocked && offline.reason ? (
            <View style={[styles.centered, { paddingTop: scrollHeaderInset }]}>
              <OfflineState reason={offline.reason} errorTitle={t('mobile.logbook.errorTitle')} onRetry={handleRetry} />
            </View>
          ) : feed.isPending ? (
            <View style={[styles.centered, { paddingTop: scrollHeaderInset }]}>
              <ActivityIndicator size="large" />
            </View>
          ) : feed.isError ? (
            <View style={[styles.errorContainer, { paddingTop: scrollHeaderInset }]}>
              <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
              <Text variant="headline" style={styles.errorTitle}>
                {t('mobile.logbook.errorTitle')}
              </Text>
              <Text variant="subheadline" style={styles.errorBody}>
                {t('mobile.logbook.errorBody')}
              </Text>
              <PressableSurface
                onPress={handleRetry}
                disabled={feed.isRefetching}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.logbook.retry')}
                style={({ pressed }) => [
                  styles.retryButton,
                  { borderColor: brandColors.primary },
                  feed.isRefetching && styles.retryButtonDisabled,
                  pressed && !feed.isRefetching && { backgroundColor: `${brandColors.primary}1A` },
                ]}
              >
                <Text variant="footnote" color={brandColors.primary}>
                  {t('mobile.logbook.retry')}
                </Text>
              </PressableSurface>
            </View>
          ) : (
            <>
              <ScrollEdgeListReset edge={scrollEdge} />
              <FlashList
                testID="logbook-screen"
                data={listRows}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                getItemType={getRowType}
                {...scrollEdge?.listProps}
                // The native controls are measured after this list mounts. Keeping
                // a row anchored would scroll away the padding added for them.
                maintainVisibleContentPosition={hasComposedHeader && nativeRootHeader ? { disabled: true } : undefined}
                contentInsetAdjustmentBehavior={nativeRootHeader ? 'automatic' : 'never'}
                onEndReached={handleEndReached}
                onEndReachedThreshold={0.5}
                contentContainerStyle={{ paddingTop: scrollHeaderInset, paddingBottom }}
                scrollIndicatorInsets={{ top: scrollHeaderInset }}
                refreshControl={
                  <RefreshControl
                    refreshing={feed.isRefetching}
                    onRefresh={handleRefresh}
                    tintColor={brandColors.primary}
                  />
                }
                ListFooterComponent={
                  feed.isFetchingNextPage ? (
                    <View style={styles.footer}>
                      <ActivityIndicator size="small" />
                    </View>
                  ) : null
                }
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Icon name="tick.outline" size={48} color={systemColors.tertiaryLabel} />
                    <Text variant="headline" style={styles.emptyTitle}>
                      {isFiltered
                        ? t('mobile.logbook.emptyFiltered')
                        : viewerIsOwner
                          ? t('mobile.logbook.empty')
                          : t('mobile.logbook.emptyOther')}
                    </Text>
                    {isFiltered ? (
                      <View style={styles.emptyAction}>
                        <Button
                          title={t('mobile.logbook.clearFilters')}
                          onPress={handleClearFilters}
                          variant="tonal"
                          size="medium"
                        />
                      </View>
                    ) : null}
                    {/* Unfiltered only: a logbook emptied by a filter says nothing about
                  whether a board account is linked. */}
                    <BoardLinkPrompt key={userId} viewerIsOwner={viewerIsOwner} hasNoSends={!isFiltered} />
                  </View>
                }
              />
            </>
          )}
        </View>
      </ReadableColumn>

      {/* Render after the results so the native header observes the main scroll view. */}
      {renderHeader?.(controls, setHeaderHeight)}

      {viewerIsOwner ? (
        <LogbookEditSheet sheetRef={editSheetRef} ascent={editAscent} onClose={() => setEditAscent(null)} />
      ) : null}

      {chooser ? (
        <LogbookEntryChooserSheet
          entries={chooser.entries}
          intent={chooser.intent}
          onPick={handleChooserPick}
          onDismiss={closeChooser}
        />
      ) : null}

      {filterSheetOpen ? (
        <LogbookFilterSheet
          onDismiss={handleCloseFilters}
          filters={filters}
          sort={sort}
          name={name}
          viewerIsOwner={viewerIsOwner}
          grades={grades ?? EMPTY_GRADES}
          boardOptions={boardOptions}
          matchCount={matchCount}
          today={today}
          onChangeFilters={handleSheetFilters}
          onChangeSort={handleSheetSort}
          onNameChange={handleNameChange}
          onClearName={clearName}
          onReset={handleReset}
          onOpenSetters={handleOpenSetters}
          initialSection={sheetSection}
        />
      ) : null}
    </View>
  );
}

function keyExtractor(row: LogbookListRow<LogbookGroupUnit>) {
  return row.key;
}

// Divider vs entry recycling pools — FlashList must never recycle a divider
// into a climb row or vice versa.
function getRowType(row: LogbookListRow<LogbookGroupUnit>) {
  return row.type;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minHeight: 0 },
  unmeasuredContent: { opacity: 0 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingVertical: spacing[5], alignItems: 'center' },
  // The capsule row and the rails pad their own 16pt gutter and scroll out to
  // the column's edge, so the block itself has no side padding.
  controls: {
    paddingBottom: spacing[1],
  },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[1],
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  emptyTitle: { opacity: 0.6, marginTop: spacing[3], textAlign: 'center' },
  emptyAction: { marginTop: spacing[3] },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  errorTitle: { marginTop: spacing[3], textAlign: 'center' },
  errorBody: { opacity: 0.6, textAlign: 'center' },
  retryButton: {
    marginTop: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  retryButtonDisabled: { opacity: opacity.disabled },
});
