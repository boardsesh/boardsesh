import { boardOriginFor, type BoardName, type UserBoard } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import { useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { addBoardRoute } from '../../src/components/board-discovery/add-board-route';
import { AddBoardMenu } from '../../src/components/board-discovery/AddBoardMenu';
import { AddBoardButton } from '../../src/components/board-discovery/AddBoardButton';
import { withoutBoardsShown } from '../../src/components/board-discovery/board-card-actions';
import {
  boardCardMenuAllows,
  type BoardCardManageAction,
  type BoardCardMenuAction,
  type BoardCardMenuCapabilities,
  type BoardCardMenuSection,
  type BoardCardMenuVia,
} from '../../src/components/board-discovery/board-card-menu';
import {
  pickerTopBoardsToItems,
  userBoardToItem,
  userBoardsToItems,
} from '../../src/components/board-discovery/board-items';
import { BoardCarousel } from '../../src/components/board-discovery/BoardCarousel';
import { BoardDetailSheet, type RelistGym } from '../../src/components/board-discovery/BoardDetailSheet';
import { useReportProblemHost } from '../../src/components/report-problem/use-report-problem';
import { ReportReviewSheet, type ReportReviewAction } from '../../src/components/report-problem/ReportReviewSheet';
import {
  useAddBoardWizardEnabled,
  useDirectoryReportsEnabled,
  useFeatureFlagsResolved,
} from '../../src/providers/feature-flags-provider';
import type { DiscoveryBoardItem } from '../../src/components/board-discovery/BoardDiscoveryCard';
import { BoardRowList } from '../../src/components/board-discovery/BoardRowList';
import { BoardSelectorView } from '../../src/components/board-discovery/BoardSelectorView';
import { DiscoveryBoardArt } from '../../src/components/board-discovery/DiscoveryBoardArt';
import { FirstBoardChoice } from '../../src/components/board-discovery/FirstBoardChoice';
import { gymPageHref } from '../../src/components/gym-page/gym-page-route';
import { InRangeSection } from '../../src/components/board-discovery/InRangeSection';
import { nearbyListTitle } from '../../src/components/board-discovery/nearby-board-type-copy';
import { LocationAskCard } from '../../src/components/location/LocationAskCard';
import { NearbyQuietStatus } from '../../src/components/board-discovery/NearbyQuietStatus';
import { NearbyReservedSlot } from '../../src/components/board-discovery/NearbyReservedSlot';
import { offlineBoardRows } from '../../src/components/board-discovery/offline-board-items';
import {
  mapPickerTopBoards,
  YOUR_BOARDS_COLLAPSED_ROW_COUNT,
  type PickerTopView,
  type UnnamedInRangeRow,
} from '../../src/components/board-discovery/picker-top-view';
import { useBoardOfflineState } from '../../src/components/board-discovery/use-board-offline-state';
import { useInRangeActions } from '../../src/components/board-discovery/use-in-range-actions';
import { usePickerInRange } from '../../src/components/board-discovery/use-picker-in-range';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { Icon } from '../../src/components/Icon';
import { OfflineCatalogCta } from '../../src/components/offline/OfflineCatalogCta';
import { ShelfSection, type ShelfHeaderAction } from '../../src/components/ShelfHeader';
import { Text } from '../../src/components/Text';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useStoredUserId } from '../../src/hooks/use-current-user-id';
import { trackBoardCardAction } from '../../src/lib/boards/board-card-action-analytics';
import {
  trackBoardPickerAddSelected,
  trackBoardKindChosen,
  type BoardPickerAddKind,
  type BoardPickerAddSurface,
} from '../../src/lib/boards/board-picker-add-analytics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { wizardBoardHref } from '../../src/lib/boards/add-board-wizard';
import { boardUuidOrNull } from '../../src/lib/boards/board-identity';
import { orderBoardsForPartnerWorkout } from '../../src/lib/partner-workout-board-order';
import { usePendingWorkout } from '../../src/lib/pending-workout-store';
import { firstBoardGymState } from '../../src/lib/boards/first-board-gym-state';
import {
  BUILDER_PRESET_PARAM_VALUE,
  isFirstBoardMode,
  isNoBoardEntry,
  type FirstBoardEntry,
} from '../../src/lib/boards/first-board-mode';
import { deriveLocalOnly, pickerNoticeKey } from '../../src/lib/boards/local-only';
import { clearPendingBoardRecognition } from '../../src/lib/boards/pending-board-recognition';
import { useActivateBoard, type BoardPickSection, type BoardPickSource } from '../../src/lib/boards/use-activate-board';
import { pickerNearbyResultCount, useBoardPickerAnalytics } from '../../src/lib/boards/use-board-picker-analytics';
import { useConnectivity } from '../../src/lib/connectivity/use-connectivity';
import { isSystemBoardDeleteInsteadError } from '../../src/lib/graphql/extract-error-message';
import {
  useBoard,
  useDeleteBoard,
  useDetachBoardFromGym,
  useLinkBoardToGym,
  useMyBoards,
  useNearbyBoards,
  usePinBoard,
  useProfile,
  useUnfollowBoard,
} from '../../src/lib/graphql/hooks';
import { MY_BOARDS_WITH_IMPORTS_INPUT } from '../../src/lib/graphql/query-keys';
import {
  getActiveBoardWriteGeneration,
  useActiveBoard,
  useClearActiveBoardIfCurrentGeneration,
  useSetActiveBoardIfCurrentGeneration,
} from '../../src/lib/graphql/use-active-board';
import { trackNudgeAccepted } from '../../src/lib/offline-nudges/nudge-analytics';
import { useFirstBoardPickerTracking } from '../../src/lib/onboarding/use-first-board-picker-tracking';
import { openAppSettings } from '../../src/lib/open-app-settings';
import { unfinishedSprayWallRoute } from '../../src/lib/spray/spray-import-progress';
import { useSprayImportProgress } from '../../src/lib/spray/use-spray-import-progress';
import { useSprayLabelOptions } from '../../src/lib/spray/use-spray-label-options';
import { useDeviceLocation } from '../../src/lib/use-device-location';
import { useConfirmBoardDownload } from '../../src/offline/use-confirm-board-download';
import { useDownloadedScopeKeys } from '../../src/offline/use-downloaded-scope-keys';
import { useOfflineCatalogState } from '../../src/offline/use-offline-catalog-state';
import { useRememberDownloadedBoards } from '../../src/offline/use-remember-downloaded-boards';
import { useAuth } from '../../src/providers/auth-provider';
import { useConfirm } from '../../src/providers/dialog-provider';
import { useOfflineDownloadsEnabled } from '../../src/providers/feature-flags-provider';
import { useQueueActions } from '../../src/providers/queue-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useToast } from '../../src/providers/toast-provider';
import { forgetOfflineBoard, offlineBoardKeyForBoard, useOfflineBoards } from '../../src/settings';
import { spacing } from '../../src/theme/tokens';
import { openSignIn } from '../../src/lib/routing/open-sign-in';

// Module-level so an absent board list keeps a stable identity: offline
// `boardConnection` is always undefined, and a fresh `[]` per render would
// recompute the offline rows on every commit.
const EMPTY_BOARDS: UserBoard[] = [];

// Near you boards belong to other people: their cards offer Climb here,
// Details and, with the `directory-reports` flag, Report a problem; nothing that
// manages a board.
const NEARBY_MENU_CAPABILITIES: BoardCardMenuCapabilities = {
  canPin: false,
  canDownload: false,
  canOpenDetails: true,
  canManage: false,
  canReport: false,
};
const NEARBY_MENU_CAPABILITIES_WITH_REPORT: BoardCardMenuCapabilities = {
  ...NEARBY_MENU_CAPABILITIES,
  canReport: true,
};

/**
 * Whether a card's managing row may run: the same rule the menu drew it with
 * (`boardCardMenuAllows`), read from the item again when the row runs. Edit,
 * remove from gym and delete follow the server's flags, so gym staff can run
 * them on a board they follow; unfollow is for a board the viewer does not own.
 */
function itemAllows(item: DiscoveryBoardItem, action: BoardCardManageAction): boolean {
  return boardCardMenuAllows(
    {
      isPinned: item.isPinned === true,
      offlineState: item.offlineState,
      isViewerOwner: item.isViewerOwner,
      isImport: item.sprayImport != null,
      canEdit: item.canEdit,
      canDelete: item.canDelete,
      canRemoveFromGym: item.canRemoveFromGym,
      gymName: item.gymName,
    },
    action,
  );
}

/** The board type the Near you list is narrowed to, and the layout it was set in. */
type NearbyTypeFilter = { boardType: BoardName; inFirstBoardChoice: boolean };

/** Where a pick on this screen happened, for `Board Picker Selection Completed`. */
type PickerPick = { pickSource: BoardPickSource; section?: BoardPickSection; position?: number | null };

/** Which list a card menu row ran in, and that list's own pick and details. */
type BoardMenuSection = {
  section: BoardCardMenuSection;
  select: (item: DiscoveryBoardItem) => void;
  openDetails: (item: DiscoveryBoardItem) => void;
};

/** A card's 0-based place in the list it is drawn in, or null when it is not there. */
function positionOf(items: readonly DiscoveryBoardItem[], key: string): number | null {
  const position = items.findIndex((item) => item.key === key);
  return position === -1 ? null : position;
}

