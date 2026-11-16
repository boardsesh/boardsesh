import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import { useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { addBoardRoute } from '../../src/components/board-discovery/add-board-route';
import { AddBoardMenu } from '../../src/components/board-discovery/AddBoardMenu';
import { AlsoAtGymSection } from '../../src/components/board-discovery/AlsoAtGymSection';
import { hoistActiveBoard } from '../../src/components/board-discovery/board-card-actions';
import type {
  BoardCardMenuAction,
  BoardCardMenuCapabilities,
  BoardCardMenuVia,
} from '../../src/components/board-discovery/board-card-menu';
import { boardRowsToItems, userBoardsToItems } from '../../src/components/board-discovery/board-items';
import { BoardCarousel } from '../../src/components/board-discovery/BoardCarousel';
import { BoardDetailSheet } from '../../src/components/board-discovery/BoardDetailSheet';
import type { DiscoveryBoardItem } from '../../src/components/board-discovery/BoardDiscoveryCard';
import {
  BoardSelectorView,
  BoardSelectorSection as Section,
} from '../../src/components/board-discovery/BoardSelectorView';
import { DiscoveryBoardArt } from '../../src/components/board-discovery/DiscoveryBoardArt';
import { FirstBoardChoice } from '../../src/components/board-discovery/FirstBoardChoice';
import {
  alsoAtGymAnchor,
  inRangeView,
  mapInRangeBoards,
  type InRangeBoardRow,
  type InRangeView,
  type UnnamedInRangeRow,
} from '../../src/components/board-discovery/in-range-view';
import { InRangeSection } from '../../src/components/board-discovery/InRangeSection';
import { nearbyListTitle } from '../../src/components/board-discovery/nearby-board-type-copy';
import { NearbySearchStatus } from '../../src/components/board-discovery/NearbySearchStatus';
import { offlineBoardRows } from '../../src/components/board-discovery/offline-board-items';
import { useBoardOfflineState } from '../../src/components/board-discovery/use-board-offline-state';
import { useInRangeLocationHint } from '../../src/components/board-discovery/use-in-range-location-hint';
import { usePickerBoardScan } from '../../src/components/board-discovery/use-picker-board-scan';
import { Button } from '../../src/components/Button';
import { Icon } from '../../src/components/Icon';
import { OfflineCatalogCta } from '../../src/components/offline/OfflineCatalogCta';
import { PressableSurface } from '../../src/components/PressableSurface';
import { Text } from '../../src/components/Text';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useStoredUserId } from '../../src/hooks/use-current-user-id';
import { trackBoardCardAction } from '../../src/lib/boards/board-card-action-analytics';
import {
  trackBoardPickerAddSelected,
  type BoardPickerAddKind,
  type BoardPickerAddSurface,
} from '../../src/lib/boards/board-picker-add-analytics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { firstBoardGymState } from '../../src/lib/boards/first-board-gym-state';
import {
  BUILDER_PRESET_PARAM_VALUE,
  isFirstBoardMode,
  isNoBoardEntry,
  type FirstBoardEntry,
} from '../../src/lib/boards/first-board-mode';
import { deriveLocalOnly, pickerNoticeKey } from '../../src/lib/boards/local-only';
import {
  clearPendingBoardRecognition,
  setPendingBoardRecognition,
} from '../../src/lib/boards/pending-board-recognition';
import { useActivateBoard, type BoardPickSource } from '../../src/lib/boards/use-activate-board';
import { useBoardPickerAnalytics } from '../../src/lib/boards/use-board-picker-analytics';
import { useConnectivity } from '../../src/lib/connectivity/use-connectivity';
import {
  useDeleteBoard,
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
import { useOfflineDownloadsEnabled, usePickerAutoScanEnabled } from '../../src/providers/feature-flags-provider';
import { useQueueActions } from '../../src/providers/queue-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useToast } from '../../src/providers/toast-provider';
import { forgetOfflineBoard, offlineBoardKeyForBoard, useOfflineBoards } from '../../src/settings';
import { spacing } from '../../src/theme/tokens';

// Module-level so an absent board list keeps a stable identity: offline
// `boardConnection` is always undefined, and a fresh `[]` per render would
// recompute the offline rows on every commit.
const EMPTY_BOARDS: UserBoard[] = [];

// Near you boards belong to other people: their cards offer Climb here and
// Details, nothing that manages a board.
const NEARBY_MENU_CAPABILITIES: BoardCardMenuCapabilities = {
  canPin: false,
  canDownload: false,
  canOpenDetails: true,
  canManage: false,
};

/**
 * Edit and delete are for boards the viewer owns, unfollow for boards they only
 * follow. Unknown ownership allows none of them: guessing "followed" would offer
 * to unfollow the climber's own wall.
 */
function ownershipAllows(item: DiscoveryBoardItem, action: 'edit' | 'unfollow' | 'delete'): boolean {
  if (item.isViewerOwner === undefined) return false;
  return item.isViewerOwner === (action !== 'unfollow');
}

/** The board type the Near you list is narrowed to, and the layout it was set in. */
type NearbyTypeFilter = { boardType: BoardName; inFirstBoardChoice: boolean };

export default function BoardSelection() {
  const { isAuthenticated, refreshAuthState } = useAuth();
  const bottomChrome = useBottomChromeMetrics();
  const router = useRouter();
  const { returnTo, source, firstBoard } = useLocalSearchParams<{
    returnTo?: string;
    source?: string;
    firstBoard?: string;
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
  // The drill-in reuses the manage screen's own title, so the two can never drift.
  const { t: tCommon } = useTranslation('common');
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { brandColors, systemColors } = useTheme();

  // Clear the bottom tab bar and whichever queue controls are actually visible.
  const scrollBottomPadding = bottomChrome.scrollBottomPadding;

  const { data: activeBoard, isError: boardRestoreFailed } = useActiveBoard();
  const trackBoardSelection = useBoardPickerAnalytics({
    activeBoard,
    restoreFailed: boardRestoreFailed,
    returnTo: boardReturnTo,
    fromOnboarding,
    fromNoBoard,
  });
  const clearActiveBoard = useClearActiveBoardIfCurrentGeneration();
  const { clearSession } = useQueueActions();
  const deleteBoard = useDeleteBoard();
  const unfollowBoard = useUnfollowBoard();
  // `useMutation` returns a fresh object literal on every render, so depending on
  // the mutation objects would rebuild the action handler — and with it the
  // carousel's `renderItem` and every card's memo — on every commit.
  // `mutateAsync` is bound once by the MutationObserver, so it is the stable half
  // to close over.
  const deleteBoardAsync = deleteBoard.mutateAsync;
  const unfollowBoardAsync = unfollowBoard.mutateAsync;

  // Who is looking, so a card can tell your own wall from a gym you follow.
  // Deliberately NOT a gate: unlike /boards/manage, a missing id must never stop
  // you switching boards. It only takes Edit, Unfollow and Delete out of the
  // card menu — degraded, never blocked.
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { userId: storedUserId } = useStoredUserId(isAuthenticated && !profile?.id);
  const currentUserId = profile?.id ?? storedUserId;

  const [detailBoard, setDetailBoard] = useState<UserBoard | null>(null);
  const detailPickSource = useRef<BoardPickSource>('your_boards');
  const closeBoardDetails = useCallback(() => setDetailBoard(null), []);
  useEffect(() => {
    if (!isAuthenticated) closeBoardDetails();
  }, [isAuthenticated, closeBoardDetails]);

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
  const chooseFirstBoardPath = useFirstBoardPickerTracking(firstBoardChoiceEntry);

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

  // The In range slot: what the phone hears over Bluetooth, scanned by itself
  // on open unless the remote switch says to wait for a tap. Only while this
  // screen is on top and showing the online layout: the offline list and the
  // error state have no slot to fill.
  const isFocused = useIsFocused();
  const pickerAutoScanEnabled = usePickerAutoScanEnabled();
  const pickerScan = usePickerBoardScan({
    focused: isFocused && isAuthenticated && !isLocalOnly && !isError,
    autoStart: pickerAutoScanEnabled,
    knownBoards: myBoards,
  });
  const {
    phase: scanPhase,
    rows: scanRows,
    lookup: scanLookup,
    listenedLongEnough,
    start: startScan,
    stop: stopScan,
    retryLookup,
  } = pickerScan;
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

  // Both the "At a gym" choice and Near you offer Open Settings after a
  // denial, so a second tap has to be able to ask again: a climber coming back
  // from Settings gets their gyms from that tap, not from reopening the picker.
  const location = useDeviceLocation({ retryAfterDenial: true });
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
  const showAllNearby = useCallback(() => setNearbyFilter(null), []);
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

  const activateBoard = useActivateBoard({
    source: fromOnboarding ? 'onboarding' : undefined,
    returnTo: boardReturnTo,
    isLocalOnly,
    onBound: trackBoardSelection,
  });

  // Only the user's OWN boards carry a download state.
  const boardOfflineState = useBoardOfflineState();
  // The translated word a spray-wall row leads with. One object for every list
  // on this screen, so none of their memos churn.
  const labelOptions = useSprayLabelOptions();

  const myBoardItems = useMemo(
    // The server now orders these: pinned first, then by when you last opened
    // the board, then never-opened by when you added it (#4884). All this adds
    // is the board you're on, which the server cannot know — it lives in
    // AsyncStorage on this device. `currentUserId` stamps `isViewerOwner` once
    // per list build so no row ever scans back into `myBoards` for it.
    () =>
      userBoardsToItems(hoistActiveBoard(myBoards, activeBoard?.uuid), {
        activeUuid: activeBoard?.uuid,
        offlineStateFor: boardOfflineState,
        currentUserId,
        pinnedOverrides,
        labelOptions,
        importStatusStale,
      }),
    [myBoards, activeBoard?.uuid, boardOfflineState, currentUserId, pinnedOverrides, labelOptions, importStatusStale],
  );
  const nearbyItems = useMemo(
    () =>
      userBoardsToItems(
        // Also filtered here: while a newly filtered search loads, the query
        // keeps showing the previous, unfiltered list.
        nearbyBoardType
          ? (nearby?.boards ?? []).filter((board) => board.boardType === nearbyBoardType)
          : (nearby?.boards ?? []),
        { activeUuid: activeBoard?.uuid, labelOptions },
      ),
    [nearby?.boards, nearbyBoardType, activeBoard?.uuid, labelOptions],
  );
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

  // Every pick on this screen: a card, a row in range, a wall at the gym, the
  // detail sheet's Climb here. The scan ends first, so a pick never leaves the
  // radio running (the bind may connect next, and a phone holding a board link
  // must not scan). An unfinished wall opens its import instead of binding,
  // and a board being edited, unfollowed or deleted is not picked at all. A
  // held box goes too, unless this is the Near you pick it was held for
  // (`nearbyPickNamesHeldBox`).
  const pickBoard = useCallback(
    (board: UserBoard, pickSource: BoardPickSource) => {
      if (boardActionsInFlight.current.has(board.uuid)) return;
      const namesHeldBox =
        pickSource === 'nearby' &&
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
      void activateBoard(board, { pickSource });
    },
    [nearbyBoardType, dropHeldBox, stopScan, unfinishedWallUuids, router, activateBoard],
  );

  // myBoards / nearby items carry the original UserBoard via uuid; look it up to
  // activate. `pickSource` is the section the card sits in, not the list the
  // lookup happened to hit: a board you follow can also be Near you, and the
  // event should say where you tapped.
  const activateItem = useCallback(
    (item: DiscoveryBoardItem, pickSource: BoardPickSource) => {
      // A no-op, not a toast: the card's own tap haptic has already answered.
      if (boardActionsInFlight.current.has(item.key)) return;
      const board =
        myBoards.find((b) => b.uuid === item.key) ??
        (nearby?.boards ?? []).find((b) => b.uuid === item.key) ??
        // Offline rows come from the persisted snapshots, which aren't in either
        // network list — without this an offline tap is dead.
        offlineRows.find((b) => b.uuid === item.key);
      if (board) {
        pickBoard(board, pickSource);
      } else {
        // The item's UserBoard should always be in one of the lists it came
        // from; if a refetch dropped it between render and tap, give feedback
        // rather than a dead tap.
        showToast(t('mobile.boardSwitchError'), 'error');
      }
    },
    [myBoards, nearby?.boards, offlineRows, pickBoard, showToast, t],
  );
  const onSelectMyBoard = useCallback((item: DiscoveryBoardItem) => activateItem(item, 'your_boards'), [activateItem]);
  const onSelectNearbyBoard = useCallback((item: DiscoveryBoardItem) => activateItem(item, 'nearby'), [activateItem]);
  const onSelectOfflineBoard = useCallback((item: DiscoveryBoardItem) => activateItem(item, 'offline'), [activateItem]);
  const detailBoardsByUuid = useMemo(() => {
    const boards = new Map<string, UserBoard>();
    for (const board of myBoards) boards.set(board.uuid, board);
    for (const board of nearby?.boards ?? []) boards.set(board.uuid, board);
    if (activeBoard) boards.set(activeBoard.uuid, activeBoard);
    return boards;
  }, [myBoards, nearby?.boards, activeBoard]);
  const openBoardDetails = useCallback(
    (item: DiscoveryBoardItem, pickSource: BoardPickSource) => {
      const board = detailBoardsByUuid.get(item.key);
      if (!board) return;
      detailPickSource.current = pickSource;
      setDetailBoard(board);
    },
    [detailBoardsByUuid],
  );
  const onMyBoardDetails = useCallback(
    (item: DiscoveryBoardItem) => openBoardDetails(item, 'your_boards'),
    [openBoardDetails],
  );
  const onNearbyBoardDetails = useCallback(
    (item: DiscoveryBoardItem) => openBoardDetails(item, 'nearby'),
    [openBoardDetails],
  );
  // Onboarding draws plain cards in both carousels: no ⋯ and no hold. The first
  // screen a new account sees carries the choice of board and nothing else, the
  // same rule the onboarding board step follows. "Where do you climb?" is the
  // same moment for a climber with no boards yet (Climbs' empty state), and its
  // "At a gym" answer shows the Near you carousel, so it draws plain cards too.
  const showCardMenus = !fromOnboarding && !showFirstBoardChoice;
  // Near you's card menu: the two rows NEARBY_MENU_CAPABILITIES offers.
  const onNearbyMenuAction = useCallback(
    (item: DiscoveryBoardItem, action: BoardCardMenuAction, via: BoardCardMenuVia) => {
      if (!showCardMenus || (action !== 'climb_here' && action !== 'details')) return;
      if (action === 'climb_here' && boardActionsInFlight.current.has(item.key)) return;
      trackBoardCardAction({ action, via, section: 'nearby' });
      if (action === 'climb_here') onSelectNearbyBoard(item);
      else onNearbyBoardDetails(item);
    },
    [showCardMenus, onSelectNearbyBoard, onNearbyBoardDetails],
  );
  const onActiveBoardDetails = useCallback(() => {
    if (activeBoard) setDetailBoard(activeBoard);
  }, [activeBoard]);
  const onSetActiveFromDetails = useCallback(
    (board: UserBoard) => {
      closeBoardDetails();
      // `pickBoard` skips a board whose edit, unfollow or delete is running.
      pickBoard(board, detailPickSource.current);
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
  const nearbyTrailing = nearbyBoardType ? (
    <PressableSurface onPress={showAllNearby} accessibilityRole="button" style={styles.sectionAction}>
      <Text variant="body" color={brandColors.primary}>
        {t('mobile.discovery.nearbyShowAll')}
      </Text>
    </PressableSurface>
  ) : showFirstBoardChoice ? null : (
    <PressableSurface onPress={openGymMap} accessibilityRole="button" style={styles.sectionAction}>
      <Text variant="body" color={brandColors.primary}>
        {t('mobile.discovery.nearbyMap')}
      </Text>
    </PressableSurface>
  );
  const nearbySection =
    nearbyItems.length > 0 ? (
      <Section title={nearbyTitle} trailing={nearbyTrailing}>
        <BoardCarousel
          items={nearbyItems}
          onSelect={onSelectNearbyBoard}
          menuCapabilities={showCardMenus ? NEARBY_MENU_CAPABILITIES : undefined}
          onMenuAction={showCardMenus ? onNearbyMenuAction : undefined}
        />
      </Section>
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
    async (item: DiscoveryBoardItem, action: 'edit' | 'unfollow' | 'delete') => {
      if (boardActionsInFlight.current.has(item.key)) return;
      boardActionsInFlight.current.add(item.key);
      try {
        const board = myBoards.find((candidate) => candidate.uuid === item.key);
        if (!board) {
          showToast(t('mobile.boardSwitchError'), 'error');
          return;
        }
        // Unreachable from the UI — the menu offers none of these on a board whose
        // ownership did not resolve — but bail explicitly rather than let a
        // coercion collapse "unknown" into "followed" and unfollow the user's own
        // wall. Edit and delete are owner-only, and unfollow is for boards you do
        // not own: a mismatch is a stale row, so it runs nothing.
        if (!ownershipAllows(item, action)) return;
        if (action === 'edit') {
          router.push({ pathname: '/boards/edit', params: { boardUuid: board.uuid } });
          return;
        }
        const wasActive = activeBoard?.uuid === board.uuid;
        // Capture at action time: a render-time value can miss a queued board write.
        const activeBoardGeneration = getActiveBoardWriteGeneration();
        if (action === 'delete') {
          const confirmed = await confirm({
            title: board.boardType === 'spray' ? t('mobile.manage.deleteWallTitle') : t('mobile.manage.deleteTitle'),
            message:
              board.boardType === 'spray'
                ? t('mobile.manage.deleteWallMessage', { name: board.name })
                : t('mobile.manage.deleteMessage', { name: board.name }),
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
        // where it also clears the selection out from under a live session.
        if (wasActive) {
          const confirmed = await confirm({
            title: t('mobile.manage.unfollowTitle'),
            message: t('mobile.manage.unfollowMessage', { name: board.name }),
            confirmLabel: t('mobile.manage.unfollowConfirm'),
            cancelLabel: t('mobile.manage.cancel'),
            destructive: true,
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
      router,
      activeBoard?.uuid,
      confirm,
      deleteBoardAsync,
      unfollowBoardAsync,
      clearActiveBoard,
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

  // Gates Edit, Unfollow and Delete in every card's menu. Also off with no
  // boards, with no resolvable identity, and offline — where every action behind
  // it is a network mutation. Onboarding has no card menu at all (below).
  const canEditBoards = myBoardItems.length > 0 && currentUserId !== undefined && !isLocalOnly && !fromOnboarding;
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
    }),
    [canPinBoards, offlineDownloadsEnabled, canEditBoards],
  );

  // Every row of a "Your boards" card menu lands here, from the ⋯, the hold or
  // a screen-reader action. The menu only offers what the capabilities above
  // allow; the gates are checked again here, so a row drawn before the climber
  // went offline cannot run a mutation that would fail. A refused row runs
  // nothing and is not counted.
  const onMyBoardMenuAction = useCallback(
    (item: DiscoveryBoardItem, action: BoardCardMenuAction, via: BoardCardMenuVia) => {
      if (!showCardMenus) return;
      switch (action) {
        case 'climb_here':
          // The board is being edited, unfollowed or deleted: see boardActionsInFlight.
          if (boardActionsInFlight.current.has(item.key)) return;
          trackBoardCardAction({ action, via, section: 'your_boards' });
          onSelectMyBoard(item);
          return;
        case 'pin':
        case 'unpin':
          if (!canPinBoards) return;
          trackBoardCardAction({ action, via, section: 'your_boards' });
          setBoardPinned(item, action === 'pin');
          return;
        case 'download':
          if (!offlineDownloadsEnabled) return;
          trackBoardCardAction({ action, via, section: 'your_boards' });
          onDownloadMyBoard(item);
          return;
        case 'details':
          trackBoardCardAction({ action, via, section: 'your_boards' });
          onMyBoardDetails(item);
          return;
        case 'edit':
        case 'unfollow':
        case 'delete':
          if (!canEditBoards || !ownershipAllows(item, action) || boardActionsInFlight.current.has(item.key)) return;
          trackBoardCardAction({ action, via, section: 'your_boards' });
          void runMyBoardAction(item, action);
          return;
      }
    },
    [
      showCardMenus,
      onSelectMyBoard,
      canPinBoards,
      setBoardPinned,
      offlineDownloadsEnabled,
      onDownloadMyBoard,
      onMyBoardDetails,
      canEditBoards,
      runMyBoardAction,
    ],
  );

  const onManageBoards = useCallback(() => {
    router.push('/boards/manage');
  }, [router]);
  // The full vertical list with the per-board download console. With the drawer's
  // second board row gone this and OfflineSpotlightCard are the only routes to
  // it, so it renders on the offline branch too: it is navigation, not a
  // mutation, and the manage screen has its own offline list.
  const manageBoardsRow = (
    <PressableSurface onPress={onManageBoards} accessibilityRole="button" style={styles.manageRow}>
      <Text variant="body" color={brandColors.primary} style={styles.manageRowLabel}>
        {tCommon('myBoards.title')}
      </Text>
      <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
    </PressableSurface>
  );

  const myBoardsSection =
    myBoardItems.length > 0 ? (
      <Section title={t('mobile.discovery.yourBoardsTitle')}>
        <BoardCarousel
          items={myBoardItems}
          onSelect={onSelectMyBoard}
          menuCapabilities={showCardMenus ? myBoardMenuCapabilities : undefined}
          onMenuAction={showCardMenus ? onMyBoardMenuAction : undefined}
        />
        {/* Inside the section because that is what it drills into; gone with the
            section when there are no boards to manage or download. */}
        {manageBoardsRow}
      </Section>
    ) : null;

  const requestLocation = location.request;
  const requestLocationIfAllowed = location.requestIfAllowed;
  const refreshLocation = location.refresh;
  const locationGranted = location.status === 'granted';
  // Onboarding handoff: pre-resolve location on mount so Near you is already
  // loading instead of waiting for a tap the user might not discover. Not in
  // first-board mode: there the question comes with its reason, on the "At a
  // gym" tap, instead of as the first thing a newcomer sees.
  useEffect(() => {
    if (fromOnboarding && !firstBoardMode) void requestLocation();
  }, [fromOnboarding, firstBoardMode, requestLocation]);
  // Everyone else who already allowed location gets Near you on open, with no
  // prompt. The rest see "Show boards near you", which asks.
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

  // Every way to add a board: the + menu, the empty state and "Where do you
  // climb?". `source` rides along so a board made on the route closes out
  // onboarding exactly like a pick here: creating a board is how a home-wall
  // owner binds their first one, and the wall wizard binds a Spraywall.
  const openAddRoute = useCallback(
    (kind: BoardPickerAddKind, surface: BoardPickerAddSurface) => {
      trackBoardPickerAddSelected({ kind, surface });
      router.push(addBoardRoute(kind, { returnTo: boardReturnTo, source, fromPicker: true }));
    },
    [router, boardReturnTo, source],
  );
  const onAddFromMenu = useCallback((kind: BoardPickerAddKind) => openAddRoute(kind, 'picker'), [openAddRoute]);
  const onEmptySetUpBoard = useCallback(() => openAddRoute('board', 'empty_state'), [openAddRoute]);
  const onEmptyAddSprayWall = useCallback(() => openAddRoute('spraywall', 'empty_state'), [openAddRoute]);

  // The + in the top bar. Online and signed in only: every way behind it needs
  // a connection and an account. Not under "Where do you climb?", whose three
  // cards are those same choices.
  const navigation = useNavigation();
  const canAddBoards = isAuthenticated && !isLocalOnly && !isError && !showFirstBoardChoice;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: canAddBoards ? () => <AddBoardMenu onSelect={onAddFromMenu} /> : undefined,
    });
  }, [navigation, canAddBoards, onAddFromMenu]);

  // First-board mode's answers. Each one is the existing flow behind it, plus
  // the choice event; see FirstBoardChoice.
  const [gymChosen, setGymChosen] = useState(false);
  const onFirstBoardGym = useCallback(() => {
    chooseFirstBoardPath('gym');
    setNearbyFilter(null);
    setGymChosen(true);
    searchNearby();
  }, [chooseFirstBoardPath, searchNearby]);
  // The builder opens preset with a layout and size, so a home-wall owner's
  // Save works from the first frame instead of after finding the layout chip.
  const onFirstBoardOwn = useCallback(() => {
    chooseFirstBoardPath('own');
    trackBoardPickerAddSelected({ kind: 'board', surface: 'first_run' });
    router.push(addBoardRoute('board', { returnTo: boardReturnTo, source, preset: BUILDER_PRESET_PARAM_VALUE }));
  }, [chooseFirstBoardPath, router, boardReturnTo, source]);
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

  // The In range slot. A tap anywhere in it is the first-board "scan" path,
  // which before the slot was the "Scan for the board in front of me" link.
  const onInRangeStart = useCallback(() => {
    chooseFirstBoardPath('scan');
    startScan();
  }, [chooseFirstBoardPath, startScan]);
  const inRange = useMemo(
    () => inRangeView(scanPhase, scanRows, { lookup: scanLookup }),
    [scanPhase, scanRows, scanLookup],
  );
  const inRangeRowsByKey = useMemo(() => {
    const rowsByKey = new Map<string, InRangeBoardRow>();
    for (const row of scanRows) if (row.kind === 'board') rowsByKey.set(row.key, row);
    return rowsByKey;
  }, [scanRows]);
  const inRangeDisplay = useMemo<InRangeView<DiscoveryBoardItem>>(
    () => ({
      scanning: inRange.scanning,
      content: mapInRangeBoards(inRange.content, (rows) =>
        boardRowsToItems(rows, { activeUuid: activeBoard?.uuid, labelOptions }),
      ),
    }),
    [inRange, activeBoard?.uuid, labelOptions],
  );
  const onPickInRangeBoard = useCallback(
    (item: DiscoveryBoardItem) => {
      const row = inRangeRowsByKey.get(item.key);
      if (!row) return;
      chooseFirstBoardPath('scan');
      // A box held from an earlier tap on a row it couldn't name is not this
      // board: `pickBoard` drops it for every pick but the Near you one.
      pickBoard(row.board, 'bluetooth');
    },
    [inRangeRowsByKey, chooseFirstBoardPath, pickBoard],
  );
  // The three ways forward for a board it heard but couldn't name (a MoonBoard,
  // a box with no serial, a serial nobody has saved). Each one ends the scan and
  // holds the box so the board the climber binds next, here or on the route it
  // opens, names it from then on (pending-board-recognition.ts). Only when one
  // box stands behind the row, and the scan listened long enough for "one" to
  // mean one: read before `stop()`, which ends the listening. The bind keeps
  // `source`, so it still closes out first-run. Location is asked on the tap,
  // never when the scan finds the board. The row acted on last is the box the
  // climber is at, so a row with no single box drops an older hold. Returns
  // whether it holds a box.
  const startUnnamedRowAction = useCallback(
    (row: UnnamedInRangeRow): boolean => {
      const soleBoxHeardLongEnough = listenedLongEnough();
      stopScan();
      chooseFirstBoardPath('scan');
      dropHeldBox();
      if (row.kind === 'unknown_setup' || !row.deviceId || !soleBoxHeardLongEnough) return false;
      setPendingBoardRecognition({ deviceId: row.deviceId, boardType: row.boardType });
      return true;
    },
    [listenedLongEnough, stopScan, chooseFirstBoardPath, dropHeldBox],
  );
  // "Use my location": the boards near the climber, of that type only. In
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
  // "Search gyms": the gym map, filtered to that type.
  const onInRangeSearchGyms = useCallback(
    (row: UnnamedInRangeRow) => {
      startUnnamedRowAction(row);
      const gymMap = addBoardRoute('gym_map', { returnTo: boardReturnTo, source, fromPicker: true });
      router.push({ pathname: gymMap.pathname, params: { ...gymMap.params, boardType: row.boardType } });
    },
    [startUnnamedRowAction, router, boardReturnTo, source],
  );
  // "It's my own board": the builder, opened on that type with its preset.
  const onInRangeOwnBoard = useCallback(
    (row: UnnamedInRangeRow) => {
      startUnnamedRowAction(row);
      const builder = addBoardRoute('board', { returnTo: boardReturnTo, source, preset: BUILDER_PRESET_PARAM_VALUE });
      router.push({ pathname: builder.pathname, params: { ...builder.params, presetBoardType: row.boardType } });
    },
    [startUnnamedRowAction, router, boardReturnTo, source],
  );
  const onOpenBluetoothSettings = useCallback(() => {
    chooseFirstBoardPath('scan');
    void openAppSettings();
  }, [chooseFirstBoardPath]);
  const onInRangeRetryLookup = useCallback(() => {
    chooseFirstBoardPath('scan');
    retryLookup();
  }, [chooseFirstBoardPath, retryLookup]);
  // Android can withhold what a scan heard; the nothing-heard line then says
  // why and offers the fix, which rescans when it works.
  const locationHint = useInRangeLocationHint(inRange.content.kind === 'none_in_range', startScan);
  const inRangeSection = (
    <InRangeSection
      view={inRangeDisplay}
      BoardArt={DiscoveryBoardArt}
      onStart={onInRangeStart}
      onOpenSettings={onOpenBluetoothSettings}
      onRetryLookup={onInRangeRetryLookup}
      onPickBoard={onPickInRangeBoard}
      onUseMyLocation={onInRangeUseMyLocation}
      onSearchGyms={onInRangeSearchGyms}
      onOwnBoard={onInRangeOwnBoard}
      locationHint={locationHint}
    />
  );

  // "Also at {gym}": the other walls at the in-range board's gym, else at the
  // active board's. A tap binds that wall; nothing connects without one.
  const alsoAtAnchor = useMemo(() => alsoAtGymAnchor(inRange.content, activeBoard), [inRange.content, activeBoard]);
  const onSelectGymWall = useCallback((board: UserBoard) => pickBoard(board, 'gym_walls'), [pickBoard]);
  const alsoAtGymSection = alsoAtAnchor ? (
    <AlsoAtGymSection anchor={alsoAtAnchor} onSelectBoard={onSelectGymWall} />
  ) : null;

  const onOpenLocationSettings = useCallback(() => {
    void openAppSettings();
  }, []);
  const onRetryNearby = useCallback(() => {
    void refetchNearby();
  }, [refetchNearby]);
  // One reading of the nearby search for both layouts. The "At a gym" choice
  // counts as asked once it is tapped; Near you once location has been asked
  // for at all (on open when already allowed, a tap, or the onboarding preload).
  const nearbySearch = firstBoardGymState({
    chosen: showFirstBoardChoice ? gymChosen : location.status !== 'idle',
    locationStatus: location.status,
    // Any request in flight, not only the first load: a retry after an error
    // keeps the query in `error` while it runs, and should read as searching.
    nearbyLoading: isNearbySearching,
    nearbyFailed: isNearbyError,
    nearbyCount: nearbyItems.length,
  });

  // Near you in the ordinary layout: the boards it found, or, before location
  // was ever asked, one row that asks; otherwise what the search came to
  // (looking, nothing within 20 km, a failed lookup, location off).
  const nearbyPanel = nearbySection ?? (
    <Section title={nearbyTitle} trailing={nearbyTrailing}>
      {nearbySearch === 'idle' ? (
        <PressableSurface onPress={searchNearby} accessibilityRole="button" style={styles.showNearbyRow}>
          <Icon name="location" size={17} color={brandColors.primary} />
          <Text variant="body" color={brandColors.primary}>
            {t('mobile.discovery.showNearby')}
          </Text>
        </PressableSurface>
      ) : (
        <NearbySearchStatus
          state={nearbySearch}
          onFindGymOnMap={openGymMap}
          onOpenSettings={onOpenLocationSettings}
          onRetryNearby={onRetryNearby}
          boardType={nearbyBoardType}
          onShowAll={showAllNearby}
        />
      )}
    </Section>
  );

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
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('mobile.signInSubtitle')}
        </Text>
        <Button title={t('mobile.signInCta')} onPress={() => router.push('/auth/login')} style={styles.stateButton} />
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
        <Text variant="subheadline" style={styles.offlineNotice}>
          {noticeKey === 'pickerNoticeOfflineMode'
            ? t('mobile.offline.pickerNoticeOfflineMode')
            : noticeKey === 'pickerNoticeUnreachable'
              ? t('mobile.offline.pickerNoticeUnreachable')
              : t('mobile.offline.pickerNotice')}
        </Text>
        {offlineItems.length > 0 ? (
          <Section title={t('mobile.discovery.yourBoardsTitle')}>
            <BoardCarousel items={offlineItems} onSelect={onSelectOfflineBoard} />
            {manageBoardsRow}
          </Section>
        ) : (
          <View style={styles.emptyState}>
            <Text variant="headline" style={styles.emptyTitle}>
              {t('mobile.offline.pickerEmptyTitle')}
            </Text>
            <Text variant="subheadline" style={styles.emptySubtitle}>
              {t('mobile.offline.pickerEmptyBody')}
            </Text>
            {/* Only the lying-connection case gets a retry — offline it would just
                pause, and the user already knows they have no signal. */}
            {isError ? (
              <Button
                title={t('mobile.errorRetry')}
                variant="outlined"
                loading={isRefetching}
                onPress={() => void refetch()}
                style={styles.emptyCta}
              />
            ) : null}
          </View>
        )}
        {/* Outside the empty state, because `offlineBoardRows` always offers the
            active board: the empty state only happens when there is NO board to
            suggest, so a CTA anchored inside it could never render. Here it sits
            under the carousel the un-downloaded board is showing in.

            Arm-only, and it takes itself away the moment the scope leaves 'off'
            — which is why the queued line has to replace it rather than let the
            screen fall silent on a board the user just asked for. */}
        {offlineCatalog === 'queued' ? (
          <Text variant="subheadline" style={styles.offlineNotice}>
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
      alsoAtGymSection={alsoAtGymSection}
      myBoardsSection={myBoardsSection}
      nearbySection={nearbyPanel}
      hasBoards={myBoardItems.length > 0}
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
        />
      }
      overlays={
        <BoardDetailSheet
          board={detailBoard}
          visible={detailBoard !== null}
          onClose={closeBoardDetails}
          onSetActive={onSetActiveFromDetails}
        />
      }
    />
  );
}
const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    paddingVertical: spacing[4],
    gap: spacing[5],
  },
  offlineNotice: {
    paddingHorizontal: spacing[4],
    opacity: 0.7,
  },
  sectionAction: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
  manageRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
  },
  manageRowLabel: {
    flex: 1,
  },
  showNearbyRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
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
    opacity: 0.6,
  },
  stateButton: {
    marginTop: spacing[4],
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[8],
  },
  emptyTitle: {
    opacity: 0.6,
  },
  emptySubtitle: {
    marginTop: spacing[2],
    opacity: 0.4,
    textAlign: 'center',
  },
  emptyCta: {
    marginTop: spacing[5],
  },
});
