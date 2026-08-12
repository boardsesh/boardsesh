import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@expo/ui/community/bottom-sheet';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useMyBoards, usePopularBoardConfigs, useNearbyBoards } from '../../src/lib/graphql/hooks';
import { useActiveBoard, useSetActiveBoard } from '../../src/lib/graphql/use-active-board';
import { useAdoptFoundBoard } from '../../src/lib/board-discovery/use-adopt-found-board';
import { useDeviceLocation } from '../../src/lib/use-device-location';
import { useAuth } from '../../src/providers/auth-provider';
import { useToast } from '../../src/providers/toast-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { BoardCarousel } from '../../src/components/board-discovery/BoardCarousel';
import { BoardModeCard, type ModeCardState } from '../../src/components/board-discovery/BoardModeCard';
import { BluetoothQuickstartSheet } from '../../src/components/board-discovery/BluetoothQuickstartSheet';
import { userBoardToItem, popularConfigToItem } from '../../src/components/board-discovery/board-items';
import { offlineBoardRows } from '../../src/components/board-discovery/offline-board-items';
import type { DiscoveryBoardItem } from '../../src/components/board-discovery/BoardDiscoveryCard';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useIsOffline } from '../../src/hooks/use-is-offline';
import { useOfflineBoards } from '../../src/settings';
import { useRememberDownloadedBoards } from '../../src/offline/use-remember-downloaded-boards';
import { useDownloadedScopeKeys } from '../../src/offline/use-downloaded-scope-keys';
import { OfflineCatalogCta } from '../../src/components/offline/OfflineCatalogCta';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { setBoardRevealTipPending } from '../../src/lib/onboarding/onboarding-storage';
import { track } from '../../src/lib/analytics';
import { SHARED_EVENTS } from '@boardsesh/analytics';
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
  const { showToast } = useToast();

  // Clear the bottom tab bar and whichever queue controls are actually visible.
  const scrollBottomPadding = bottomChrome.scrollBottomPadding;

  const setActiveBoard = useSetActiveBoard();
  const adoptFoundBoard = useAdoptFoundBoard();
  const { data: activeBoard } = useActiveBoard();

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
  const isOffline = useIsOffline();
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  const offlineCards = useOfflineBoards();
  // `isError && nothing cached` is the lying-connection case: captive portal or gym
  // wifi with a dead upstream, where onlineManager says online, the request fails for
  // real, and retries never pause. Same belt-and-braces reasoning as
  // offlineAwareRequest's network-failure catch.
  const isLocalOnly = isOffline || (isError && myBoards.length === 0);
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

  const activateBoard = useCallback(
    async (board: UserBoard) => {
      hapticSelection();
      try {
        // Persists to AsyncStorage + the ['activeBoard'] cache, then navigates
        // only once the write succeeds (a failed write must not strand the user
        // on a board that won't survive the next cold start).
        await setActiveBoard(board);
        if (fromOnboarding) {
          // The real activation metric — board history turns on the moment a
          // named board is bound — and the one-time Climbs reveal banner is armed
          // for the board they just followed.
          track(SHARED_EVENTS.OnboardingBoardActivated, { boardType: board.boardType, source: 'onboarding' });
          void setBoardRevealTipPending();
        }
        // Dismiss the boards modal back onto the tab it was opened from — Climbs
        // by default (including the onboarding hand-off), Discover when the pill
        // there opened it (replaces with that tab if it isn't already underneath,
        // e.g. opened from a deep link).
        router.dismissTo(boardReturnTo);
        // Follow the board if it's new to the user (so it lands in My Boards) and
        // offer/auto-run its offline download. The isNew guard makes re-selecting a
        // board already in My Boards a no-op for follow. Fire-and-forget: its own
        // errors are handled inside and intentionally don't reach the catch below
        // (which only guards the board-switch write above).
        //
        // Skipped whenever the rows came from the local snapshots: adoption is a follow
        // mutation plus a download confirm, so with no usable connection the only thing
        // it can produce is a "Could not follow X" error toast on a board the user
        // already has downloaded. Gated on `isLocalOnly`, not `isOffline` — the
        // lying-connection branch (captive portal, dead upstream) renders the same rows
        // with `isOffline === false`, and its requests fail just as hard.
        if (!isLocalOnly) void adoptFoundBoard(board);
      } catch {
        showToast(t('mobile.boardSwitchError'), 'error');
      }
    },
    [setActiveBoard, adoptFoundBoard, router, boardReturnTo, showToast, t, fromOnboarding, isLocalOnly],
  );

  const myBoardItems = useMemo(
    () =>
      myBoards
        .map((board) => userBoardToItem(board, activeBoard?.uuid))
        .filter((item): item is DiscoveryBoardItem => item !== null),
    [myBoards, activeBoard?.uuid],
  );
  const nearbyItems = useMemo(
    () =>
      (nearby?.boards ?? [])
        .map((board) => userBoardToItem(board, activeBoard?.uuid))
        .filter((item): item is DiscoveryBoardItem => item !== null),
    [nearby?.boards, activeBoard?.uuid],
  );
  const offlineItems = useMemo(
    () =>
      offlineRows
        .map((board) => userBoardToItem(board, activeBoard?.uuid))
        .filter((item): item is DiscoveryBoardItem => item !== null),
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
  const myBoardsSection =
    myBoardItems.length > 0 ? (
      <Section title={t('mobile.discovery.yourBoardsTitle')}>
        <BoardCarousel items={myBoardItems} onSelect={onSelectMyBoard} />
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
    router.push({ pathname: '/boards/create', params: { returnTo: boardReturnTo } });
  }, [router, boardReturnTo]);

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
          seedBoardName: item.boardName,
          seedLayoutId: String(item.layoutId),
          seedSizeId: String(item.sizeId),
          seedSetIds: item.setIds,
        },
      });
    },
    [router, boardReturnTo],
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
        {/* "No signal" is only true on the offline branch. The lying-connection branch
            has bars — it just can't reach us — so it gets its own line. */}
        <Text variant="subheadline" style={styles.offlineNotice}>
          {isOffline ? t('mobile.offline.pickerNotice') : t('mobile.offline.pickerNoticeUnreachable')}
        </Text>
        {offlineItems.length > 0 ? (
          <Section title={t('mobile.discovery.yourBoardsTitle')}>
            <BoardCarousel items={offlineItems} onSelect={onSelectMyBoard} />
          </Section>
        ) : (
          <View style={styles.emptyState}>
            <Text variant="headline" style={styles.emptyTitle}>
              {t('mobile.offline.pickerEmptyTitle')}
            </Text>
            <Text variant="subheadline" style={styles.emptySubtitle}>
              {t('mobile.offline.pickerEmptyBody')}
            </Text>
            {/* Arm-only, and it renders itself away unless the active board is
                genuinely un-downloaded. This is the surface that used to be a
                pure dead end. */}
            <OfflineCatalogCta board={activeBoard} style={styles.emptyCta} />
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
          <BoardModeCard icon="plus" label={t('mobile.discovery.create')} onPress={onModeCreate} />
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="title3" style={styles.sectionTitle}>
        {title}
      </Text>
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
  sectionTitle: {
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
