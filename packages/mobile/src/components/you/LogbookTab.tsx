import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, RefreshControl, Pressable, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import {
  toAscentFeedInput,
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  buildLogbookListRows,
  dedupeLogbookItems,
  shouldShowLogbookDividers,
  logbookNoteIsVisible,
  pickBestGroupEntry,
  sumGroupTries,
  logbookDayKey,
  type LogbookFilterState,
  type LogbookSortPreset,
  type LogbookListRow,
} from '@boardsesh/logbook';
import { useDeleteTick } from '@boardsesh/board-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { SearchHeader, type SearchHeaderHandle } from '../SearchHeader';
import { LogbookRow } from './LogbookRow';
import { LogbookDayDivider, LogbookWallSubDivider } from './LogbookDayDivider';
import { LogbookEditSheet } from './LogbookEditSheet';
import { LogbookFilterSheet } from './LogbookFilterSheet';
import { LogbookEntryChooserSheet } from './LogbookEntryChooserSheet';
import { LogbookChipRow } from './LogbookChipRow';
import { LogbookFacetRail } from './LogbookFacetRail';
import type { LogbookFacetKey } from './LogbookChipRow.logic';
import { useLogbookSearch, countActiveLogbookFilters } from './use-logbook-search';
import { useUserAscentsFeed, useUserGroupedAscentsFeed, useGrades } from '../../lib/graphql/hooks';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { OfflineState } from '../OfflineState';
import type { Grade } from '@boardsesh/shared-schema';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { tickToClimb } from '../../lib/tick-to-climb';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { getLayoutDisplayName } from '@boardsesh/profile-stats';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { normalizeSearchName } from '../../lib/search-name';
import { hapticSelection, hapticSuccess, hapticError } from '../../lib/haptics';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';

const SEARCH_DEBOUNCE_MS = 300;

// Kilter and Tension share an identical difficulty-id scale, so one board's grade
// list is the canonical scale for the grade chip's label — the same source the
// filter sheet's GradeRangeRail uses (LogbookFilterSheet's GRADE_SCALE_BOARD), so
// the chip and the rail never word a grade differently.
const GRADE_SCALE_BOARD = 'kilter';

// Stable empty grade list so the chip row + facet rail (both memo'd) keep their
// `grades` prop identity while the grade query is still loading (undefined).
const EMPTY_GRADES: Grade[] = [];

