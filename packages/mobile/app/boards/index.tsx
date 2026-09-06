import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ScrollView, StyleSheet, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@expo/ui/community/bottom-sheet';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  useMyBoards,
  usePopularBoardConfigs,
  useNearbyBoards,
  useProfile,
  useDeleteBoard,
  useUnfollowBoard,
  usePinBoard,
} from '../../src/lib/graphql/hooks';
import { useActiveBoard, useClearActiveBoard } from '../../src/lib/graphql/use-active-board';
import { useDeviceLocation } from '../../src/lib/use-device-location';
import { useAuth } from '../../src/providers/auth-provider';
import { useToast } from '../../src/providers/toast-provider';
import { useConfirm } from '../../src/providers/dialog-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { BoardCarousel } from '../../src/components/board-discovery/BoardCarousel';
import { BoardModeCard, type ModeCardState } from '../../src/components/board-discovery/BoardModeCard';
import { BluetoothQuickstartSheet } from '../../src/components/board-discovery/BluetoothQuickstartSheet';
import { userBoardsToItems, popularConfigToItem } from '../../src/components/board-discovery/board-items';
import {
  boardCardAction,
  hoistActiveBoard,
  type BoardCardAction,
} from '../../src/components/board-discovery/board-card-actions';
import { offlineBoardRows } from '../../src/components/board-discovery/offline-board-items';
import type { DiscoveryBoardItem } from '../../src/components/board-discovery/BoardDiscoveryCard';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useConnectivity } from '../../src/lib/connectivity/use-connectivity';
import { deriveLocalOnly, pickerNoticeKey } from '../../src/lib/boards/local-only';
import { useStoredUserId } from '../../src/hooks/use-current-user-id';
import { forgetOfflineBoard, offlineBoardKeyForBoard, useOfflineBoards } from '../../src/settings';
import { useRememberDownloadedBoards } from '../../src/offline/use-remember-downloaded-boards';
import { useDownloadedScopeKeys } from '../../src/offline/use-downloaded-scope-keys';
import { useConfirmBoardDownload } from '../../src/offline/use-confirm-board-download';
import { useOfflineCatalogState } from '../../src/offline/use-offline-catalog-state';
import { useOfflineDownloadsEnabled } from '../../src/providers/feature-flags-provider';
import { useBoardOfflineState } from '../../src/components/board-discovery/use-board-offline-state';
import { OfflineCatalogCta } from '../../src/components/offline/OfflineCatalogCta';
import { trackNudgeAccepted } from '../../src/lib/offline-nudges/nudge-analytics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { useActivateBoard } from '../../src/lib/boards/use-activate-board';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { spacing } from '../../src/theme/tokens';

// Module-level so an absent board list keeps a stable identity: offline
// `boardConnection` is always undefined, and a fresh `[]` per render would
// recompute the offline rows on every commit.
const EMPTY_BOARDS: UserBoard[] = [];

