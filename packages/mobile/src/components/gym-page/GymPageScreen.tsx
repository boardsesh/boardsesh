import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useQueryClient } from '@tanstack/react-query';
import { gymClaimCtaClicked, SHARED_EVENTS } from '@boardsesh/analytics';
import type { Gym } from '@boardsesh/shared-schema';
import { useStackScreenOptions } from '../../hooks/use-stack-screen-options';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useHeaderActions } from '../../hooks/use-header-actions';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { track } from '../../lib/analytics';
import { resolveBoardReturnTo } from '../../lib/boards/board-return-to';
import { selectEffectiveOffline, useConnectivityField } from '../../lib/connectivity/use-connectivity';
import { WEB_BASE_URL } from '../../lib/env';
import { useProfile } from '../../lib/graphql/hooks';
import { useGymBoards } from '../../lib/graphql/hooks/use-gym-boards';
import { GYM_BOARDS_QUERY_KEY } from '../../lib/graphql/query-keys';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { buildGymManageUrl } from '../../lib/gym-manage-url';
import { hapticSelection } from '../../lib/haptics';
import { openValidatedUrl } from '../../lib/open-external-link';
import { useSprayLabelOptions } from '../../lib/spray/use-spray-label-options';
import { useAuth } from '../../providers/auth-provider';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { OfflineState } from '../OfflineState';
import { Text } from '../Text';
import { addBoardRoute } from '../board-discovery/add-board-route';
import { trackBoardKindChosen, trackBoardPickerAddSelected } from '../../lib/boards/board-picker-add-analytics';
import { useAddBoardWizardEnabled } from '../../providers/feature-flags-provider';
import { wizardGymBoardsHref } from '../../lib/boards/add-board-wizard';
import type { DiscoveryBoardItem } from '../board-discovery/BoardDiscoveryCardView';
import { ClaimGymSheet } from '../gym-directory/ClaimGymSheet';
import { gymBoardsToItems } from './gym-board-items';
import { GYM_PAGE_CLAIM_DENIED, gymAnalyticsHref, gymEditHref } from './gym-page-route';
import { useGymRouteStack } from './use-gym-route-stack';
import { openSignIn } from '../../lib/routing/open-sign-in';
import {
  boardsHeaderIndex,
  buildGymPageItems,
  deriveGymPageViewModel,
  gymEmailUrl,
  gymMapsUrl,
  gymPhoneUrl,
  gymWebsiteUrl,
  isGymPageExternalUrl,
  shouldLoadPendingClaim,
  type GymBoardsState,
  type GymInfoRow,
  type GymPageItem,
  type GymPageViewer,
  type GymStaffTool,
  type GymStartRow,
} from './gym-page-view-model';
import { GymBoardRow } from './GymBoardRow';
import { GymPageHeaderActions } from './GymPageHeaderActions';
import {
  GymBoardsEmpty,
  GymBoardsError,
  GymBoardsHeader,
  GymBoardsLoading,
  GymClaimCardBlock,
  GymInfoSection,
  GymPageTopBlock,
  GymReportSection,
  GymStaffToolsSection,
  GymStartHereSection,
  type GymPageActions,
} from './GymPageSections';
import { gymPendingClaimQueryKey, useGymPageGym, useGymPendingClaim } from './use-gym-page-data';
import { useGymBoardMenu } from './use-gym-board-menu';
import { useGymReportAction } from './use-gym-report-action';

type GymPageListItem = GymPageItem<DiscoveryBoardItem>;

const keyExtractor = (item: GymPageListItem) => item.key;
const getItemType = (item: GymPageListItem) => item.kind;

const MAPS_PLATFORM: 'ios' | 'android' | 'web' =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

/**
 * A gym's page in the app: who runs it, its boards, its details, and a way to
 * claim it. A pushed route, because it is a destination (notifications and the
 * claim approval open it) that hosts its own sheets (claim, Report a problem on
 * the gym and its boards, and the boards' report review). See
 * docs/mobile/mobile-sheets-vs-routes.md.
 *
 * Registered at `app/gyms/[gym].tsx` on the root stack and re-exported at
 * `app/boards/gym/[gym].tsx` for the board picker's own stack (`gymPageHref`).
 * The param is a gym uuid, or a slug from a pasted link.
 *
 * Online only: a gym's listing has no copy on the phone, so with no connection
 * the page says why rather than showing an old one (docs/data/offline-reads.md).
 */