type LogbookTabProps = {
  userId: string | undefined;
  /** Measured chrome height — the fixed toolbar insets its top by this so it
   *  rests below the floating chrome and results scroll beneath the toolbar. */
  topInset?: number;
  /**
   * Whether the signed-in user owns this logbook. Defaults to true (the You
   * tab). When false (viewing another climber's profile) a row opens the climb
   * read-only in the play drawer instead of the editable LogbookEditSheet.
   */
  viewerIsOwner?: boolean;
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

export function LogbookTab({ userId, topInset = 0, viewerIsOwner = true }: LogbookTabProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors, variant } = useTheme();
  // Kill switch for the search + filter UI — rolled out 100% in PostHog since
  // 2026-07-03; the gate stays so a bad release can be turned off server-side.
  const logbookFiltersEnabled = useFeatureFlag('logbook-filters') === true;
  // Latest/Hardest become top-level Liquid Glass chips (iOS 26 only) so sort is
  // switchable without opening the sheet; the variant goes through selectByVariant
  // per the mobile variant guard. When shown, the sheet's Sort block is suppressed.
  const showSortChips =
    logbookFiltersEnabled && Platform.OS === 'ios' && selectByVariant(variant, { liquidGlass: true, material: false });
  // Grade scale for the chip row's grade label — fetched only when the chip row is
  // shown (the Android/Material toolbar has no grade chip). Same query as the sheet.
  const { data: grades } = useGrades(GRADE_SCALE_BOARD, showSortChips);
  const router = useRouter();
  const { openPlayDrawer, openClimbActions } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  // One dimension subscription for the whole list; rows take fontScale as a prop.
  const { fontScale } = useWindowDimensions();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const editSheetRef = useRef<BottomSheet | null>(null);
  const [editAscent, setEditAscent] = useState<AscentFeedItem | null>(null);

  // Logbook search/filter/sort state. The committed name lives here; the visible
  // input value is debounced before it commits to the query.
  const logbookSearch = useLogbookSearch();
  const { filters, sort, name, setName, setPreset, setFilters, apply, hydrated } = logbookSearch;
  // Which preset the chips highlight; null (no chip lit) when a non-preset
  // (custom) sort is in effect, rather than falsely lighting up Latest.
  const sortPreset: LogbookSortPreset | null = sort.mode === 'preset' ? sort.preset : null;
  const activeFilterCount = useMemo(() => countActiveLogbookFilters(filters), [filters]);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // Which facet's inline rail is open below the chip row (Liquid Glass only); null
  // when all closed. Tapping the open facet's chip closes it (toggle), tapping a
  // different facet swaps to it — only one rail shows at a time.
  const [openFacet, setOpenFacet] = useState<LogbookFacetKey | null>(null);
  const handleToggleFacet = useCallback((facet: LogbookFacetKey) => {
    hapticSelection();
    setOpenFacet((current) => (current === facet ? null : facet));
  }, []);
  // One stable "today" ceiling so the To-date row's maximumDate keeps a constant
  // identity across renders (mirrors the filter sheet's `today`). Frozen at mount;
  // if the app sits open past midnight it's a day stale, which is harmless here and
  // matches the sheet.
  const today = useMemo(() => new Date(), []);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchHeaderRef = useRef<SearchHeaderHandle>(null);

  useEffect(() => () => clearTimeout(debounceTimerRef.current ?? undefined), []);

  const handleSearchChange = useCallback(
    (text: string) => {
      const nextName = normalizeSearchName(text);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        setName(nextName);
        // Privacy: report only that a search was committed and its length, never
        // the query text. A non-empty term marks intent; clearing back to '' is
        // not a search.
        if (nextName) track(SHARED_EVENTS.LogbookSearched, { length: nextName.length });
      }, SEARCH_DEBOUNCE_MS);
    },
    [setName],
  );

  // Wrap the reducer's sort/filter setters so each change is instrumented before
  // it commits — the chip row's React.memo holds because these are memoised. We
  // send the preset and the changed field NAMES only (never grade/date values),
  // so PostHog can show which facets get used without leaking what was searched.
  const handleSelectPreset = useCallback(
    (preset: LogbookSortPreset) => {
      track(SHARED_EVENTS.LogbookSortChanged, { preset });
      setPreset(preset);
    },
    [setPreset],
  );
  const handleUpdateFilters = useCallback(
    (partial: Partial<LogbookFilterState>) => {
      // Analytics property values are scalar (no arrays), so the changed field
      // NAMES go as a sorted comma-joined string — PostHog can still break down
      // which facets get used. Sorted so a `{minGrade,maxGrade}` patch groups
      // the same regardless of key order. Never the grade/date values themselves.
      track(SHARED_EVENTS.LogbookFilterChanged, { fields: Object.keys(partial).sort().join(',') });
      setFilters(partial);
    },
    [setFilters],
  );

  // Clear the committed term AND the input field (silent: don't re-arm the
  // debounce). Wired to the sheet's Reset so "Reset" is a true clean slate.
  const clearSearch = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setName('');
    searchHeaderRef.current?.setText('', { silent: true });
  }, [setName]);

  const handleOpenFilters = useCallback(() => {
    hapticSelection();
    // Close any open inline rail so it doesn't linger under the sheet (and leave
    // the toolbar over-tall after the sheet dismisses).
    setOpenFacet(null);
    setFilterSheetOpen(true);
  }, []);

  const handleCloseFilters = useCallback(() => setFilterSheetOpen(false), []);

  // The query input is rebuilt only when the committed filters/sort/name change,
  // so the React Query key (and the FlashList data identity downstream) is stable
  // between unrelated re-renders. When the flag is off the toolbar is hidden, so
  // ignore any persisted filter/sort/name and feed defaults — otherwise prefs
  // saved during a prior flag-on session would silently narrow the list.
  const feedInput = useMemo(
    () =>
      toAscentFeedInput(
        logbookFiltersEnabled
          ? { filters, sort, name }
          : { filters: DEFAULT_LOGBOOK_FILTERS, sort: DEFAULT_LOGBOOK_SORT, name: '' },
      ),
    [logbookFiltersEnabled, filters, sort, name],
  );

  // Gate on `hydrated` so the feed fetches once with the restored prefs rather
  // than once with defaults then again after persistence loads. (With the flag
  // off `feedInput` already ignores persisted prefs, so this just fetches the
  // defaults once hydration settles. Keeping the gate while the flag is still
  // resolving avoids an early default fetch for the flag-on cohort.)
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

  // Day dividers render only on a date-ordered feed (the Latest preset or a
  // custom date sort) — keyed off the EFFECTIVE feedInput, so the flag-off
  // default (date-desc) gets dividers and a stale persisted custom sort can't
  // suppress them wrongly. A climb-name search keeps them: it filters, the
  // result is still a timeline. Both paths dedupe by uuid — offset pagination
  // can repeat a row across page boundaries (swipe-delete shifts offsets), and
  // duplicate FlashList keys throw. Memoised so the FlashList `data` identity
  // is stable between unrelated re-renders.
  const { listRows, entryIndexByUuid } = useMemo(() => {
    // Wall label ("Alex's board") feeds the divider/subdivider context; board
    // identity only — the angle stays on every row. Derivation needs the app's
    // board metadata so it happens here, not in the shared builder.
    const wallOf = (item: AscentFeedItem) =>
      item.boardDisplayName ?? getLayoutDisplayName(item.boardType, item.layoutId);

    let rows: LogbookListRow<LogbookGroupUnit>[];
    if (groupedMode) {
      const groups = groupedFeed.data?.pages.flatMap((page) => page.userGroupedAscentsFeed.groups) ?? [];
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
          if (seenTickUuids.has(item.uuid)) continue;
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
      rows = buildLogbookListRows(units, { hasMore: groupedFeed.hasNextPage ?? false });
    } else if (showDividers) {
      // Date-ASC custom sort: dividers without grouping (the grouped resolver
      // is DESC-only) — one row per tick, exactly as before grouping existed.
      const items = flatFeed.data?.pages.flatMap((page) => page.userAscentsFeed.items) ?? [];
      const withWalls = items.map((item) => ({ ...item, wall: wallOf(item) }));
      rows = buildLogbookListRows(withWalls, { hasMore: flatFeed.hasNextPage ?? false });
    } else {
      const items = flatFeed.data?.pages.flatMap((page) => page.userAscentsFeed.items) ?? [];
      rows = dedupeLogbookItems(items).map((item) => ({ type: 'entry', key: item.uuid, item, wallCovered: false }));
    }
    // Entry ordinal (dividers excluded) for the analytics `rowIndex` — the raw
    // FlashList index counts divider rows, which would skew position funnels.
    const ordinals = new Map<string, number>();
    for (const row of rows) {
      if (row.type === 'entry') ordinals.set(row.item.uuid, ordinals.size);
    }
    return { listRows: rows, entryIndexByUuid: ordinals };
  }, [groupedFeed.data, groupedFeed.hasNextPage, flatFeed.data, flatFeed.hasNextPage, groupedMode, showDividers]);

  // Tap → set the climb active and open the play drawer (own logbook and another
  // climber's read-only logbook alike). AscentFeedItem structurally satisfies the
  // `tick` kind, which builds the climb + board config from frames.
  // Read the ordinal map through a ref so this callback (and renderItem above
  // it) keeps its identity across page loads — the map is rebuilt with every
  // fetched page, but a tap only needs whatever is current at fire time.
  const entryIndexRef = useRef(entryIndexByUuid);
  entryIndexRef.current = entryIndexByUuid;
  const handleActivate = useCallback(
    (ascent: AscentFeedItem) => {
      const groupSize = (ascent as LogbookGroupUnit).groupItems?.length ?? 1;
      track(SHARED_EVENTS.LogbookRowClicked, {
        climbUuid: ascent.climbUuid,
        rowIndex: entryIndexRef.current.get(ascent.uuid),
        hasNote: logbookNoteIsVisible(ascent.comment),
        status: ascent.status,
        grouped: groupSize > 1,
        groupSize,
      });
      // Default open mode is now "set active", so no option is needed here.
      openClimbInPlayDrawer({ kind: 'tick', tick: ascent }, { openPlayDrawer, router });
    },
    [openPlayDrawer, router],
  );

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
  // cached feed pages lives inside useDeleteTick, shared by every delete path.
  const deleteTick = useDeleteTick();
  const confirmDialog = useConfirm();
  const { showToast } = useToast();
  // Depend on the STABLE pieces of the mutation, not the result object — that
  // object gets a fresh identity every render, which would recreate this
  // callback → recreate renderItem → re-render every visible row on each tab
  // render (each search keystroke). `mutate` is identity-stable; the pending
  // guard reads a ref for the same reason.
  const { mutate: deleteTickMutate } = deleteTick;
  const deleteTickPendingRef = useRef(deleteTick.isPending);
  deleteTickPendingRef.current = deleteTick.isPending;
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
        deleteTickMutate(targetUuid, {
          onSuccess: () => {
            deleteFlowActiveRef.current = false;
            track(SHARED_EVENTS.LogbookEntryDeleted, { method, viaChooser });
            hapticSuccess();
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
          onError: () => {
            deleteFlowActiveRef.current = false;
            hapticError();
            showToast(t('mobile.logbook.deleteError'), 'error');
          },
        });
      };
      // A rejected dialog promise (unmounted host, provider bug) is treated as
      // a decline: nothing was confirmed, so nothing is deleted — the safe
      // outcome for a destructive action. Never rethrow into the void.
      void runGuardedDelete().catch(() => {
        deleteFlowActiveRef.current = false;
      });
    },
    [deleteTickMutate, confirmDialog, showToast, t],
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

  if (!userId) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {/* Fixed top toolbar — all logbook actions concentrated here, below the
          floating chrome. Sibling of the list, so list virtualization is intact. */}
      <View style={[styles.toolbar, { paddingTop: topInset }]}>
        {showSortChips ? (
          // iOS Liquid Glass: search sits on its own row, and the chip row below
          // carries the filter entry + sort + active-filter chips (so no separate
          // filter button here).
          <>
            {/* The row wrapper is load-bearing: SearchHeader's capsule is flex:1,
                sized for a HORIZONTAL slot (Climbs toolbar, the Material row
                below). As a direct child of this vertical toolbar, flex-basis 0
                in an auto-height column beats the explicit height and collapses
                the capsule to 0px — the search box invisibly disappears. */}
            <View style={styles.searchRow}>
              <SearchHeader
                ref={searchHeaderRef}
                placeholder={t('mobile.logbook.searchPlaceholder')}
                onChangeText={handleSearchChange}
                initialValue={name}
                height={40}
              />
            </View>
            {/* Filter entry + Latest/Hardest + every facet chip (grade/angle/show/
                date) — switch sort and adjust filters inline without opening the
                sheet. Grade/angle/date toggle the rail below; Show is a native
                menu. The sheet's Sort block is hidden (showSort={false}) so sort
                isn't worded twice. */}
            <LogbookChipRow
              sortPreset={sortPreset}
              onSelectPreset={handleSelectPreset}
              onOpenFilters={handleOpenFilters}
              filters={filters}
              grades={grades ?? EMPTY_GRADES}
              onToggleFacet={handleToggleFacet}
              onUpdateFilters={handleUpdateFilters}
            />
            {/* The open facet's inline rail, below the chip row. It grows the
                toolbar View; the FlashList insets below the toolbar so results
                still scroll under it. Live-commits via setFilters. */}
            <LogbookFacetRail
              openFacet={openFacet}
              filters={filters}
              grades={grades ?? EMPTY_GRADES}
              onUpdateFilters={handleUpdateFilters}
              today={today}
            />
          </>
        ) : (
          // Android / Material: the current layout — search + the round filter
          // button (no chip row).
          <>
            {logbookFiltersEnabled ? (
              <View style={styles.toolbarRow}>
                <SearchHeader
                  ref={searchHeaderRef}
                  placeholder={t('mobile.logbook.searchPlaceholder')}
                  onChangeText={handleSearchChange}
                  initialValue={name}
                  height={40}
                />
                <Pressable
                  onPress={handleOpenFilters}
                  accessibilityRole="button"
                  accessibilityLabel={t('mobile.logbook.filter')}
                  style={({ pressed }) => [
                    styles.filterButton,
                    { backgroundColor: brandColors.accent },
                    pressed && styles.filterButtonPressed,
                  ]}
                >
                  <Icon name="filter" size={18} color={iosSystemColors.black} />
                  {activeFilterCount > 0 ? (
                    <View style={[styles.filterBadge, { backgroundColor: iosSystemColors.black }]}>
                      <Text variant="caption2" color={brandColors.accent} style={styles.filterBadgeText}>
                        {activeFilterCount}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
              </View>
            ) : null}
          </>
        )}
      </View>

      {offline.isBlocked && offline.reason ? (
        <View style={styles.centered}>
          <OfflineState reason={offline.reason} onRetry={handleRetry} />
        </View>
      ) : feed.isPending ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : feed.isError ? (
        <View style={styles.errorContainer}>
          <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
          <Text variant="headline" style={styles.errorTitle}>
            {t('mobile.logbook.errorTitle')}
          </Text>
          <Text variant="subheadline" style={styles.errorBody}>
            {t('mobile.logbook.errorBody')}
          </Text>
          <Pressable
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
          </Pressable>
        </View>
      ) : (
        <FlashList
          data={listRows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getRowType}
          contentInsetAdjustmentBehavior="never"
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          contentContainerStyle={{ paddingBottom }}
          refreshControl={
            <RefreshControl refreshing={feed.isRefetching} onRefresh={handleRefresh} tintColor={brandColors.primary} />
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
                {activeFilterCount > 0 || name ? t('mobile.logbook.emptyFiltered') : t('mobile.logbook.empty')}
              </Text>
            </View>
          }
        />
      )}

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

      {logbookFiltersEnabled && filterSheetOpen ? (
        <LogbookFilterSheet
          onDismiss={handleCloseFilters}
          currentFilters={filters}
          currentSort={sort}
          onApply={apply}
          onClearSearch={clearSearch}
          // When the top-level sort chips are shown, drop the sheet's Sort block
          // so sort isn't worded twice.
          showSort={!showSortChips}
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
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingVertical: spacing[5], alignItems: 'center' },
  toolbar: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  // Horizontal slot for the Liquid Glass search capsule (see the comment at the
  // render site — flex:1 needs a row parent or it collapses to 0 height).
  searchRow: {
    flexDirection: 'row',
    marginBottom: spacing[2],
  },
  filterButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterButtonPressed: { opacity: 0.85 },
  filterBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBadgeText: { fontWeight: '700' },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  emptyTitle: { opacity: 0.6, marginTop: spacing[3], textAlign: 'center' },
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
  retryButtonDisabled: { opacity: 0.5 },
});