export default function BoardSelection() {
  const { isAuthenticated, refreshAuthState } = useAuth();
  const bottomChrome = useBottomChromeMetrics();
  const router = useRouter();
  const { returnTo, source } = useLocalSearchParams<{ returnTo?: string; source?: string }>();
  const boardReturnTo = resolveBoardReturnTo(returnTo);
  // Arriving from the first-run framing screen: this is the activation flow, so
  // pre-resolve location, show the framing header, and tag the board-bind.
  const fromOnboarding = source === 'onboarding';
  const { t } = useTranslation('boards');
  // The drill-in reuses the manage screen's own title, so the two can never drift.
  const { t: tCommon } = useTranslation('common');
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { brandColors, systemColors } = useTheme();

  // Clear the bottom tab bar and whichever queue controls are actually visible.
  const scrollBottomPadding = bottomChrome.scrollBottomPadding;

  const { data: activeBoard } = useActiveBoard();
  const clearActiveBoard = useClearActiveBoard();
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
  // you switching boards. It only removes the Edit control and the per-card
  // ownership badge — degraded, never blocked.
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { userId: storedUserId } = useStoredUserId(isAuthenticated && !profile?.id);
  const currentUserId = profile?.id ?? storedUserId;

  // iOS-style edit mode for the "Your boards" carousel. Local state inside a
  // `presentation: 'modal'` route, so it cannot survive a dismiss: every one of
  // the twelve places that open this picker gets it switched off.
  const [isEditingBoards, setIsEditingBoards] = useState(false);

  // Pins the climber toggled since this modal opened, so the glyph flips under
  // the finger without waiting for a refetch. Deliberately does NOT reorder: the
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

  const {
    data: boardConnection,
    isLoading: isMyBoardsLoading,
    isError,
    refetch,
    isRefetching,
  } = useMyBoards(undefined, { enabled: isAuthenticated });
  const myBoards = boardConnection?.boards ?? EMPTY_BOARDS;
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

  const { data: popular } = usePopularBoardConfigs({ limit: 12 });

  const location = useDeviceLocation();
  // 20 km, not the hook's 1 km default — "nearby" should reach across town
  // (a gym a couple of streets away must still surface).
  const { data: nearby, isLoading: isNearbyLoading } = useNearbyBoards(location.coords, 20);

  const bluetoothSheetRef = useRef<BottomSheet>(null);
  // State (not a ref) so the quickstart sheet re-renders and kicks off its scan
  // when opened, and tears it down when closed.
  const [bluetoothActive, setBluetoothActive] = useState(false);

  // See the boards index error path: a hard 401 clears tokens but doesn't flip
  // isAuthenticated, so re-validate on error to escape a stuck retry loop.
  useEffect(() => {
    if (isError) void refreshAuthState();
  }, [isError, refreshAuthState]);

  const activateBoard = useActivateBoard({
    source: fromOnboarding ? 'onboarding' : undefined,
    returnTo: boardReturnTo,
    isLocalOnly,
  });

  // Only the user's OWN boards carry a download state.
  const boardOfflineState = useBoardOfflineState();
  const myBoardItems = useMemo(
    // The server now orders these: pinned first, then by when you last opened
    // the board, then never-opened by when you added it (#4884). All this adds
    // is the board you're on, which the server cannot know — it lives in
    // AsyncStorage on this device. `currentUserId` stamps `isViewerOwner` once
    // per list build so no row ever scans back into `myBoards` for it.
    () =>
      userBoardsToItems(
        hoistActiveBoard(myBoards, activeBoard?.uuid),
        activeBoard?.uuid,
        boardOfflineState,
        currentUserId,
        pinnedOverrides,
      ),
    [myBoards, activeBoard?.uuid, boardOfflineState, currentUserId, pinnedOverrides],
  );
  const nearbyItems = useMemo(
    () => userBoardsToItems(nearby?.boards ?? [], activeBoard?.uuid),
    [nearby?.boards, activeBoard?.uuid],
  );
  const offlineItems = useMemo(
    () => userBoardsToItems(offlineRows, activeBoard?.uuid),
    [offlineRows, activeBoard?.uuid],
  );
  const popularItems = useMemo(
    () => (popular?.configs ?? []).map(popularConfigToItem).filter((item): item is DiscoveryBoardItem => item !== null),
    [popular?.configs],
  );

  // myBoards / nearby items carry the original UserBoard via uuid; look it up to
  // activate. Popular/custom items have no UserBoard, so they go through the
  // custom sheet (CREATE_BOARD) — see onSelectPopular.
  const onSelectMyBoard = useCallback(
    (item: DiscoveryBoardItem) => {
      const board =
        myBoards.find((b) => b.uuid === item.key) ??
        (nearby?.boards ?? []).find((b) => b.uuid === item.key) ??
        // Offline rows come from the persisted snapshots, which aren't in either
        // network list — without this an offline tap is dead.
        offlineRows.find((b) => b.uuid === item.key);
      if (board) {
        void activateBoard(board);
      } else {
        // The item's UserBoard should always be in one of the lists it came
        // from; if a refetch dropped it between render and tap, give feedback
        // rather than a dead tap.
        showToast(t('mobile.boardSwitchError'), 'error');
      }
    },
    [myBoards, nearby?.boards, offlineRows, activateBoard, showToast, t],
  );
  const nearbySection =
    nearbyItems.length > 0 ? (
      <Section title={t('mobile.discovery.nearbyTitle')}>
        <BoardCarousel items={nearbyItems} onSelect={onSelectMyBoard} />
      </Section>
    ) : null;
  // Tap-to-download, scoped to boards the user owns or follows. Gated on the
  // engine's platform gate so the glyph never renders in the Expo browser app
  // (offline-downloads-enabled.web.ts hard-returns false) or with offline off.
  const onDownloadMyBoard = useCallback(
    (item: DiscoveryBoardItem) => {
      const board = myBoards.find((candidate) => candidate.uuid === item.key);
      if (!board) return;
      void confirmAndDownload(board).then((confirmed) => {
        if (!confirmed) return;
        // This surface deliberately has no impression event — a card scrolling
        // past in a carousel is not a suggestion the way a prompt is — so the
        // accept is what joins the glyph to the download funnel. Without it the
        // widest-reach discovery surface ships blind, which is the failure
        // epic #4319 exists to fix. Never arm-only: the glyph is online-only.
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
    [myBoards, confirmAndDownload, downloadedScopeKeys],
  );
  const downloadLabelFor = useCallback(
    (item: DiscoveryBoardItem) => t('mobile.offline.makeAvailableAria', { name: item.title }),
    [t],
  );

  // Ownership resolves off the flag the item already carries. `undefined` means
  // we could not tell, and an unknown board gets no slot at all rather than a
  // control offering to unfollow the user's own wall.
  const myBoardActionFor = useCallback(
    (item: DiscoveryBoardItem): BoardCardAction =>
      item.isViewerOwner === undefined
        ? null
        : boardCardAction({ isViewerOwner: item.isViewerOwner, isEditing: isEditingBoards }),
    [isEditingBoards],
  );
  const myBoardActionLabelFor = useCallback(
    (item: DiscoveryBoardItem) => {
      switch (myBoardActionFor(item)) {
        case 'edit':
          return t('mobile.manage.editAria', { name: item.title });
        case 'delete':
          return t('mobile.manage.deleteAria', { name: item.title });
        case 'unfollow':
          return t('mobile.manage.unfollowAria', { name: item.title });
        // No slot renders for a board whose ownership did not resolve, so there
        // is no action to label. Exhaustive rather than a fallthrough, so a
        // future action can't inherit the wrong string.
        case null:
          return '';
      }
    },
    [myBoardActionFor, t],
  );

  // One `find` per tap — the shape `onSelectMyBoard` already uses — never per row.
  const runMyBoardAction = useCallback(
    async (item: DiscoveryBoardItem) => {
      const board = myBoards.find((candidate) => candidate.uuid === item.key);
      if (!board) {
        showToast(t('mobile.boardSwitchError'), 'error');
        return;
      }
      // Unreachable from the UI — a board whose ownership did not resolve renders
      // no slot at all — but bail explicitly rather than let a coercion collapse
      // "unknown" into "followed" and offer to unfollow the user's own wall.
      if (item.isViewerOwner === undefined) return;
      const action = boardCardAction({ isViewerOwner: item.isViewerOwner, isEditing: isEditingBoards });
      if (action === 'edit') {
        router.push({ pathname: '/boards/edit', params: { boardUuid: board.uuid } });
        return;
      }
      const wasActive = activeBoard?.uuid === board.uuid;
      if (action === 'delete') {
        const confirmed = await confirm({
          title: t('mobile.manage.deleteTitle'),
          message: t('mobile.manage.deleteMessage', { name: board.name }),
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
          if (wasActive) await clearActiveBoard();
          // Leave edit mode after an irreversible removal: the carousel has just
          // reflowed under a finger that is still over a red button.
          setIsEditingBoards(false);
        } catch {
          showToast(t('mobile.manage.deleteError'), 'error');
        }
        return;
      }
      if (action === 'unfollow') {
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
          if (wasActive) await clearActiveBoard();
        } catch {
          showToast(t('mobile.manage.unfollowError'), 'error');
        }
      }
    },
    [
      myBoards,
      isEditingBoards,
      router,
      activeBoard?.uuid,
      confirm,
      deleteBoardAsync,
      unfollowBoardAsync,
      clearActiveBoard,
      showToast,
      t,
    ],
  );
  const onMyBoardAction = useCallback(
    (item: DiscoveryBoardItem) => {
      void runMyBoardAction(item);
    },
    [runMyBoardAction],
  );
  // Edit mode already disables the card body, but the handler guards it too: the
  // same `onSelect` also serves Near you and the offline rows.
  const onSelectMyBoardCard = useCallback(
    (item: DiscoveryBoardItem) => {
      if (isEditingBoards) return;
      onSelectMyBoard(item);
    },
    [isEditingBoards, onSelectMyBoard],
  );
  // Read straight off the mutations, so there is no second copy of "which board
  // is busy" to keep in sync.
  const pendingActionKey = deleteBoard.isPending
    ? (deleteBoard.variables ?? null)
    : unfollowBoard.isPending
      ? (unfollowBoard.variables ?? null)
      : null;

  const onTogglePin = useCallback(
    (item: DiscoveryBoardItem) => {
      const nextPinned = !item.isPinned;
      setPinnedOverrides((previous) => {
        const next = new Map(previous);
        next.set(item.key, nextPinned);
        return next;
      });
      pinBoardMutate({ boardUuid: item.key, pinned: nextPinned });
    },
    [pinBoardMutate],
  );

  const pinLabelFor = useCallback(
    (item: DiscoveryBoardItem) =>
      item.isPinned
        ? t('mobile.discovery.unpinAria', { name: item.title })
        : t('mobile.discovery.pinAria', { name: item.title }),
    [t],
  );

  // Gates the Edit/Done toggle AND the whole per-card action slot. Onboarding is
  // the reason the two share a predicate: the first screen a new account ever
  // sees must not carry a board action of any kind, and gating only the toggle
  // would have left the followed-board glyph live there. Also off with no boards,
  // with no resolvable identity, and offline — where every action behind it is a
  // network mutation.
  const canEditBoards = myBoardItems.length > 0 && currentUserId !== undefined && !isLocalOnly && !fromOnboarding;
  // Same family of gates as canEditBoards, minus the identity requirement: a pin
  // is the viewer's own state and does not depend on knowing who owns the board.
  // Offline is still out — the mutation could not reach the server — and so is
  // onboarding, whose first screen carries no board controls at all.
  const canPinBoards = !isLocalOnly && !fromOnboarding && isAuthenticated;
  useEffect(() => {
    if (isEditingBoards && !canEditBoards) setIsEditingBoards(false);
  }, [isEditingBoards, canEditBoards]);

  const onManageBoards = useCallback(() => {
    router.push('/boards/manage');
  }, [router]);
  // The full vertical list with the per-board download console. With the drawer's
  // second board row gone this and OfflineSpotlightCard are the only routes to
  // it, so it renders on the offline branch too: it is navigation, not a
  // mutation, and the manage screen has its own offline list.
  const manageBoardsRow = (
    <Pressable onPress={onManageBoards} accessibilityRole="button" style={styles.manageRow}>
      <Text variant="body" color={brandColors.primary} style={styles.manageRowLabel}>
        {tCommon('myBoards.title')}
      </Text>
      <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
    </Pressable>
  );

  const myBoardsSection =
    myBoardItems.length > 0 ? (
      <Section
        title={t('mobile.discovery.yourBoardsTitle')}
        trailing={
          canEditBoards ? (
            <Pressable
              onPress={() => {
                hapticSelection();
                setIsEditingBoards((previous) => !previous);
              }}
              accessibilityRole="button"
              style={styles.sectionAction}
            >
              <Text variant="body" color={brandColors.primary}>
                {isEditingBoards ? t('mobile.manage.done') : t('mobile.manage.edit')}
              </Text>
            </Pressable>
          ) : null
        }
      >
        <BoardCarousel
          items={myBoardItems}
          onSelect={onSelectMyBoardCard}
          onDownload={offlineDownloadsEnabled ? onDownloadMyBoard : undefined}
          downloadLabelFor={downloadLabelFor}
          actionFor={canEditBoards ? myBoardActionFor : undefined}
          actionLabelFor={myBoardActionLabelFor}
          onAction={canEditBoards ? onMyBoardAction : undefined}
          deleteActionTitle={t('mobile.manage.deleteConfirm')}
          unfollowActionTitle={t('mobile.manage.unfollowConfirm')}
          onTogglePin={canPinBoards ? onTogglePin : undefined}
          // Gated with its handler: the card ignores a label it has no control
          // for, but the carousel would still resolve one per row.
          pinLabelFor={canPinBoards ? pinLabelFor : undefined}
          isEditing={isEditingBoards}
          pendingActionKey={pendingActionKey}
        />
        {/* Inside the section because that is what it drills into; gone with the
            section when there are no boards to manage or download. */}
        {manageBoardsRow}
      </Section>
    ) : null;

  const requestLocation = location.request;
  // Onboarding handoff: pre-resolve location on mount so the Find Nearby card is
  // already loading instead of waiting for a tap the user might not discover.
  useEffect(() => {
    if (fromOnboarding) void requestLocation();
  }, [fromOnboarding, requestLocation]);
  const onModeFindNearby = useCallback(() => {
    void requestLocation();
  }, [requestLocation]);

  const onModeBluetooth = useCallback(() => {
    setBluetoothActive(true);
    bluetoothSheetRef.current?.expand();
  }, []);

  // Deliberate "create an owned board" flow: the full-screen builder (a home
  // board owner's board isn't in the DB yet, so this is the primary path).
  const onModeCreate = useCallback(() => {
    // `source` rides along so the builder closes out onboarding: creating a board
    // is how a home-wall owner binds their first one, and without this it was the
    // one bind path that fired no activation event and armed no reveal banner.
    router.push({ pathname: '/boards/create', params: { returnTo: boardReturnTo, source } });
  }, [router, boardReturnTo, source]);

  const onModeFindGym = useCallback(() => {
    router.push({ pathname: '/gyms', params: { returnTo: boardReturnTo } });
  }, [router, boardReturnTo]);

  // A popular config has no UserBoard — open the builder pre-seeded with the
  // tapped config so the user names and creates it (the builder dedupes against
  // a config the user already owns).
  const onSelectPopular = useCallback(
    (item: DiscoveryBoardItem) => {
      router.push({
        pathname: '/boards/create',
        params: {
          returnTo: boardReturnTo,
          source,
          seedBoardName: item.boardName,
          seedLayoutId: String(item.layoutId),
          seedSizeId: String(item.sizeId),
          seedSetIds: item.setIds,
        },
      });
    },
    [router, boardReturnTo, source],
  );

  // Drive the Find Nearby card off both the location permission and the nearby
  // query: loading while resolving the fix or fetching, 'done' once results are
  // actually in (re-tapping would no-op, so show it complete), denied/unavailable
  // on failure. A granted fix that returns *no* boards stays 'idle' rather than a
  // ticked-but-empty 'done', which would look broken.
  const nearbyState: ModeCardState =
    location.status === 'loading' || (location.status === 'granted' && isNearbyLoading)
      ? 'loading'
      : location.status === 'granted' && nearbyItems.length > 0
        ? 'done'
        : location.status === 'denied'
          ? 'denied'
          : location.status === 'unavailable'
            ? 'unavailable'
            : 'idle';

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
        <Icon name="person" size={40} color={iosSystemColors.systemGray} />
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

  // No usable network list: offer what this device downloaded instead of the mode
  // cards, Popular, and a "create a board" CTA that all need a connection.
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
            <BoardCarousel items={offlineItems} onSelect={onSelectMyBoard} />
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
        <Icon name="error" size={40} color={iosSystemColors.systemRed} />
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
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={styles.flex}
        contentContainerStyle={[styles.container, { paddingBottom: scrollBottomPadding }]}
        showsVerticalScrollIndicator={false}
      >
        {fromOnboarding ? (
          <Text variant="subheadline" style={styles.onboardingHeader}>
            {t('mobile.onboardingPrompt')}
          </Text>
        ) : null}

        {/* Mode cards */}
        <View style={styles.modeRow}>
          <BoardModeCard
            icon="location"
            label={t('mobile.discovery.findNearby')}
            sublabel={
              nearbyState === 'denied'
                ? t('mobile.discovery.locationDenied')
                : nearbyState === 'done'
                  ? t('mobile.discovery.nearbyShowing')
                  : undefined
            }
            state={nearbyState}
            onPress={onModeFindNearby}
          />
          <BoardModeCard icon="bluetooth" label={t('mobile.discovery.bluetooth')} onPress={onModeBluetooth} />
          <BoardModeCard icon="pin" label={t('mobile.discovery.findGym')} onPress={onModeFindGym} />
          {/* The tile is 84 dp wide (68 dp of text): "Create board" truncated in
              en-US and in all three other locales. The `+` glyph and the row's
              context carry the noun here; the full-width CTAs keep it. */}
          <BoardModeCard icon="plus" label={t('mobile.discovery.createTile')} onPress={onModeCreate} />
        </View>

        {nearbySection}
        {myBoardsSection}

        {popularItems.length > 0 ? (
          <Section title={t('mobile.discovery.popularTitle')}>
            <BoardCarousel items={popularItems} onSelect={onSelectPopular} />
          </Section>
        ) : null}

        {myBoardItems.length === 0 ? (
          <View style={styles.emptyState}>
            <Text variant="headline" style={styles.emptyTitle}>
              {t('mobile.emptyTitle')}
            </Text>
            <Text variant="subheadline" style={styles.emptySubtitle}>
              {t('mobile.emptySubtitle')}
            </Text>
            <Button title={t('mobile.discovery.create')} onPress={onModeCreate} style={styles.emptyCta} />
          </View>
        ) : null}
      </ScrollView>

      <BluetoothQuickstartSheet
        ref={bluetoothSheetRef}
        active={bluetoothActive}
        onClose={() => setBluetoothActive(false)}
        onSelect={(board) => {
          bluetoothSheetRef.current?.close();
          void activateBoard(board);
        }}
      />
    </>
  );
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  /** Right-aligned section control (the "Your boards" Edit/Done toggle). */
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text variant="title3" style={styles.sectionTitle}>
          {title}
        </Text>
        {trailing}
      </View>
      {children}
    </View>
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
  onboardingHeader: {
    paddingHorizontal: spacing[4],
    opacity: 0.7,
  },
  offlineNotice: {
    paddingHorizontal: spacing[4],
    opacity: 0.7,
  },
  modeRow: {
    flexDirection: 'row',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
  },
  section: {
    gap: spacing[3],
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    // Unconditional, so Near you / Your boards / Popular keep one baseline and
    // the layout does not jump when the Edit control appears.
    minHeight: 44,
  },
  sectionTitle: {
    flex: 1,
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