export default function GymPageScreen() {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const screenOptions = useStackScreenOptions();
  const {
    gym: gymParam,
    returnTo,
    claim: claimParam,
  } = useLocalSearchParams<{ gym?: string; returnTo?: string; claim?: string }>();
  const param = typeof gymParam === 'string' && gymParam.length > 0 ? gymParam : null;

  const gymQuery = useGymPageGym(param);
  const gym = gymQuery.data ?? null;
  // A slug link reads `['gymBySlug', slug]`, which the writes don't invalidate.
  // Once it resolves, switch the page to the uuid read so every write that
  // refreshes `['gym', uuid]` refreshes this page too.
  const resolvedUuid = gym?.uuid ?? null;
  useEffect(() => {
    if (resolvedUuid !== null && param !== null && param !== resolvedUuid) {
      router.setParams({ gym: resolvedUuid });
    }
  }, [resolvedUuid, param, router]);
  // A paused or failed read with nothing to show is the placard, never a spinner.
  const offline = useOfflineQueryState({
    status: gymQuery.status,
    fetchStatus: gymQuery.fetchStatus,
    data: gymQuery.data,
    error: gymQuery.error,
  });
  const { refetch } = gymQuery;
  const retry = useCallback(() => void refetch(), [refetch]);

  const header = <Stack.Screen options={{ ...screenOptions, title: gym?.name ?? '', headerShown: true }} />;

  if (param !== null && offline.isBlocked && offline.reason) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {header}
        <OfflineState reason={offline.reason} onRetry={retry} />
      </View>
    );
  }

  if (param !== null && gymQuery.isPending) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {header}
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Gone, merged away out of reach, or private to someone else.
  if (!gym) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {header}
        <Icon name="gym" size={40} color={systemColors.secondaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.gymPage.notFound')}
        </Text>
        <Button
          title={t('mobile.gymEdit.back')}
          variant="outlined"
          onPress={() => router.back()}
          style={styles.stateButton}
        />
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      {header}
      <GymPageContent
        key={gym.uuid}
        gym={gym}
        returnTo={returnTo}
        claimDenied={claimParam === GYM_PAGE_CLAIM_DENIED}
        onRefreshGym={retry}
      />
    </View>
  );
}