export default function BoardSelection() {
  const { isAuthenticated, refreshAuthState } = useAuth();
  const bottomChrome = useBottomChromeMetrics();
  const router = useRouter();
  const {
    returnTo,
    source,
    firstBoard,
    board: linkedBoardParam,
    details: linkedDetailsParam,
    review: linkedReviewParam,
    relistGym: linkedRelistGymParam,
    relistGymUuid: linkedRelistGymUuidParam,
  } = useLocalSearchParams<{
    returnTo?: string;
    source?: string;
    firstBoard?: string;
    /**
     * A board to open on arrival, from a notification or the Climbs menu's
     * About this board: `details=1` opens its detail sheet, `review=1` its
     * report review sheet (the detail sheet while the `directory-reports`
     * flag is off). `relistGymUuid` is the gym whose staff took the board off,
     * for the detail sheet's "Ask {{gym}} to list it again"; `relistGym` is
     * the notice's name for it, shown until the gym loads.
     */
    board?: string;
    details?: string;
    review?: string;
    relistGym?: string;
    relistGymUuid?: string;
  }>();
  const boardReturnTo = resolveBoardReturnTo(returnTo);
  // Arriving from the first-run framing screen: this is the activation flow, so
  // pre-resolve location, show the framing header, and tag the board-bind.
  const fromOnboarding = source === 'onboarding';
  // Opened by the launch gate for a new account with no board (#5654): "Where do
  // you climb?" and three ways to a board instead of the row of discovery tiles.
  // Still an onboarding pick (`fromOnboarding`), so the bind closes out first-run
  // and lands on Climbs exactly as the old board step did.
  const firstBoardMode = isFirstBoardMode({ source, firstBoard });
  // Climbs' "Pick your board" empty state (#5654). The same "Where do you
  // climb?" block, for a climber with no boards at all, but an ordinary board
  // switch rather than onboarding: see `firstBoardChoiceEntry` below.
  const fromNoBoard = isNoBoardEntry({ source });
  const { t } = useTranslation('boards');
  const preferredWorkoutBoard = usePendingWorkout()?.spec.preferredBoard;
  // The drill-in reuses the manage screen's own title, so the two can never drift.
  const { t: tCommon } = useTranslation('common');
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { systemColors } = useTheme();

  // Clear the bottom tab bar and whichever queue controls are actually visible.
  const scrollBottomPadding = bottomChrome.scrollBottomPadding;

  const { data: activeBoard, isError: boardRestoreFailed } = useActiveBoard();
  const clearActiveBoard = useClearActiveBoardIfCurrentGeneration();
  const setActiveBoardIfCurrentGeneration = useSetActiveBoardIfCurrentGeneration();
  const { clearSession } = useQueueActions();
  const deleteBoard = useDeleteBoard();
  const unfollowBoard = useUnfollowBoard();
  const linkBoardToGym = useLinkBoardToGym();
  const detachBoardFromGym = useDetachBoardFromGym();
  // `useMutation` returns a fresh object literal on every render, so depending on
  // the mutation objects would rebuild the action handler — and with it the
  // carousel's `renderItem` and every card's memo — on every commit.
  // `mutateAsync` is bound once by the MutationObserver, so it is the stable half
  // to close over.
  const deleteBoardAsync = deleteBoard.mutateAsync;
  const unfollowBoardAsync = unfollowBoard.mutateAsync;
  const linkBoardToGymAsync = linkBoardToGym.mutateAsync;
  const detachBoardFromGymAsync = detachBoardFromGym.mutateAsync;

  // Who is looking, so a card can tell your own wall from a gym you follow.
  // Deliberately NOT a gate: unlike /boards/manage, a missing id must never stop
  // you switching boards. It only takes Edit, Unfollow and Delete out of the
  // card menu — degraded, never blocked.
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { userId: storedUserId } = useStoredUserId(isAuthenticated && !profile?.id);
  const currentUserId = profile?.id ?? storedUserId;

  const [detailBoard, setDetailBoard] = useState<UserBoard | null>(null);
  // Where the open detail sheet was opened from, so its Climb here reports that.
  const detailPick = useRef<PickerPick>({ pickSource: 'your_boards' });
  // The gym named by a "your board came off {{gym}}" notification, while its
  // detail sheet is open: the sheet offers to ask that gym to list it again.
  const [detailRelistGym, setDetailRelistGym] = useState<RelistGym | null>(null);
  const closeBoardDetails = useCallback(() => {
    setDetailBoard(null);
    setDetailRelistGym(null);
  }, []);
  useEffect(() => {
    if (!isAuthenticated) closeBoardDetails();
  }, [isAuthenticated, closeBoardDetails]);

  // Report a problem (docs/product/directory-reports.md): the report sheet and
  // the review sheet are hosted here, inside the picker's modal, so they
  // present above it.
  const directoryReportsEnabled = useDirectoryReportsEnabled();
  const reportHost = useReportProblemHost();
  const openReportForBoard = reportHost.openReport;
  const [reviewBoard, setReviewBoard] = useState<UserBoard | null>(null);
  const closeReview = useCallback(() => setReviewBoard(null), []);
  // A board this picker was opened on (a notification, About this board) that
  // may sit in none of its lists: a staff member's gym board, say. Board
  // actions picked in its sheets resolve it from here when no list has it.
  //
  // Read fresh on arrival (`staleTime: 0`): the cache can hold a copy from
  // before the staff removal or report the notification is about, which would
  // show the gym the board just left, hide "Ask {{gym}} to list it again", or
  // offer review actions the viewer no longer has.
  const { data: linkedBoard, isFetching: linkedBoardFetching } = useBoard(
    isAuthenticated && linkedBoardParam ? linkedBoardParam : null,
    { staleTime: 0 },
  );
  // Opening a sheet is a one-way step, so it waits for the flag bag to be final
  // (`review=1` falls back to the detail sheet with the flag off) and for the
  // arrival refetch to land. Offline, a refetch that can't run stops fetching
  // and the cached copy opens.
  const flagsResolved = useFeatureFlagsResolved();
  // Open the linked board's sheet once.
  const linkedBoardOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedBoard || linkedBoardFetching || !flagsResolved) return;
    if (linkedBoardOpened.current === linkedBoard.uuid) return;
    const wantsReview = linkedReviewParam === '1';
    if (wantsReview && directoryReportsEnabled) {
      linkedBoardOpened.current = linkedBoard.uuid;
      setReviewBoard(linkedBoard);
    } else if (wantsReview || linkedDetailsParam === '1') {
      linkedBoardOpened.current = linkedBoard.uuid;
      detailPick.current = { pickSource: 'your_boards' };
      setDetailRelistGym(
        !wantsReview && linkedRelistGymUuidParam
          ? { uuid: linkedRelistGymUuidParam, name: linkedRelistGymParam ? linkedRelistGymParam : null }
          : null,
      );
      setDetailBoard(linkedBoard);
    }
  }, [
    linkedBoard,
    linkedBoardFetching,
    flagsResolved,
    directoryReportsEnabled,
    linkedReviewParam,
    linkedDetailsParam,
    linkedRelistGymParam,
    linkedRelistGymUuidParam,
  ]);
  // The open sheets show the linked board as it is now, not the copy they
  // opened with: a later refetch (a report closed, the board moved) reaches
  // them too.
  const shownDetailBoard = detailBoard && linkedBoard?.uuid === detailBoard.uuid ? linkedBoard : detailBoard;
  const shownReviewBoard = reviewBoard && linkedBoard?.uuid === reviewBoard.uuid ? linkedBoard : reviewBoard;

  // Pins the climber toggled since this modal opened, so the glyph flips under
  // the menu without waiting for a refetch. Deliberately does NOT reorder: the
  // pin mutation invalidates `myBoards` with `refetchType: 'none'`, so the new
  // order lands the next time the picker is opened rather than sliding the card
  // out from under the tap that made it.
  const [pinnedOverrides, setPinnedOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const pinBoard = usePinBoard({
    onPinError: (boardUuid) => {
      // Put the glyph back where the server still has it.
      setPinnedOverrides((previous) => {
        const next = new Map(previous);
        next.delete(boardUuid);
        return next;
      });
      showToast(t('mobile.discovery.pinError'), 'error');
    },
  });
  const pinBoardMutate = pinBoard.mutate;

  // With Manage, the only caller that lists unfinished spray walls: they show
  // import progress, and a press on one opens the wizard, never a climbing path.
  const {
    data: boardConnection,
    isLoading: isMyBoardsLoading,
    isError,
    refetch,
    isRefetching,
  } = useMyBoards(MY_BOARDS_WITH_IMPORTS_INPUT, { enabled: isAuthenticated });
  const {
    boards: myBoards,
    stale: importStatusStale,
    unfinishedWallUuids,
  } = useSprayImportProgress(boardConnection?.boards ?? EMPTY_BOARDS);

  // Whether Climbs' no-board entry gets "Where do you climb?": only when the
  // account has no boards at all. Someone whose active board was merely cleared
  // (an unfollow, a sign-out) gets their list, which is one tap from Climbs.
  // Decided once, from the first list that arrives, and then held: a pick from
  // the block follows or creates a board, and the refetch that lands behind the
  // dismissing modal must not swap the screen (or end its skip tracking early).
  // Set during render, React's pattern for state derived from the first value
  // of something, so the first frame is already the right branch.
  const [noBoardChoice, setNoBoardChoice] = useState<boolean | null>(null);
  if (fromNoBoard && noBoardChoice === null && boardConnection !== undefined) {
    setNoBoardChoice(boardConnection.boards.length === 0);
  }
  const firstBoardChoiceEntry: FirstBoardEntry | null = firstBoardMode
    ? 'launch_gate'
    : noBoardChoice === true
      ? 'no_board'
      : null;
  const showFirstBoardChoice = firstBoardChoiceEntry !== null;

  // Keep the offline snapshots in step with the live list: renames, a backfill for
  // boards downloaded before this existed, and a prune of boards the server no longer
  // lists. No-ops while offline.
  useRememberDownloadedBoards(boardConnection);

  // Offline (or a connection that reports online while every request fails), the
  // network board list is unavailable: `myBoards` is a plain `getHttpClient` query,
  // and with `networkMode: 'offlineFirst'` its retryer PAUSES rather than erroring —
  // so the screen used to render the "No boards yet — create one" empty state, a
  // false claim whose only CTA also needs the network. Fall back to the boards this
  // device has actually downloaded.
  const { effectiveOffline, reason: connectivityReason } = useConnectivity();
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  const offlineDownloadsEnabled = useOfflineDownloadsEnabled();
  const { confirmAndDownload } = useConfirmBoardDownload();
  // Whether the active board's catalog is missing, or merely queued after an
  // arm — the offline empty state below reads differently in each case.
  const offlineCatalog = useOfflineCatalogState(activeBoard);
  const offlineCards = useOfflineBoards();
  // `isError && nothing cached` is the lying-connection case: captive portal or gym
  // wifi with a dead upstream, where the phone reports a network, the request fails
  // for real, and retries never pause. Same belt-and-braces reasoning as
  // offlineAwareRequest's network-failure catch.
  const isLocalOnly = deriveLocalOnly({ effectiveOffline, isError, myBoardsCount: myBoards.length });
  // Which of the three "here's what's on your phone" lines to print — the notice
  // has to name the side that is actually down, not always the signal.
  const noticeKey = pickerNoticeKey({ reason: connectivityReason, isError });
  const offlineRows = useMemo(
    () =>
      isLocalOnly
        ? offlineBoardRows({
            cards: offlineCards,
            cachedMyBoards: myBoards,
            activeBoard: activeBoard ?? null,
            downloadedScopeKeys: downloadedScopeKeys ?? [],
          })
        : [],
    [isLocalOnly, offlineCards, myBoards, activeBoard, downloadedScopeKeys],
  );

  // The top of the picker: the Bluetooth scan behind it, and what it leads
  // with (At {gym}, the one board heard somewhere else, a box it can't name,
  // or what the scan needs). Only the online layout draws it: the offline list
  // and the error state have no top to fill. See use-picker-in-range.ts.
  const isFocused = useIsFocused();
  const inRange = usePickerInRange({
    focused: isFocused,
    showsTop: isAuthenticated && !isLocalOnly && !isError,
    knownBoards: myBoards,
    activeBoard,
  });
  const { scan: pickerScan, topView, topBoardUuids, topPicks } = inRange;
  const stopScan = pickerScan.stop;
  // A box held for the next bind (pending-board-recognition.ts) belongs to this
  // picker visit. The gym map and the builder are pushed over the picker, so
  // they bind, and use the hold, before this unmounts; anything after the
  // picker closes is about some other box.
  useEffect(() => clearPendingBoardRecognition, []);
  // The board type "Use my location" filtered Near you to while it held the
  // box its row stood for. A Near you pick of that type, with that filter still
  // on, is the one pick on this screen that may name the box: it is what the
  // hold is for here. Every other pick drops the hold first (`pickBoard`), so a
  // box the climber walked away from is never named after the board they
  // picked instead.
  const nearbyPickNamesHeldBox = useRef<BoardName | null>(null);
  const dropHeldBox = useCallback(() => {
    nearbyPickNamesHeldBox.current = null;
    clearPendingBoardRecognition();
  }, []);
  // Back on the picker after the builder or the gym map: a bind there closes
  // or replaces the picker, so coming back means that flow was abandoned, and
  // its box with it.
  const wasFocused = useRef(isFocused);
  useEffect(() => {
    if (isFocused && !wasFocused.current) dropHeldBox();
    wasFocused.current = isFocused;
  }, [isFocused, dropHeldBox]);

  // Both the "At a gym" choice and the location banner offer Open Settings
  // after a denial, so a second tap has to be able to ask again, and a climber
  // coming back from Settings with location on gets Near you without one. Not
  // under "Where do you climb?": there location waits for the "At a gym" tap,
  // so coming back to the app must not fetch it either.
  const location = useDeviceLocation({ retryAfterDenial: true, rereadWhenActive: !firstBoardMode });
  // Near you is for a climber who allowed location; everyone else gets the
  // banner at the foot of the picker, with the one way to turn it on.
  const locationAllowed = location.permission === 'granted';
  // Set by the In range slot's "Use my location" on a board it heard but
  // couldn't name: the nearby list then holds only that board type, so a
  // climber at a MoonBoard picks from the MoonBoards around them. Filtered by
  // the server, not just here: the 20 nearest boards of every type could hold
  // none of it. The list's title and empty line name the type and offer Show
  // all; "At a gym" clears it too. It lives and dies with this screen, so
  // closing the picker drops it.
  const [nearbyFilter, setNearbyFilter] = useState<NearbyTypeFilter | null>(null);
  // Only in the layout it was set in, so a filter set under "Where do you
  // climb?" never follows the climber into the ordinary list.
  const nearbyBoardType =
    nearbyFilter && nearbyFilter.inFirstBoardChoice === showFirstBoardChoice ? nearbyFilter.boardType : null;
  const nearbyBoardTypes = useMemo(() => (nearbyBoardType ? [nearbyBoardType] : undefined), [nearbyBoardType]);
  // Taking the filter off abandons the search for the held box, so the box goes
  // with it: a bind from the builder or the gym map after Show all must not
  // name it.
  const showAllNearby = useCallback(() => {
    dropHeldBox();
    setNearbyFilter(null);
  }, [dropHeldBox]);
  // 20 km, not the hook's 1 km default — "nearby" should reach across town
  // (a gym a couple of streets away must still surface).
  const {
    data: nearby,
    isFetching: isNearbyFetching,
    isPlaceholderData: isNearbyPlaceholder,
    fetchStatus: nearbyFetchStatus,
    isError: isNearbyError,
    refetch: refetchNearby,
  } = useNearbyBoards(location.coords, 20, undefined, undefined, nearbyBoardTypes);
  // The list on screen can be the previous search's answer (`keepPreviousData`),
  // held while a newly narrowed one loads. It says nothing about the new type
  // until that lands, so it counts as still searching: otherwise the list would
  // flash "No MoonBoards within 20 km" first. Not while paused offline, which
  // would spin for good.
  const isNearbySearching = isNearbyFetching || (isNearbyPlaceholder && nearbyFetchStatus !== 'paused');

  // See the boards index error path: a hard 401 clears tokens but doesn't flip
  // isAuthenticated, so re-validate on error to escape a stuck retry loop.
  useEffect(() => {
    if (isError) void refreshAuthState();
  }, [isError, refreshAuthState]);

  // Only the user's OWN boards carry a download state.
  const boardOfflineState = useBoardOfflineState();
  // The translated word a spray-wall row leads with. One object for every list
  // on this screen, so none of their memos churn.
  const labelOptions = useSprayLabelOptions();
  // At {gym} names the gym in its title, so its rows lead with what each wall
  // is, as the board sheet's gym walls do.
  const gymLabelOptions = useSprayLabelOptions('within-gym');

  // The top's boards as its rows draw them.
  // The climber's own and followed boards, by uuid: they draw (and bind) as
  // these fuller, fresher copies wherever the top lists them, and only they
  // get a menu At {gym}.
  const myBoardsByUuid = useMemo(() => new Map(myBoards.map((board) => [board.uuid, board])), [myBoards]);
  const myBoardKeys = useMemo<ReadonlySet<string>>(() => new Set(myBoardsByUuid.keys()), [myBoardsByUuid]);
  const topDisplay = useMemo<PickerTopView<DiscoveryBoardItem>>(
    () =>
      mapPickerTopBoards(topView, (boards, kind) =>
        pickerTopBoardsToItems(
          boards.map((row) => ({ ...row, board: myBoardsByUuid.get(row.board.uuid) ?? row.board })),
          {
            labelOptions: kind === 'at_gym' ? gymLabelOptions : labelOptions,
            climbersBoardKeys: myBoardKeys,
            offlineStateFor: boardOfflineState,
            currentUserId,
            pinnedOverrides,
            importStatusStale,
          },
        ),
      ),
    [
      topView,
      myBoardsByUuid,
      myBoardKeys,
      labelOptions,
      gymLabelOptions,
      boardOfflineState,
      currentUserId,
      pinnedOverrides,
      importStatusStale,
    ],
  );

  const myBoardItems = useMemo(
    // The server orders these: pinned first, then by when you last opened the
    // board, then never-opened by when you added it (#4884). The board you're
    // on keeps its place, marked, unless the top already lists it: it shows
    // once. `currentUserId` stamps `isViewerOwner` once per list build so no
    // row ever scans back into `myBoards` for it.
    () =>
      userBoardsToItems(
        orderBoardsForPartnerWorkout(withoutBoardsShown(myBoards, topBoardUuids), preferredWorkoutBoard),
        {
          activeUuid: activeBoard?.uuid,
          offlineStateFor: boardOfflineState,
          currentUserId,
          pinnedOverrides,
          labelOptions,
          importStatusStale,
        },
      ),
    [
      myBoards,
      topBoardUuids,
      activeBoard?.uuid,
      boardOfflineState,
      currentUserId,
      pinnedOverrides,
      labelOptions,
      importStatusStale,
      preferredWorkoutBoard,
    ],
  );
  // Whether the account has a board this screen can draw, shown at the top or
  // in Your boards. It decides the empty state and the board actions, so a
  // climber whose every board is At {gym} is not told they have none.
  const hasBoards = useMemo(() => myBoards.some((board) => toBoardName(board.boardType) !== null), [myBoards]);
  // Everything the Near you search returned, as cards.
  const nearbyResultItems = useMemo(
    () =>
      userBoardsToItems(
        // Also filtered here: while a newly filtered search loads, the query
        // keeps showing the previous, unfiltered list.
        orderBoardsForPartnerWorkout(
          nearbyBoardType
            ? (nearby?.boards ?? []).filter((board) => board.boardType === nearbyBoardType)
            : (nearby?.boards ?? []),
          preferredWorkoutBoard,
        ),
        { activeUuid: activeBoard?.uuid, labelOptions },
      ),
    [nearby?.boards, nearbyBoardType, activeBoard?.uuid, labelOptions, preferredWorkoutBoard],
  );
  // Near you leaves out boards already shown above it (the top and Your
  // boards). Not under "Where do you climb?", which draws Near you above Your
  // boards, and not while it is narrowed to one type: that search is for the
  // box the climber stands at, and a pick from it is what names the box, so
  // every candidate stays in it.
  const leavesOutBoardsShownAbove = !showFirstBoardChoice && nearbyBoardType === null;
  const nearbyItems = useMemo(() => {
    if (!leavesOutBoardsShownAbove) return nearbyResultItems;
    const myBoardUuids = new Set(myBoards.map((board) => board.uuid));
    return nearbyResultItems.filter((item) => !topBoardUuids.has(item.key) && !myBoardUuids.has(item.key));
  }, [leavesOutBoardsShownAbove, nearbyResultItems, myBoards, topBoardUuids]);

  // First-board mode's "At a gym" answer; see the handlers below.
  const [gymChosen, setGymChosen] = useState(false);
  // One reading of the nearby search for both layouts. The "At a gym" choice
  // counts as asked once it is tapped; Near you once location has been asked
  // for at all (on open when already allowed, a tap, or the onboarding preload),
  // or is allowed and about to be: never "not asked" while it shows.
  // It reads what the search returned, not what is left once the boards shown
  // above are out: "Nothing within 20 km" must never stand for "already listed".
  const nearbySearch = firstBoardGymState({
    chosen: showFirstBoardChoice ? gymChosen : location.status !== 'idle' || locationAllowed,
    locationStatus: location.status,
    // Any request in flight, not only the first load: a retry after an error
    // keeps the query in `error` while it runs, and should read as searching.
    nearbyLoading: isNearbySearching,
    nearbyFailed: isNearbyError,
    nearbyCount: nearbyResultItems.length,
  });
  // The same search for the picker's events, read the same in every layout:
  // the climber's choice does not change what the search came to.
  const nearbyResultCount = pickerNearbyResultCount({
    outcome: firstBoardGymState({
      chosen: location.status !== 'idle',
      locationStatus: location.status,
      nearbyLoading: isNearbySearching,
      nearbyFailed: isNearbyError,
      nearbyCount: nearbyResultItems.length,
    }),
    resultCount: nearbyResultItems.length,
  });
  const trackBoardSelection = useBoardPickerAnalytics({
    activeBoard,
    restoreFailed: boardRestoreFailed,
    returnTo: boardReturnTo,
    fromOnboarding,
    fromNoBoard,
    locationStatus: location.status,
    locationPermission: location.permission,
    // Outside "Where do you climb?" the picker reads the permission on open;
    // the opening waits for that read, or its locationStatus says nothing.
    locationPending: !firstBoardMode && !location.permissionChecked,
    nearbyResultCount,
  });
  const chooseFirstBoardPath = useFirstBoardPickerTracking(firstBoardChoiceEntry, nearbyResultCount);

  const activateBoard = useActivateBoard({
    source: fromOnboarding ? 'onboarding' : undefined,
    returnTo: boardReturnTo,
    isLocalOnly,
    onBound: trackBoardSelection,
  });

  const offlineItems = useMemo(
    () => userBoardsToItems(offlineRows, { activeUuid: activeBoard?.uuid, labelOptions }),
    [offlineRows, activeBoard?.uuid, labelOptions],
  );
  // Uuids of boards whose edit, unfollow or delete is running, confirm dialog
  // included. A ref, not state, so starting one re-renders nothing. Two things
  // read it:
  // - a second edit/unfollow/delete on the same board (the ⋯ and the hold are
  //   two ways in) runs nothing: two deletes would show two confirms and report
  //   a failure for the one that lost the race;
  // - picking that board runs nothing either. Edit mode used to disable the
  //   card body for this. On a slow connection a tap after confirming Delete
  //   would make the board active and close the picker, and the delete landing
  //   afterwards would skip clearing a selection it no longer recognised,
  //   leaving a deleted board active. Every other board stays pickable.
  const boardActionsInFlight = useRef<Set<string>>(new Set());

  // Every pick on this screen: a card, a row at the top, the detail sheet's
  // Climb here. The scan ends first, so a pick never leaves the radio running
  // (the bind may connect next, and a phone holding a board link must not
  // scan). An unfinished wall opens its import instead of binding, and a board
  // being edited, unfollowed or deleted is not picked at all. A held box goes
  // too, unless this is the Near you pick it was held for
  // (`nearbyPickNamesHeldBox`).
  const pickBoard = useCallback(
    (board: UserBoard, pick: PickerPick) => {
      if (boardActionsInFlight.current.has(board.uuid)) return;
      const namesHeldBox =
        pick.pickSource === 'nearby' &&
        nearbyBoardType !== null &&
        nearbyPickNamesHeldBox.current === nearbyBoardType &&
        toBoardName(board.boardType) === nearbyBoardType;
      if (!namesHeldBox) dropHeldBox();
      stopScan();
      const importRoute = unfinishedSprayWallRoute(board, unfinishedWallUuids);
      if (importRoute) {
        router.push(importRoute);
        return;
      }
      void activateBoard(board, pick);
    },
    [nearbyBoardType, dropHeldBox, stopScan, unfinishedWallUuids, router, activateBoard],
  );

  // myBoards / nearby items carry the original UserBoard via uuid; look it up to
  // activate. `pick` is the section the card sits in, not the list the lookup
  // happened to hit: a board you follow can also be Near you (under "Where do
  // you climb?"), and the event should say where you tapped.
  const activateItem = useCallback(
    (item: DiscoveryBoardItem, pick: PickerPick) => {
      // A no-op, not a toast: the card's own tap haptic has already answered.
      if (boardActionsInFlight.current.has(item.key)) return;
      const board =
        myBoards.find((b) => b.uuid === item.key) ??
        (nearby?.boards ?? []).find((b) => b.uuid === item.key) ??
        // Offline rows come from the persisted snapshots, which aren't in either
        // network list — without this an offline tap is dead.
        offlineRows.find((b) => b.uuid === item.key);
      if (board) {
        pickBoard(board, pick);
      } else {
        // The item's UserBoard should always be in one of the lists it came
        // from; if a refetch dropped it between render and tap, give feedback
        // rather than a dead tap.
        showToast(t('mobile.boardSwitchError'), 'error');
      }
    },
    [myBoards, nearby?.boards, offlineRows, pickBoard, showToast, t],
  );
  // The place the list drew the row in, which it passes on a pick; else one
  // `findIndex` per tap, never per row.
  const myBoardPick = useCallback(
    (item: DiscoveryBoardItem, position?: number): PickerPick => ({
      pickSource: 'your_boards',
      section: 'your_boards',
      position: position ?? positionOf(myBoardItems, item.key),
    }),
    [myBoardItems],
  );
  const nearbyPick = useCallback(
    (item: DiscoveryBoardItem): PickerPick => ({
      pickSource: 'nearby',
      section: 'near_you',
      position: positionOf(nearbyItems, item.key),
    }),
    [nearbyItems],
  );
  const onSelectMyBoard = useCallback(
    (item: DiscoveryBoardItem, position?: number) => activateItem(item, myBoardPick(item, position)),
    [activateItem, myBoardPick],
  );
  const onSelectNearbyBoard = useCallback(
    (item: DiscoveryBoardItem) => activateItem(item, nearbyPick(item)),
    [activateItem, nearbyPick],
  );
  const onSelectOfflineBoard = useCallback(
    (item: DiscoveryBoardItem, position?: number) =>
      activateItem(item, {
        pickSource: 'offline',
        section: 'offline',
        position: position ?? positionOf(offlineItems, item.key),
      }),
    [activateItem, offlineItems],
  );
  const detailBoardsByUuid = useMemo(() => {
    const boards = new Map<string, UserBoard>();
    for (const board of myBoards) boards.set(board.uuid, board);
    for (const board of nearby?.boards ?? []) boards.set(board.uuid, board);
    if (activeBoard) boards.set(activeBoard.uuid, activeBoard);
    return boards;
  }, [myBoards, nearby?.boards, activeBoard]);
  const openBoardDetails = useCallback(
    (item: DiscoveryBoardItem, pick: PickerPick) => {
      const board = detailBoardsByUuid.get(item.key);
      if (!board) return;
      detailPick.current = pick;
      setDetailBoard(board);
    },
    [detailBoardsByUuid],
  );
  const onMyBoardDetails = useCallback(
    (item: DiscoveryBoardItem, position?: number) => openBoardDetails(item, myBoardPick(item, position)),
    [openBoardDetails, myBoardPick],
  );
  const onNearbyBoardDetails = useCallback(
    (item: DiscoveryBoardItem) => openBoardDetails(item, nearbyPick(item)),
    [openBoardDetails, nearbyPick],
  );
  // Onboarding draws plain cards in both carousels: no ⋯ and no hold. The first
  // screen a new account sees carries the choice of board and nothing else, the
  // same rule the onboarding board step follows. "Where do you climb?" is the
  // same moment for a climber with no boards yet (Climbs' empty state), and its
  // "At a gym" answer shows the Near you carousel, so it draws plain cards too.
  const showCardMenus = !fromOnboarding && !showFirstBoardChoice;
  // Report a problem and See reports: the flag is on, the climber is signed in
  // and online, and this is not onboarding (which draws no menus anyway).
  const canReportBoards = directoryReportsEnabled && isAuthenticated && !isLocalOnly && !fromOnboarding;
  // Report a problem opens the report sheet; See reports the review sheet. The
  // board comes from the lists this picker shows, or the board it was opened on.
  const runReportAction = useCallback(
    (item: DiscoveryBoardItem, action: 'report' | 'review_reports') => {
      const board = detailBoardsByUuid.get(item.key) ?? (linkedBoard?.uuid === item.key ? linkedBoard : undefined);
      if (!board) return;
      if (action === 'report') openReportForBoard({ kind: 'board', board });
      else setReviewBoard(board);
    },
    [detailBoardsByUuid, linkedBoard, openReportForBoard],
  );
  // Near you's card menu: the rows NEARBY_MENU_CAPABILITIES offers.
  const onNearbyMenuAction = useCallback(
    (item: DiscoveryBoardItem, action: BoardCardMenuAction, via: BoardCardMenuVia) => {
      if (!showCardMenus) return;
      if (action === 'report' || action === 'review_reports') {
        if (!canReportBoards) return;
        trackBoardCardAction({ action, via, section: 'nearby' });
        runReportAction(item, action);
        return;
      }
      if (action !== 'climb_here' && action !== 'details') return;
      if (action === 'climb_here' && boardActionsInFlight.current.has(item.key)) return;
      trackBoardCardAction({ action, via, section: 'nearby' });
      if (action === 'climb_here') onSelectNearbyBoard(item);
      else onNearbyBoardDetails(item);
    },
    [showCardMenus, canReportBoards, runReportAction, onSelectNearbyBoard, onNearbyBoardDetails],
  );
  const onActiveBoardDetails = useCallback(() => {
    if (!activeBoard) return;
    // The active spray wall's details row sits in no section.
    detailPick.current = { pickSource: 'your_boards' };
    setDetailBoard(activeBoard);
  }, [activeBoard]);
  const onSetActiveFromDetails = useCallback(
    (board: UserBoard) => {
      closeBoardDetails();
      // `pickBoard` skips a board whose edit, unfollow or delete is running.
      pickBoard(board, detailPick.current);
    },
    [pickBoard, closeBoardDetails],
  );

  // Narrowed to one type, the title says which and Show all goes back to every
  // board, so a climber in a gym full of Kilters isn't left looking at "Near
  // you" with only MoonBoards in it.
  // The gym map, pushed with this picker's return and source, so a board picked
  // there binds like one picked here. `from=picker` tells the gym finder this
  // picker already counted the opening. It is the way forward from "Location
  // is off" and "Nothing within 20 km", and Near you's Map.
  const openGymMap = useCallback(() => {
    router.push(addBoardRoute('gym_map', { returnTo: boardReturnTo, source, fromPicker: true }));
  }, [router, boardReturnTo, source]);

  const nearbyTitle = nearbyListTitle(t, nearbyBoardType);
  // Show all while the list is narrowed to one type; otherwise the map, except
  // under "Where do you climb?", which has its own "Find your gym on the map".
  const nearbyAction: ShelfHeaderAction | undefined = nearbyBoardType
    ? { label: t('mobile.discovery.nearbyShowAll'), onPress: showAllNearby }
    : showFirstBoardChoice
      ? undefined
      : { label: t('mobile.discovery.nearbyMap'), onPress: openGymMap };
  const nearbyCarousel =
    nearbyItems.length > 0 ? (
      <BoardCarousel
        items={nearbyItems}
        onSelect={onSelectNearbyBoard}
        menuCapabilities={
          showCardMenus
            ? canReportBoards
              ? NEARBY_MENU_CAPABILITIES_WITH_REPORT
              : NEARBY_MENU_CAPABILITIES
            : undefined
        }
        onMenuAction={showCardMenus ? onNearbyMenuAction : undefined}
      />
    ) : null;
  // The boards "At a gym" found, under "Where do you climb?".
  const nearbySection = nearbyCarousel ? (
    <ShelfSection title={nearbyTitle} action={nearbyAction}>
      {nearbyCarousel}
    </ShelfSection>
  ) : null;
  // Download for offline, scoped to boards the user owns or follows. The menu
  // only offers it with the engine's platform gate open, so it never shows in
  // the Expo browser app (offline-downloads-enabled.web.ts hard-returns false)
  // or with offline off.
  const onDownloadMyBoard = useCallback(
    (item: DiscoveryBoardItem) => {
      const board = myBoards.find((candidate) => candidate.uuid === item.key);
      // An unfinished wall has no catalogue to download.
      if (!board || unfinishedSprayWallRoute(board, unfinishedWallUuids)) return;
      void confirmAndDownload(board).then((confirmed) => {
        if (!confirmed) return;
        // This surface deliberately has no impression event — a card scrolling
        // past in a carousel is not a suggestion the way a prompt is — so the
        // accept is what joins the menu row to the download funnel. Without it
        // the widest-reach discovery surface ships blind, which is the failure
        // epic #4319 exists to fix. Never arm-only: the row is online-only.
        trackNudgeAccepted(
          {
            surface: 'board_card',
            boardType: board.boardType,
            layoutId: board.layoutId,
            scopeKey: offlineBoardKeyForBoard(board),
            downloadedBoardCount: (downloadedScopeKeys ?? []).length,
          },
          'download',
        );
      });
    },
    [myBoards, confirmAndDownload, downloadedScopeKeys, unfinishedWallUuids],
  );

  // One `find` per pick — the shape `onSelectMyBoard` already uses — never per row.
  const runMyBoardAction = useCallback(
    async (item: DiscoveryBoardItem, action: BoardCardManageAction, knownBoard?: UserBoard) => {
      if (boardActionsInFlight.current.has(item.key)) return;
      boardActionsInFlight.current.add(item.key);
      try {
        // The board the caller already holds (the review sheet's); else Your
        // boards first, then a gym board staff reached from Near you or a
        // report notification, which they need not follow.
        const board =
          knownBoard ??
          myBoards.find((candidate) => candidate.uuid === item.key) ??
          nearby?.boards.find((candidate) => candidate.uuid === item.key) ??
          (linkedBoard?.uuid === item.key ? linkedBoard : undefined);
        if (!board) {
          showToast(t('mobile.boardSwitchError'), 'error');
          return;
        }
        // Unreachable from the UI — the menu draws a row only when the same rule
        // allows it — but bail explicitly rather than let a coercion collapse
        // "unknown" into "followed" and unfollow the user's own wall. A mismatch
        // is a stale row, so it runs nothing.
        if (!itemAllows(item, action)) return;
        if (action === 'edit') {
          router.push({ pathname: '/boards/edit', params: { boardUuid: board.uuid } });
          return;
        }
        // Who added the board decides what the confirms say about them.
        const origin = boardOriginFor(board, currentUserId);
        const creatorName = board.ownerDisplayName ?? '';
        const wasActive = activeBoard?.uuid === board.uuid;
        // Capture at action time: a render-time value can miss a queued board write.
        const activeBoardGeneration = getActiveBoardWriteGeneration();
        if (action === 'remove_from_gym') {
          const gymName = board.gymName ?? item.gymName ?? '';
          const gymUuid = board.gymUuid ?? null;
          const confirmed = await confirm({
            title: t('gymBoards.removeTitle', { board: board.name, gym: gymName }),
            message:
              origin === 'own'
                ? t('gymBoards.removeBodyOwn', { gym: gymName })
                : origin === 'synced'
                  ? t('gymBoards.removeBodySynced', { gym: gymName })
                  : origin === 'climber'
                    ? t('gymBoards.removeBodyOther', { name: creatorName, gym: gymName })
                    : t('gymBoards.removeBodyOtherHidden', { gym: gymName }),
            confirmLabel: t('gymBoards.removeConfirm'),
            cancelLabel: t('mobile.manage.cancel'),
          });
          if (!confirmed) return;
          try {
            // The creator unlinks their own board. Anyone else is staff, whose
            // removal also keeps the creator from linking it straight back.
            if (origin === 'own') {
              await linkBoardToGymAsync({ boardUuid: board.uuid, gymUuid: null });
            } else if (gymUuid) {
              await detachBoardFromGymAsync({ boardUuid: board.uuid, gymUuid });
            } else {
              // Location privacy kept the gym back, so there is nothing to name.
              showToast(t('gymBoards.removeFailed'), 'error');
              return;
            }
            showToast(t('gymBoards.removed', { gym: gymName }), 'success');
          } catch (error) {
            showToast(
              isSystemBoardDeleteInsteadError(error) ? t('gymBoards.removeSyncedError') : t('gymBoards.removeFailed'),
              'error',
            );
            return;
          }
          // The active board is a stored copy the mutation's invalidation
          // never reaches (see /boards/edit): without this the play drawer
          // keeps naming the gym the board just left. The removal is done and
          // announced; a failed local copy refresh is
          // not a failed removal, so it gets its own try and no error toast.
          if (wasActive) {
            try {
              await setActiveBoardIfCurrentGeneration(activeBoardGeneration, {
                ...board,
                gymId: null,
                gymUuid: null,
                gymName: null,
                gymIsListed: null,
                canRemoveFromGym: false,
              });
            } catch (error) {
              console.warn('Could not refresh the active board after removing it from its gym', error);
            }
          }
          return;
        }
        if (action === 'delete') {
          // "For everyone": delete takes the board from every climber who saved
          // it, which the old "Remove from your boards?" copy hid. Logged sends
          // are never touched.
          const confirmed = await confirm({
            title:
              board.boardType === 'spray'
                ? t('mobile.manage.deleteWallTitle')
                : t('gymBoards.deleteTitle', { board: board.name }),
            message:
              board.boardType === 'spray'
                ? t('mobile.manage.deleteWallMessage', { name: board.name })
                : origin === 'own'
                  ? t('gymBoards.deleteBodyOwn')
                  : origin === 'synced'
                    ? t('gymBoards.deleteBodySynced')
                    : origin === 'climber'
                      ? t('gymBoards.deleteBodyOther', { name: creatorName })
                      : t('gymBoards.deleteBodyOtherHidden'),
            confirmLabel: t('mobile.manage.deleteConfirm'),
            cancelLabel: t('mobile.manage.cancel'),
            destructive: true,
          });
          if (!confirmed) return;
          try {
            await deleteBoardAsync(board.uuid);
            // The offline picker's snapshot goes with it. The download itself stays
            // (a sibling board can share the scope), but a card for a board the
            // backend has dropped must never reach setActiveBoard.
            forgetOfflineBoard(board.uuid);
            if (wasActive && activeBoardGeneration === getActiveBoardWriteGeneration()) {
              await clearSession({ notifyServer: true });
              await clearActiveBoard(activeBoardGeneration);
            }
            showToast(t('mobile.manage.deleteSuccess', { name: board.name }), 'success');
          } catch {
            showToast(t('mobile.manage.deleteError'), 'error');
          }
          return;
        }
        // Unfollow is reversible and stays one tap — except on the active board,
        // where it also clears the selection out from under a live session. Not
        // destructive: the board stays for everyone else.
        if (wasActive) {
          const confirmed = await confirm({
            title: t('mobile.manage.unfollowTitle'),
            message: t('mobile.manage.unfollowMessage', { name: board.name }),
            confirmLabel: t('mobile.manage.unfollowConfirm'),
            cancelLabel: t('mobile.manage.cancel'),
          });
          if (!confirmed) return;
        }
        try {
          await unfollowBoardAsync(board.uuid);
          forgetOfflineBoard(board.uuid);
          if (wasActive && activeBoardGeneration === getActiveBoardWriteGeneration()) {
            await clearSession({ notifyServer: true });
            await clearActiveBoard(activeBoardGeneration);
          }
        } catch {
          showToast(t('mobile.manage.unfollowError'), 'error');
        }
      } finally {
        boardActionsInFlight.current.delete(item.key);
      }
    },
    [
      myBoards,
      nearby?.boards,
      linkedBoard,
      router,
      activeBoard?.uuid,
      currentUserId,
      confirm,
      deleteBoardAsync,
      unfollowBoardAsync,
      linkBoardToGymAsync,
      detachBoardFromGymAsync,
      clearActiveBoard,
      setActiveBoardIfCurrentGeneration,
      clearSession,
      showToast,
      t,
    ],
  );

  const setBoardPinned = useCallback(
    (item: DiscoveryBoardItem, pinned: boolean) => {
      setPinnedOverrides((previous) => {
        const next = new Map(previous);
        next.set(item.key, pinned);
        return next;
      });
      pinBoardMutate({ boardUuid: item.key, pinned });
    },
    [pinBoardMutate],
  );

  // The review sheet's board actions. Fix opens the edit route (which tells the
  // climber their save closes the report); Remove and Delete run the same
  // confirms and mutations as the card menu's rows, on the board the sheet
  // showed: it need not sit in any list this picker loaded.
  const onReviewAction = useCallback(
    (action: ReportReviewAction, board: UserBoard) => {
      if (action === 'fix') {
        router.push({ pathname: '/boards/edit', params: { boardUuid: board.uuid, fromReport: '1' } });
        return;
      }
      const item = userBoardToItem(board, activeBoard?.uuid, undefined, currentUserId);
      if (!item) return;
      void runMyBoardAction(item, action === 'remove' ? 'remove_from_gym' : 'delete', board);
    },
    [router, activeBoard?.uuid, currentUserId, runMyBoardAction],
  );
  const openReviewFromDetails = useCallback(
    (board: UserBoard) => {
      closeBoardDetails();
      setReviewBoard(board);
    },
    [closeBoardDetails],
  );

  // Gates Edit, Remove from gym, Unfollow and Delete in every card's menu. Also off with no
  // boards, with no resolvable identity, and offline — where every action behind
  // it is a network mutation. Onboarding has no card menu at all (below).
  const canEditBoards = hasBoards && currentUserId !== undefined && !isLocalOnly && !fromOnboarding;
  // Same family of gates as canEditBoards, minus the identity requirement: a pin
  // is the viewer's own state and does not depend on knowing who owns the board.
  // Offline is still out — the mutation could not reach the server.
  const canPinBoards = !isLocalOnly && !fromOnboarding && isAuthenticated;
  const myBoardMenuCapabilities = useMemo<BoardCardMenuCapabilities>(
    () => ({
      canPin: canPinBoards,
      canDownload: offlineDownloadsEnabled,
      canOpenDetails: true,
      canManage: canEditBoards,
      canReport: canReportBoards,
    }),
    [canPinBoards, offlineDownloadsEnabled, canEditBoards, canReportBoards],
  );

  // Every row of a "Your boards" card menu lands here, from the ⋯, the hold or
  // a screen-reader action. The menu only offers what the capabilities above
  // allow; the gates are checked again here, so a row drawn before the climber
  // went offline cannot run a mutation that would fail. A refused row runs
  // nothing and is not counted.
  // At {gym} draws the same rows for the walls that are the climber's, so both
  // lists run them here; `section` says which list for `Board Card Action`, and
  // Climb here and Details go through that list's own pick and details.
  const runBoardMenuAction = useCallback(
    (
      item: DiscoveryBoardItem,
      action: BoardCardMenuAction,
      via: BoardCardMenuVia,
      { section, select, openDetails }: BoardMenuSection,
    ) => {
      if (!showCardMenus) return;
      switch (action) {
        case 'climb_here':
          // The board is being edited, unfollowed or deleted: see boardActionsInFlight.
          if (boardActionsInFlight.current.has(item.key)) return;
          trackBoardCardAction({ action, via, section });
          select(item);
          return;
        case 'pin':
        case 'unpin':
          if (!canPinBoards) return;
          trackBoardCardAction({ action, via, section });
          setBoardPinned(item, action === 'pin');
          return;
        case 'download':
          if (!offlineDownloadsEnabled) return;
          trackBoardCardAction({ action, via, section });
          onDownloadMyBoard(item);
          return;
        case 'details':
          trackBoardCardAction({ action, via, section });
          openDetails(item);
          return;
        case 'report':
        case 'review_reports':
          if (!canReportBoards) return;
          trackBoardCardAction({ action, via, section });
          runReportAction(item, action);
          return;
        case 'reported':
          // A disabled row: it only says the climber's report is in.
          return;
        case 'edit':
        case 'remove_from_gym':
        case 'unfollow':
        case 'delete':
          if (!canEditBoards || !itemAllows(item, action) || boardActionsInFlight.current.has(item.key)) return;
          trackBoardCardAction({ action, via, section });
          void runMyBoardAction(item, action);
          return;
      }
    },
    [
      showCardMenus,
      canReportBoards,
      runReportAction,
      canPinBoards,
      setBoardPinned,
      offlineDownloadsEnabled,
      onDownloadMyBoard,
      canEditBoards,
      runMyBoardAction,
    ],
  );
  const onMyBoardMenuAction = useCallback(
    (item: DiscoveryBoardItem, action: BoardCardMenuAction, via: BoardCardMenuVia, position?: number) =>
      runBoardMenuAction(item, action, via, {
        section: 'your_boards',
        select: (picked) => onSelectMyBoard(picked, position),
        openDetails: (opened) => onMyBoardDetails(opened, position),
      }),
    [runBoardMenuAction, onSelectMyBoard, onMyBoardDetails],
  );

  const onManageBoards = useCallback(() => {
    router.push('/boards/manage');
  }, [router]);
  // The full vertical list with the per-board download console, as Your boards'
  // own action. With the drawer's second board row gone this and
  // OfflineSpotlightCard are the only routes to it, so it is on the offline
  // branch too: it is navigation, not a mutation, and the manage screen has its
  // own offline list.
  const manageAction: ShelfHeaderAction = {
    label: t('mobile.discovery.manage'),
    accessibilityLabel: tCommon('myBoards.title'),
    onPress: onManageBoards,
  };

  // Whenever the climber has boards, so Manage is always one tap away: with
  // every board already listed above (one board, at a gym, the one they're
  // on), the shelf says so in one quiet line.
  const myBoardsSection = hasBoards ? (
    <ShelfSection title={t('mobile.discovery.yourBoardsTitle')} action={manageAction}>
      {myBoardItems.length > 0 ? (
        <BoardRowList
          items={myBoardItems}
          onSelect={onSelectMyBoard}
          menuCapabilities={showCardMenus ? myBoardMenuCapabilities : undefined}
          onMenuAction={showCardMenus ? onMyBoardMenuAction : undefined}
          collapsedRowCount={YOUR_BOARDS_COLLAPSED_ROW_COUNT}
          BoardArt={DiscoveryBoardArt}
          testID="picker-your-boards"
        />
      ) : (
        <EmptyState size="quiet" title={t('mobile.discovery.yourBoardsAllAbove')} />
      )}
    </ShelfSection>
  ) : null;

  const requestLocation = location.request;
  const requestLocationIfAllowed = location.requestIfAllowed;
  const refreshLocation = location.refresh;
  const locationGranted = location.status === 'granted';
  // A climber who already allowed location gets Near you on open, with no
  // prompt; onboarding's handoff too. Nothing here shows the system prompt on
  // open: the rest get "See gyms near you", which asks from a tap. Not in
  // first-board mode: there the question comes with its reason, on the "At a
  // gym" tap, instead of as the first thing a newcomer sees.
  useEffect(() => {
    if (!firstBoardMode) void requestLocationIfAllowed();
  }, [firstBoardMode, requestLocationIfAllowed]);
  // Never a dead tap (#5654). With location allowed it takes a fresh fix: a
  // climber who has moved since "Nothing within 20 km" gets a search from where
  // they are now (new coordinates, so a new query), and one who has not gets
  // the same search run again. Without a fix it asks for location again, which
  // after a denial is how a climber back from Settings gets their gyms.
  const searchNearby = useCallback(() => {
    if (!locationGranted) {
      void requestLocation();
      return;
    }
    void refreshLocation().then((moved) => {
      if (!moved) void refetchNearby();
    });
  }, [locationGranted, refetchNearby, refreshLocation, requestLocation]);

  // Every way to add a board: the + (or + menu), the empty state and "Where do
  // you climb?". `source` rides along so a board made on the route closes out
  // onboarding exactly like a pick here: creating a board is how a home-wall
  // owner binds their first one, and the wall wizard binds a Spraywall.
  //
  // With the add-a-board wizard on, a board is set up through the wizard: the +
  // and the empty state open its step 1, "Where's the board?".
  const wizardEnabled = useAddBoardWizardEnabled();
  const openAddRoute = useCallback(
    (kind: BoardPickerAddKind, surface: BoardPickerAddSurface) => {
      trackBoardPickerAddSelected({ kind, surface });
      const wizardEntry =
        kind === 'board' && wizardEnabled && (surface === 'picker' || surface === 'empty_state') ? surface : undefined;
      router.push(addBoardRoute(kind, { returnTo: boardReturnTo, source, fromPicker: true, wizardEntry }));
    },
    [router, boardReturnTo, source, wizardEnabled],
  );
  const onAddFromMenu = useCallback((kind: BoardPickerAddKind) => openAddRoute(kind, 'picker'), [openAddRoute]);
  const onAddWizard = useCallback(() => openAddRoute('board', 'picker'), [openAddRoute]);
  const onEmptySetUpBoard = useCallback(() => openAddRoute('board', 'empty_state'), [openAddRoute]);
  const onEmptyAddSprayWall = useCallback(() => openAddRoute('spraywall', 'empty_state'), [openAddRoute]);

  // The + in the top bar. Online and signed in only: every way behind it needs
  // a connection and an account. Not under "Where do you climb?", whose three
  // cards are those same choices.
  const navigation = useNavigation();
  const canAddBoards = isAuthenticated && !isLocalOnly && !isError && !showFirstBoardChoice;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: canAddBoards
        ? wizardEnabled
          ? () => <AddBoardButton onPress={onAddWizard} />
          : () => <AddBoardMenu onSelect={onAddFromMenu} />
        : undefined,
    });
  }, [navigation, canAddBoards, onAddFromMenu, onAddWizard, wizardEnabled]);

  // First-board mode's answers. Each one is the existing flow behind it, plus
  // the choice event; see FirstBoardChoice.
  const onFirstBoardGym = useCallback(() => {
    chooseFirstBoardPath('gym');
    dropHeldBox();
    setNearbyFilter(null);
    setGymChosen(true);
    searchNearby();
  }, [chooseFirstBoardPath, dropHeldBox, searchNearby]);
  // The builder opens preset with a layout and size, so a home-wall owner's
  // Save works from the first frame instead of after finding the layout chip.
  // With the wizard on, At home is the wizard's step 1 answered here, inline:
  // it goes on to Which board? (step 2 of 3), so the art picks the type.
  const onFirstBoardOwn = useCallback(() => {
    chooseFirstBoardPath('own');
    if (wizardEnabled) {
      trackBoardPickerAddSelected({ kind: 'board', surface: 'first_run', boardKind: 'home' });
      trackBoardKindChosen({ kind: 'home', surface: 'first_run', preAnswered: true });
      router.push(wizardBoardHref({ returnTo: boardReturnTo, source, entry: 'first_run', trail: ['where'] }, 'home'));
      return;
    }
    trackBoardPickerAddSelected({ kind: 'board', surface: 'first_run' });
    router.push(addBoardRoute('board', { returnTo: boardReturnTo, source, preset: BUILDER_PRESET_PARAM_VALUE }));
  }, [chooseFirstBoardPath, router, boardReturnTo, source, wizardEnabled]);
  // The wall wizard binds with the onboarding `source` too, so a wall closes out
  // first-run like any other first board.
  const onFirstBoardSprayWall = useCallback(() => {
    chooseFirstBoardPath('spray_wall');
    openAddRoute('spraywall', 'first_run');
  }, [chooseFirstBoardPath, openAddRoute]);
  const onFirstBoardGymMap = useCallback(() => {
    chooseFirstBoardPath('gym_map');
    openAddRoute('gym_map', 'first_run');
  }, [chooseFirstBoardPath, openAddRoute]);

  // The In range slot's buttons (use-in-range-actions.ts).
  const inRangeActions = useInRangeActions({
    scan: pickerScan,
    router,
    chooseFirstBoardPath,
    dropHeldBox,
    boardReturnTo,
    source,
    wizardEnabled,
  });
  const { startUnnamedRowAction } = inRangeActions;
  // A row at the top (At {gym}, or the hero's Climb here). A pick the scan led
  // to is the first-board "scan" path; a wall At {gym} because of the board
  // you're on is not. A board in Your boards binds as that fuller copy: the
  // gym's roster is a narrower read of the same board.
  // `drawnPosition` is where At {gym}'s list drew the row, which a collapsed
  // list knows and the full order doesn't.
  const onPickTopBoard = useCallback(
    (item: DiscoveryBoardItem, drawnPosition?: number) => {
      const topPick = topPicks.get(item.key);
      if (!topPick) return;
      if (topPick.pickSource === 'bluetooth') chooseFirstBoardPath('scan');
      const uuid = boardUuidOrNull(topPick.board.uuid);
      const board = (uuid ? myBoards.find((saved) => saved.uuid === uuid) : undefined) ?? topPick.board;
      const { pickSource, section, position } = topPick;
      // A box held from an earlier tap on a row it couldn't name is not this
      // board: `pickBoard` drops it for every pick but the Near you one.
      pickBoard(board, { pickSource, section, position: drawnPosition ?? position });
    },
    [topPicks, chooseFirstBoardPath, myBoards, pickBoard],
  );
  const onAtGymDetails = useCallback(
    (item: DiscoveryBoardItem, drawnPosition?: number) => {
      const topPick = topPicks.get(item.key);
      if (!topPick) return;
      const { pickSource, section, position } = topPick;
      openBoardDetails(item, { pickSource, section, position: drawnPosition ?? position });
    },
    [topPicks, openBoardDetails],
  );
  const onAtGymMenuAction = useCallback(
    (item: DiscoveryBoardItem, action: BoardCardMenuAction, via: BoardCardMenuVia, position?: number) =>
      runBoardMenuAction(item, action, via, {
        section: 'at_gym',
        select: (picked) => onPickTopBoard(picked, position),
        openDetails: (opened) => onAtGymDetails(opened, position),
      }),
    [runBoardMenuAction, onPickTopBoard, onAtGymDetails],
  );
  // "Use my location", one of the three ways forward for a board it heard but
  // couldn't name: the boards near the climber, of that type only. In
  // first-board mode they show under "At a gym", elsewhere in Near you. A pick
  // from that filtered list is the one that may name the held box.
  const onInRangeUseMyLocation = useCallback(
    (row: UnnamedInRangeRow) => {
      const holdsBox = startUnnamedRowAction(row);
      nearbyPickNamesHeldBox.current = holdsBox ? row.boardType : null;
      setNearbyFilter({ boardType: row.boardType, inFirstBoardChoice: showFirstBoardChoice });
      if (showFirstBoardChoice) setGymChosen(true);
      searchNearby();
    },
    [startUnnamedRowAction, searchNearby, showFirstBoardChoice],
  );
  // "See gym" on At {gym}: the gym's page, pushed in this modal's own stack.
  const onSeeTopGym = useCallback(
    (gymUuid: string) => router.push(gymPageHref(gymUuid, 'boards', boardReturnTo)),
    [router, boardReturnTo],
  );
  const inRangeSection = (
    <InRangeSection
      view={topDisplay}
      BoardArt={DiscoveryBoardArt}
      onStart={inRangeActions.onStart}
      onOpenSettings={inRangeActions.onOpenSettings}
      bluetoothOffFix={inRange.bluetoothOffFix}
      onTurnOnBluetooth={inRangeActions.onTurnOnBluetooth}
      onBluetoothNotNow={inRange.sayBluetoothNotNow}
      onRetryLookup={inRangeActions.onRetryLookup}
      onPickBoard={onPickTopBoard}
      onUseMyLocation={onInRangeUseMyLocation}
      onSearchGyms={inRangeActions.onSearchGyms}
      onOwnBoard={inRangeActions.onOwnBoard}
      locationHint={inRange.locationHint}
      atGymMenuCapabilities={showCardMenus ? myBoardMenuCapabilities : undefined}
      onAtGymMenuAction={showCardMenus ? onAtGymMenuAction : undefined}
      atGymMenuKeys={myBoardKeys}
      onSeeGym={onSeeTopGym}
    />
  );

  const onOpenLocationSettings = useCallback(() => {
    void openAppSettings();
  }, []);
  const onRetryNearby = useCallback(() => {
    void refetchNearby();
  }, [refetchNearby]);
  // Near you in the ordinary layout, above Your boards once location is
  // allowed: the boards it found, or one quiet line under the header (which
  // keeps Map): still looking, nothing within 20 km, a failed lookup, no fix,
  // or every board it found already shown elsewhere in the picker.
  // Your boards sits right under it, so the search's answer, a second or
  // three after open, must not move it: placeholder cards hold the space while
  // it searches, and the answer keeps at least that height (NearbyReservedSlot).
  // Cards already on screen stay through a search again (a fresh fix).
  const nearbyPanel = locationAllowed ? (
    <ShelfSection title={nearbyTitle} action={nearbyAction}>
      <NearbyReservedSlot
        searching={nearbySearch === 'searching' && nearbyCarousel === null}
        quiet={nearbyCarousel === null}
      >
        {nearbyCarousel ?? (
          <NearbyQuietStatus
            state={nearbySearch}
            allShownAbove={nearbySearch === 'found' && nearbyItems.length === 0}
            onRetryNearby={onRetryNearby}
            onOpenSettings={onOpenLocationSettings}
            onFindGymOnMap={openGymMap}
            boardType={nearbyBoardType}
          />
        )}
      </NearbyReservedSlot>
    </ShelfSection>
  ) : undefined;
  // Without location, the foot of the picker asks for it again: "See gyms
  // near you", the same card as the gym map, sharing its 14-day "Not now".
  // Nothing before the permission is read, so the card never flashes.
  const locationBanner =
    location.permission === 'ask' || location.permission === 'blocked' ? (
      <LocationAskCard
        surface="board_picker"
        permission={location.permission}
        onAllow={requestLocation}
        onRecheck={requestLocationIfAllowed}
        style={styles.locationAskGutter}
      />
    ) : undefined;

  // The offline branch must not be swallowed by the loading spinner: the very first
  // offline render is still "fetching" before the retryer pauses.
  if (isMyBoardsLoading && !isLocalOnly) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.centered}>
        <Icon name="person" size={40} color={systemColors.secondaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.signInTitle')}
        </Text>
        <Text variant="subheadline" tone="secondary" style={styles.stateSubtitle}>
          {t('mobile.signInSubtitle')}
        </Text>
        <Button title={t('mobile.signInCta')} onPress={() => openSignIn(router, 'boards')} style={styles.stateButton} />
      </ScrollView>
    );
  }

  // No usable network list: offer what this device downloaded instead of In
  // range, Near you and the ways to add a board, which all need a connection.
  if (isLocalOnly) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={styles.flex}
        contentContainerStyle={[styles.container, { paddingBottom: scrollBottomPadding }]}
        showsVerticalScrollIndicator={false}
      >
        {/* "No signal" is only true when the phone is the thing that is down.
            Offline mode and a Boardsesh outage each get their own line — literal
            `t()` keys, because the i18n linter rejects a computed one. */}
        <Text variant="subheadline" tone="secondary" style={styles.offlineNotice}>
          {noticeKey === 'pickerNoticeOfflineMode'
            ? t('mobile.offline.pickerNoticeOfflineMode')
            : noticeKey === 'pickerNoticeUnreachable'
              ? t('mobile.offline.pickerNoticeUnreachable')
              : t('mobile.offline.pickerNotice')}
        </Text>
        {offlineItems.length > 0 ? (
          <ShelfSection title={t('mobile.discovery.yourBoardsTitle')} action={manageAction}>
            <BoardRowList
              items={offlineItems}
              onSelect={onSelectOfflineBoard}
              BoardArt={DiscoveryBoardArt}
              testID="picker-offline-boards"
            />
          </ShelfSection>
        ) : (
          <EmptyState
            size="section"
            title={t('mobile.offline.pickerEmptyTitle')}
            body={t('mobile.offline.pickerEmptyBody')}
            actions={
              // Only the lying-connection case gets a retry — offline it would just
              // pause, and the user already knows they have no signal.
              isError ? (
                <Button
                  title={t('mobile.errorRetry')}
                  variant="outlined"
                  loading={isRefetching}
                  onPress={() => void refetch()}
                />
              ) : undefined
            }
          />
        )}
        {/* Outside the empty state, because `offlineBoardRows` always offers the
            active board: the empty state only happens when there is NO board to
            suggest, so a CTA anchored inside it could never render. Here it sits
            under the carousel the un-downloaded board is showing in.

            Arm-only, and it takes itself away the moment the scope leaves 'off'
            — which is why the queued line has to replace it rather than let the
            screen fall silent on a board the user just asked for. */}
        {offlineCatalog === 'queued' ? (
          <Text variant="subheadline" tone="secondary" style={styles.offlineNotice}>
            {t('mobile.offline.pickerQueuedNotice', { name: activeBoard?.name ?? '' })}
          </Text>
        ) : (
          <OfflineCatalogCta board={activeBoard} style={styles.emptyCta} />
        )}
      </ScrollView>
    );
  }

  if (isError) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.centered}>
        <Icon name="error" size={40} color={systemColors.error} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.errorTitle')}
        </Text>
        <Button
          title={t('mobile.errorRetry')}
          variant="outlined"
          loading={isRefetching}
          onPress={() => void refetch()}
          style={styles.stateButton}
        />
      </ScrollView>
    );
  }

  return (
    <BoardSelectorView
      scrollBottomPadding={scrollBottomPadding}
      activeSprayName={activeBoard?.boardType === 'spray' ? activeBoard.name : undefined}
      onActiveBoardDetails={onActiveBoardDetails}
      showFirstBoardChoice={showFirstBoardChoice}
      fromOnboarding={fromOnboarding}
      inRangeSection={inRangeSection}
      myBoardsSection={myBoardsSection}
      nearbySection={nearbyPanel}
      locationBanner={locationBanner}
      hasBoards={hasBoards}
      onEmptySetUpBoard={onEmptySetUpBoard}
      onEmptyAddSprayWall={onEmptyAddSprayWall}
      firstBoardChoice={
        <FirstBoardChoice
          gymState={nearbySearch}
          nearbyResults={nearbySection}
          onGym={onFirstBoardGym}
          onOwn={onFirstBoardOwn}
          onAddSprayWall={onFirstBoardSprayWall}
          onFindGymOnMap={onFirstBoardGymMap}
          onOpenSettings={onOpenLocationSettings}
          onRetryNearby={onRetryNearby}
          nearbyBoardType={nearbyBoardType}
          onShowAllNearby={showAllNearby}
          wizardCopy={wizardEnabled}
        />
      }
      overlays={
        <>
          <BoardDetailSheet
            board={shownDetailBoard}
            visible={shownDetailBoard !== null}
            onClose={closeBoardDetails}
            onSetActive={onSetActiveFromDetails}
            onReviewReports={directoryReportsEnabled ? openReviewFromDetails : undefined}
            relistGym={detailRelistGym}
            returnTo={boardReturnTo}
          />
          {reportHost.sheet}
          {shownReviewBoard ? (
            <ReportReviewSheet
              key={shownReviewBoard.uuid}
              board={shownReviewBoard}
              viewerUserId={currentUserId ?? null}
              onClose={closeReview}
              onAction={onReviewAction}
            />
          ) : null}
        </>
      }
    />
  );
}
const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    paddingTop: spacing[4],
  },
  offlineNotice: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[5],
  },
  locationAskGutter: {
    paddingHorizontal: spacing[4],
  },
  centered: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateSubtitle: {
    marginTop: spacing[1],
    textAlign: 'center',
  },
  stateButton: {
    marginTop: spacing[4],
  },
  emptyCta: {
    marginTop: spacing[5],
  },
});
