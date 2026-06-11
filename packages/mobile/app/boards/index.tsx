import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useMyBoards, usePopularBoardConfigs, useNearbyBoards } from '../../src/lib/graphql/hooks';
import { useActiveBoard, useSetActiveBoard } from '../../src/lib/graphql/use-active-board';
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
import { CustomBoardSheet, type BoardSeed } from '../../src/components/board-discovery/CustomBoardSheet';
import { BluetoothQuickstartSheet } from '../../src/components/board-discovery/BluetoothQuickstartSheet';
import {
  userBoardToItem,
  popularConfigToItem,
  popularItemToGuestBoard,
} from '../../src/components/board-discovery/board-items';
import type { DiscoveryBoardItem } from '../../src/components/board-discovery/BoardDiscoveryCard';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { spacing } from '../../src/theme/tokens';

export default function BoardSelection() {
  const { isAuthenticated, refreshAuthState } = useAuth();
  const bottomChrome = useBottomChromeMetrics();
  const router = useRouter();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const boardReturnTo = resolveBoardReturnTo(returnTo);
  const { t } = useTranslation('boards');
  const { showToast } = useToast();

  // Clear the bottom tab bar and whichever queue controls are actually visible.
  const scrollBottomPadding = bottomChrome.scrollBottomPadding;

  const setActiveBoard = useSetActiveBoard();
  const { data: activeBoard } = useActiveBoard();

  const {
    data: boardConnection,
    isLoading: isMyBoardsLoading,
    isError,
    refetch,
    isRefetching,
  } = useMyBoards(undefined, { enabled: isAuthenticated });
  const myBoards = boardConnection?.boards ?? [];

  const { data: popular } = usePopularBoardConfigs({ limit: 12 });

  const location = useDeviceLocation();
  // 20 km, not the hook's 1 km default — "nearby" should reach across town
  // (a gym a couple of streets away must still surface).
  const { data: nearby, isLoading: isNearbyLoading } = useNearbyBoards(location.coords, 20);

  const customSheetRef = useRef<BottomSheet>(null);
  const bluetoothSheetRef = useRef<BottomSheet>(null);
  // State (not a ref) so the quickstart sheet re-renders and kicks off its scan
  // when opened, and tears it down when closed.
  const [bluetoothActive, setBluetoothActive] = useState(false);
  // Pre-fill for the custom builder — set when opened from a Popular config,
  // null when opened blank from the Custom mode card.
  const [customSeed, setCustomSeed] = useState<BoardSeed | null>(null);

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
        // Dismiss the boards modal back onto the tab it was opened from — Climbs
        // by default, Discover when the pill there opened it (replaces with that
        // tab if it isn't already underneath, e.g. opened from a deep link).
        router.dismissTo(boardReturnTo);
      } catch {
        showToast(t('mobile.boardSwitchError'), 'error');
      }
    },
    [setActiveBoard, router, boardReturnTo, showToast, t],
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
  const popularItems = useMemo(
    () =>
      (popular?.configs ?? [])
        .map((config) => popularConfigToItem(config, activeBoard))
        .filter((item): item is DiscoveryBoardItem => item !== null),
    [popular?.configs, activeBoard],
  );

  // myBoards / nearby items carry the original UserBoard via uuid; look it up to
  // activate. Popular/custom configs synthesize a guest board when signed out,
  // and persist or reuse a real board when signed in.
  const onSelectMyBoard = useCallback(
    (item: DiscoveryBoardItem) => {
      const board =
        myBoards.find((b) => b.uuid === item.key) ?? (nearby?.boards ?? []).find((b) => b.uuid === item.key);
      if (board) {
        void activateBoard(board);
      } else {
        // The item's UserBoard should always be in one of the lists it came
        // from; if a refetch dropped it between render and tap, give feedback
        // rather than a dead tap.
        showToast(t('mobile.boardSwitchError'), 'error');
      }
    },
    [myBoards, nearby?.boards, activateBoard, showToast, t],
  );

  const requestLocation = location.request;
  const onModeFindNearby = useCallback(() => {
    void requestLocation();
  }, [requestLocation]);

  const onModeBluetooth = useCallback(() => {
    setBluetoothActive(true);
    bluetoothSheetRef.current?.expand();
  }, []);

  const onModeCustom = useCallback(() => {
    setCustomSeed(null); // blank builder
    customSheetRef.current?.expand();
  }, []);

  // Both the created-board and already-owned paths close the sheet and activate.
  const onCustomBoardResolved = useCallback(
    (board: UserBoard) => {
      customSheetRef.current?.close();
      void activateBoard(board);
    },
    [activateBoard],
  );

  // A popular config has no UserBoard. Guests get a local active board; signed-in
  // users route through the pre-seeded builder so owned duplicates can be reused
  // and new boards can be persisted.
  const onSelectPopular = useCallback(
    (item: DiscoveryBoardItem) => {
      if (!isAuthenticated) {
        void activateBoard(popularItemToGuestBoard(item));
        return;
      }
      setCustomSeed({
        boardName: item.boardName,
        layoutId: item.layoutId,
        sizeId: item.sizeId,
        setIds: item.setIds,
      });
      customSheetRef.current?.expand();
    },
    [activateBoard, isAuthenticated],
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

  if (isAuthenticated && isMyBoardsLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (isAuthenticated && isError) {
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
          <BoardModeCard icon="plus" label={t('mobile.discovery.custom')} onPress={onModeCustom} />
          <BoardModeCard
            icon="search"
            label={t('mobile.discovery.search')}
            onPress={() => router.push({ pathname: '/boards/search', params: { returnTo: boardReturnTo } })}
          />
        </View>

        {nearbyItems.length > 0 ? (
          <Section title={t('mobile.discovery.nearbyTitle')}>
            <BoardCarousel items={nearbyItems} onSelect={onSelectMyBoard} />
          </Section>
        ) : null}

        {isAuthenticated && myBoardItems.length > 0 ? (
          <Section title={t('mobile.discovery.yourBoardsTitle')}>
            <BoardCarousel items={myBoardItems} onSelect={onSelectMyBoard} />
          </Section>
        ) : null}

        {popularItems.length > 0 ? (
          <Section title={t('mobile.discovery.popularTitle')}>
            <BoardCarousel items={popularItems} onSelect={onSelectPopular} />
          </Section>
        ) : null}

        {nearbyItems.length === 0 && myBoardItems.length === 0 && popularItems.length === 0 ? (
          <View style={styles.emptyState}>
            <Text variant="headline" style={styles.emptyTitle}>
              {t('mobile.emptyTitle')}
            </Text>
            <Text variant="subheadline" style={styles.emptySubtitle}>
              {t('mobile.emptySubtitle')}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      <CustomBoardSheet
        ref={customSheetRef}
        seed={customSeed}
        existingBoards={myBoards}
        onCreated={onCustomBoardResolved}
        onSelectExisting={onCustomBoardResolved}
        isAuthenticated={isAuthenticated}
        onError={() => showToast(t('mobile.custom.createError'), 'error')}
      />
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
});