function GymPageContent({
  gym,
  returnTo,
  claimDenied,
  onRefreshGym,
}: {
  gym: Gym;
  returnTo: string | undefined;
  /** Opened from a "we couldn't confirm you run it" notice. */
  claimDenied: boolean;
  onRefreshGym: () => void;
}) {
  const router = useRouter();
  // The page is registered in the root stack and in the board picker's; what
  // it opens stays in the one it is in (gym-page-route.ts).
  const stack = useGymRouteStack();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const bottomChrome = useBottomChromeMetrics();
  const boardReturnTo = resolveBoardReturnTo(returnTo);
  const effectiveOffline = useConnectivityField(selectEffectiveOffline);

  // Who is looking. The stored id answers before the profile does, and offline.
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { userId: storedUserId } = useStoredUserId(isAuthenticated && !profile?.id);
  const viewerId = isAuthenticated ? (profile?.id ?? storedUserId) : undefined;
  const viewer = useMemo<GymPageViewer>(
    () => ({ isAuthenticated, userId: viewerId, authResolved: !authLoading }),
    [isAuthenticated, viewerId, authLoading],
  );

  const pendingClaimQuery = useGymPendingClaim(gym.slug ?? null, shouldLoadPendingClaim(gym, viewer));
  const pendingClaim = pendingClaimQuery.data ?? null;
  const model = useMemo(
    () => deriveGymPageViewModel(gym, viewer, pendingClaim, { claimDenied }),
    [gym, viewer, pendingClaim, claimDenied],
  );

  const reportAction = useGymReportAction(gym);
  const wizardEnabled = useAddBoardWizardEnabled();

  // --- boards ---
  const boardsQuery = useGymBoards(gym.uuid);
  const { data: activeBoard } = useActiveBoard();
  const gymLabelOptions = useSprayLabelOptions('within-gym');
  const boards = useMemo(() => boardsQuery.data ?? [], [boardsQuery.data]);
  const boardItems = useMemo(
    () =>
      gymBoardsToItems(boards, {
        gymName: gym.name,
        activeUuid: activeBoard?.uuid,
        viewerId,
        labelOptions: gymLabelOptions,
        // Staff open the page on what needs fixing.
        reportedFirst: model.staffRole !== null,
      }),
    [boards, gym.name, activeBoard?.uuid, viewerId, gymLabelOptions, model.staffRole],
  );
  // Cached-roster placeholder rows are not the gym's list: the count waits for the server.
  const boardsState: GymBoardsState = boardsQuery.isError
    ? 'error'
    : boardsQuery.isPending || boardsQuery.isPlaceholderData
      ? 'loading'
      : 'ready';
  const boardMenu = useGymBoardMenu({
    gymUuid: gym.uuid,
    gymName: gym.name,
    boards,
    viewerId,
    canManage: isAuthenticated && viewerId !== undefined && !effectiveOffline,
    returnTo: boardReturnTo,
  });
  const { refetch: refetchBoards } = boardsQuery;

  const items = useMemo(
    () =>
      buildGymPageItems({
        model,
        boards: boardItems,
        boardsState,
        canReport: reportAction !== null,
      }),
    [model, boardItems, boardsState, reportAction],
  );

  // --- analytics: once per gym per visit, after the viewer's role is known ---
  const viewedGymRef = useRef<string | null>(null);
  const identityResolved = !authLoading && (!isAuthenticated || viewerId !== undefined);
  useEffect(() => {
    if (!identityResolved || viewedGymRef.current === gym.uuid) return;
    viewedGymRef.current = gym.uuid;
    track(SHARED_EVENTS.GymPageViewed, {
      surface: 'app',
      listingState: gym.listingState,
      viewerRole: model.viewerRole,
    });
  }, [identityResolved, gym.uuid, gym.listingState, model.viewerRole]);

  // --- the claim sheet, hosted in this route ---
  const [claimOpen, setClaimOpen] = useState(false);
  const claimSheetRef = useRef<ManagedSheetHandle>(null);
  useEffect(() => {
    if (claimOpen) claimSheetRef.current?.present();
  }, [claimOpen]);
  const onClaimClosed = useCallback(() => {
    setClaimOpen(false);
    // A claim sent for review shows as pending; one that came through makes the
    // viewer staff, which the gym read answers.
    void queryClient.invalidateQueries({ queryKey: gymPendingClaimQueryKey(gym.slug ?? null) });
    void queryClient.invalidateQueries({ queryKey: ['gym', gym.uuid] });
    void queryClient.invalidateQueries({ queryKey: ['gymBySlug'] });
    // The board roster's actions depend on the viewer's role, so a claim that
    // just approved must not keep showing the climber-level ones.
    void queryClient.invalidateQueries({ queryKey: GYM_BOARDS_QUERY_KEY });
  }, [queryClient, gym.slug, gym.uuid]);

  // --- actions ---
  const listRef = useRef<FlashListRef<GymPageListItem>>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const openExternal = useCallback(
    async (url: string | null, isValid: (candidate: string) => boolean) => {
      if (url === null) return;
      hapticSelection();
      const opened = await openValidatedUrl(url, isValid);
      if (!opened) showToast(t('mobile.gymPage.openError'), 'error');
    },
    [showToast, t],
  );
  const isWebUrl = useCallback((url: string) => url.startsWith(WEB_BASE_URL), []);
  const openManage = useCallback(
    (tab: 'boards' | 'kiosks') => void openExternal(buildGymManageUrl(gym.slug ?? gym.uuid, tab), isWebUrl),
    [openExternal, gym.slug, gym.uuid, isWebUrl],
  );
  const editGym = useCallback(() => {
    hapticSelection();
    router.push(gymEditHref(gym.uuid, stack));
  }, [router, gym.uuid, stack]);
  const signIn = useCallback(() => {
    hapticSelection();
    // From the picker's copy, in place of the picker rather than a card on top.
    openSignIn(router, stack);
  }, [router, stack]);
  // Claim taps join the www claim funnel under their own placement.
  const claim = useCallback(() => {
    hapticSelection();
    const event = gymClaimCtaClicked({ placement: 'app-gym-page', viewerState: 'signed-in', gymUuid: gym.uuid });
    track(event.name, event.properties);
    setClaimOpen(true);
  }, [gym.uuid]);
  const claimSignIn = useCallback(() => {
    const event = gymClaimCtaClicked({ placement: 'app-gym-page', viewerState: 'signed-out', gymUuid: gym.uuid });
    track(event.name, event.properties);
    signIn();
  }, [gym.uuid, signIn]);
  // "Check your boards" on a claim that came through here: the boards, which
  // the gym read refreshes into the staff view.
  const scrollToBoards = useCallback(() => {
    const index = boardsHeaderIndex(itemsRef.current);
    if (index >= 0) void listRef.current?.scrollToIndex({ index, animated: true });
  }, []);
  const mapsUrl = useMemo(() => gymMapsUrl(gym, MAPS_PLATFORM), [gym]);

  const actions = useMemo<GymPageActions>(
    () => ({
      onOpenAddress: () => void openExternal(mapsUrl, isGymPageExternalUrl),
      onClaim: claim,
      onSignIn: claimSignIn,
      onStartRow: (row: GymStartRow) => {
        if (row === 'boards') scrollToBoards();
        else if (row === 'hours') editGym();
        else openManage('kiosks');
      },
      onStaffTool: (tool: GymStaffTool) => {
        if (tool === 'editDetails') editGym();
        else if (tool === 'insights') {
          hapticSelection();
          router.push(gymAnalyticsHref(gym.uuid, stack));
        } else if (tool === 'nearbyBoards') openManage('boards');
        else openManage(tool);
      },
      onInfoRow: (row: GymInfoRow) => {
        if (row === 'website') void openExternal(gymWebsiteUrl(gym.website), isGymPageExternalUrl);
        else if (row === 'phone') void openExternal(gymPhoneUrl(gym.contactPhone), isGymPageExternalUrl);
        else if (row === 'email') void openExternal(gymEmailUrl(gym.contactEmail), isGymPageExternalUrl);
      },
      onSetUpBoard: () => {
        hapticSelection();
        // With the add-a-board wizard on the gym is already known: open the
        // wizard on its boards ("Boards at {gym}"), where an existing one can
        // be taken before a copy is added. Off, the builder as before.
        if (wizardEnabled) {
          trackBoardPickerAddSelected({ kind: 'board', surface: 'gym_page', boardKind: 'gym' });
          trackBoardKindChosen({ kind: 'gym', surface: 'gym_page', preAnswered: true });
          router.push(wizardGymBoardsHref({ returnTo: boardReturnTo, entry: 'gym_page', trail: [] }, gym.uuid));
          return;
        }
        router.push(addBoardRoute('board', { returnTo: boardReturnTo }));
      },
      onRetryBoards: () => void refetchBoards(),
      onReport: () => reportAction?.open(),
    }),
    [
      openExternal,
      mapsUrl,
      claim,
      claimSignIn,
      scrollToBoards,
      editGym,
      openManage,
      gym.website,
      gym.uuid,
      gym.contactPhone,
      gym.contactEmail,
      router,
      stack,
      boardReturnTo,
      wizardEnabled,
      refetchBoards,
      reportAction,
    ],
  );

  // --- the header: share, and ⋯ with follow, edit and report ---
  const headerActions = useMemo(
    () => (
      <GymPageHeaderActions
        gym={gym}
        isFollowing={gym.isFollowedByMe}
        canFollow={model.canFollow}
        canEdit={gym.canEdit}
        onEdit={editGym}
        onSignIn={signIn}
        onReport={reportAction && !gym.canEdit ? reportAction.open : undefined}
      />
    ),
    [gym, model.canFollow, editGym, signIn, reportAction],
  );
  useHeaderActions({ trailingAccessory: headerActions });

  // --- pull to refresh ---
  const [refreshing, setRefreshing] = useState(false);
  const { refetch: refetchPendingClaim } = pendingClaimQuery;
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    onRefreshGym();
    void Promise.allSettled([refetchBoards(), refetchPendingClaim()]).finally(() => setRefreshing(false));
  }, [onRefreshGym, refetchBoards, refetchPendingClaim]);

  const canOpenAddress = mapsUrl !== null;
  const renderItem = useCallback(
    ({ item }: { item: GymPageListItem }) => {
      switch (item.kind) {
        case 'top':
          return <GymPageTopBlock gym={gym} model={model} canOpenAddress={canOpenAddress} actions={actions} />;
        case 'start':
          return <GymStartHereSection rows={item.rows} actions={actions} />;
        case 'boardsHeader':
          return <GymBoardsHeader count={item.count} />;
        case 'board':
          return (
            <GymBoardRow
              item={item.board}
              position={item.position}
              menu={boardMenu.menu}
              onPress={boardMenu.onPressBoard}
            />
          );
        case 'boardsLoading':
          return <GymBoardsLoading />;
        case 'boardsError':
          return <GymBoardsError actions={actions} />;
        case 'boardsEmpty':
          return <GymBoardsEmpty actions={actions} />;
        case 'staff':
          return <GymStaffToolsSection tools={item.tools} actions={actions} />;
        case 'info':
          return <GymInfoSection gym={gym} rows={item.rows} actions={actions} />;
        case 'claim':
          return <GymClaimCardBlock card={item.card} gymName={gym.name} actions={actions} />;
        case 'report':
          return <GymReportSection actions={actions} />;
      }
    },
    [gym, model, canOpenAddress, actions, boardMenu.menu, boardMenu.onPressBoard],
  );

  const contentStyle = useMemo(
    () => ({ paddingBottom: bottomChrome.scrollBottomPadding + spacing[4] }),
    [bottomChrome.scrollBottomPadding],
  );

  return (
    <>
      <FlashList
        ref={listRef}
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={contentStyle}
        refreshing={refreshing}
        onRefresh={onRefresh}
        testID="gym-page-list"
      />
      {claimOpen ? (
        <ClaimGymSheet sheetRef={claimSheetRef} gym={gym} onClosed={onClaimClosed} onCheckBoards={scrollToBoards} />
      ) : null}
      {reportAction?.sheet ?? null}
      {boardMenu.sheets ?? null}
    </>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateButton: {
    marginTop: spacing[4],
  },
});
