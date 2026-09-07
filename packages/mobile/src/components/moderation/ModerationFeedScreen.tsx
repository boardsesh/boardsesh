// The moderation feed — everything the crew has flagged or proposed, in one
// list, with the vote and (for moderators) the verdict on each card.
//
// Hosted by ONE route, `app/moderation.tsx`, a root-stack modal: the play
// drawer links in here and `/play` is itself a root transparentModal, so a
// tab-stack copy would sit beneath the player. See docs/mobile-sheets-vs-routes.md.
//
// Deep links: a notification about a proposal lands here with that proposal's
// uuid. If it is in the loaded pages the list scrolls to it and outlines it; if
// it isn't (it's page 6 of the queue) the climb's own proposals are fetched and
// the matching one is pinned above the feed, so the climber sees the thing they
// tapped rather than a list they have to hunt through.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Proposal } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { OfflineState } from '../OfflineState';
import { SegmentedControl } from '../SegmentedControl';
import type { SegmentOption } from '../SegmentedControl.types';
import { ModerationProposalCard } from './ModerationProposalCard';
import { proposalToClimb } from './proposal-presenters';
import { useBrowseProposals, useClimbProposalsPinned } from '../../lib/graphql/hooks/use-browse-proposals';
import { useMyRoles } from '../../lib/graphql/hooks/use-my-roles';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useAuthToken } from '../../lib/graphql/use-auth-token';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { getBoardConfigForPlaylist } from '../../lib/playlists/board-details-for-playlist';
import { defaultAngle } from '../../lib/boards/default-angle';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useClimbModerationEnabled } from '../../providers/feature-flags-provider';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

// Module-level: the empty-list fallback keeps one identity across renders, and
// `keyExtractor` keeps one identity for the list's lifetime (perf playbook rule
// 3) instead of a fresh arrow every pass.
const EMPTY_PROPOSALS: Proposal[] = [];
const keyExtractor = (proposal: Proposal) => proposal.uuid;

type StatusScope = 'open' | 'all';
type BoardScope = 'thisBoard' | 'allBoards';

export type ModerationFeedScreenProps = {
  /** Scroll to and outline this proposal, pinning it if it isn't in the feed. */
  highlightProposalUuid?: string;
  /** The highlighted proposal's climb — needed to fetch it when it isn't loaded. */
  climbUuid?: string;
  boardType?: string;
};

export function ModerationFeedScreen({ highlightProposalUuid, climbUuid, boardType }: ModerationFeedScreenProps) {
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const router = useRouter();
  const bottomChrome = useBottomChromeMetrics();
  const { openPlayDrawer, openClimbActions } = useDrawerHost();
  const { data: authToken } = useAuthToken();
  const { data: activeBoard } = useActiveBoard();
  const activeBoardType = activeBoard?.boardType ?? null;

  // The kill switch, read HERE rather than in the route, so every host of this
  // screen is covered by the same gate. Flipping `climb-moderation-kill` in
  // PostHog has to stop the fetching too, not only hide the list: a queue that
  // still loads while reporting is down is a queue nobody can act on.
  const moderationEnabled = useClimbModerationEnabled();

  const [statusScope, setStatusScope] = useState<StatusScope>('open');
  const [boardScope, setBoardScope] = useState<BoardScope>('thisBoard');

  // Before the stored board resolves, "This board" scopes to nothing and the
  // feed shows every board — which is the honest answer, not a lie about a
  // board we don't know yet.
  const scopedBoardType = boardScope === 'thisBoard' ? activeBoardType : null;

  // Destructured rather than held as one `query` object: React Query mints a
  // fresh result every render, so a callback listing it as a dep gains nothing.
  const {
    data,
    status,
    fetchStatus,
    isPending,
    isError,
    isRefetching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useBrowseProposals({
    boardType: scopedBoardType,
    status: statusScope === 'open' ? 'open' : null,
    enabled: moderationEnabled,
  });

  const roles = useMyRoles();
  const isSignedIn = !!authToken;

  const proposals = useMemo(
    () => data?.pages.flatMap((page) => page.browseProposals.proposals) ?? EMPTY_PROPOSALS,
    [data],
  );

  const highlightIsLoaded = useMemo(
    () => !!highlightProposalUuid && proposals.some((proposal) => proposal.uuid === highlightProposalUuid),
    [highlightProposalUuid, proposals],
  );

  // Only fires once the first page has settled without the proposal in it, so
  // the common case (the notification points at something near the top) costs
  // no extra request.
  const { data: climbProposalsData } = useClimbProposalsPinned({
    climbUuid,
    boardType,
    enabled: moderationEnabled && !!highlightProposalUuid && !highlightIsLoaded && !isPending,
  });
  // Dropped the moment the row turns up in the pages — a later page, or a
  // refetch, can land the proposal in the list while the pinned query's answer
  // is still cached, and rendering both would show the same card twice.
  const pinnedProposal = highlightIsLoaded
    ? null
    : (climbProposalsData?.climbProposals.proposals.find((proposal) => proposal.uuid === highlightProposalUuid) ??
      null);

  const listRef = useRef<FlashListRef<Proposal>>(null);
  // One scroll per mount: re-running it on every page append would yank the list
  // back under a climber who has scrolled on.
  const hasScrolledToHighlight = useRef(false);

  useEffect(() => {
    if (hasScrolledToHighlight.current || !highlightProposalUuid) return;
    const index = proposals.findIndex((proposal) => proposal.uuid === highlightProposalUuid);
    if (index < 0) return;
    hasScrolledToHighlight.current = true;
    void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.2 });
  }, [highlightProposalUuid, proposals]);

  // Proposals are network-only. `query-provider` runs React Query in
  // `offlineFirst`, so an offline fetch PAUSES rather than failing: `isPending`
  // never clears and the screen would spin forever without this branch.
  const offline = useOfflineQueryState({ status, fetchStatus, data });
  const showOffline = offline.isBlocked && proposals.length === 0;
  const showSpinner = !showOffline && isPending && proposals.length === 0;
  const showError = !showOffline && isError && proposals.length === 0;

  const handleRefresh = useCallback(() => void refetch(), [refetch]);

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Preview, not activate: opening a reported climb from the queue is a look at
  // what is being argued about, not a decision to climb it next.
  const handleOpenClimb = useCallback(
    (proposal: Proposal) => {
      const boardConfig = getBoardConfigForPlaylist(proposal.boardType, proposal.layoutId);
      const climb = proposalToClimb(proposal);
      if (climb && boardConfig) {
        openClimbInPlayDrawer(
          {
            kind: 'climb',
            climb,
            boardConfig: {
              boardName: boardConfig.boardName,
              layoutId: boardConfig.layoutId,
              sizeId: boardConfig.sizeId,
              setIds: boardConfig.setIds.join(','),
              angle: proposal.angle ?? defaultAngle(boardConfig.boardName),
            },
          },
          { openPlayDrawer, router },
          { preview: true },
        );
        return;
      }
      // No frames on the feed row (or a board that can't resolve): fall back to
      // the reference open, which loads the full climb by uuid.
      openClimbInPlayDrawer(
        {
          kind: 'ref',
          climbUuid: proposal.climbUuid,
          boardType: proposal.boardType,
          layoutId: proposal.layoutId,
          angle: proposal.angle ?? (boardConfig ? defaultAngle(boardConfig.boardName) : 0),
        },
        { openPlayDrawer, router },
      );
    },
    [openPlayDrawer, router],
  );

  const handleLongPressClimb = useCallback(
    (proposal: Proposal) => {
      const boardConfig = getBoardConfigForPlaylist(proposal.boardType, proposal.layoutId);
      const climb = proposalToClimb(proposal);
      if (!climb || !boardConfig) return;
      openClimbActions(climb, {
        boardName: boardConfig.boardName,
        layoutId: boardConfig.layoutId,
        sizeId: boardConfig.sizeId,
        setIds: boardConfig.setIds.join(','),
        angle: proposal.angle ?? defaultAngle(boardConfig.boardName),
      });
    },
    [openClimbActions],
  );

  const renderItem = useCallback(
    ({ item }: { item: Proposal }) => (
      <ModerationProposalCard
        proposal={item}
        roles={roles}
        isSignedIn={isSignedIn}
        highlighted={item.uuid === highlightProposalUuid}
        onOpenClimb={handleOpenClimb}
        onLongPressClimb={handleLongPressClimb}
      />
    ),
    [roles, isSignedIn, highlightProposalUuid, handleOpenClimb, handleLongPressClimb],
  );

  const statusOptions = useMemo<SegmentOption<StatusScope>[]>(
    () => [
      { key: 'open', label: t('mobile.moderation.filter.open') },
      { key: 'all', label: t('mobile.moderation.filter.all') },
    ],
    [t],
  );

  const boardOptions = useMemo<SegmentOption<BoardScope>[]>(
    () => [
      { key: 'thisBoard', label: t('mobile.moderation.filter.thisBoard') },
      { key: 'allBoards', label: t('mobile.moderation.filter.allBoards') },
    ],
    [t],
  );

  // No board picked yet → "This board" would filter to nothing meaningful.
  const disabledBoardKeys = useMemo<ReadonlySet<BoardScope> | undefined>(
    () => (activeBoardType ? undefined : new Set<BoardScope>(['thisBoard'])),
    [activeBoardType],
  );

  const listHeader = useMemo(
    () => (
      <View style={styles.header}>
        <SegmentedControl
          options={statusOptions}
          selectedKey={statusScope}
          onSelect={setStatusScope}
          accessibilityLabel={t('mobile.moderation.filter.statusLabel')}
        />
        <SegmentedControl
          options={boardOptions}
          selectedKey={boardScope}
          onSelect={setBoardScope}
          disabledKeys={disabledBoardKeys}
          accessibilityLabel={t('mobile.moderation.filter.boardLabel')}
        />
        {pinnedProposal ? (
          <View style={styles.pinned}>
            <Text variant="caption1" color={brandColors.primary} style={styles.pinnedLabel}>
              {t('mobile.moderation.pinnedFromNotification')}
            </Text>
            <ModerationProposalCard
              proposal={pinnedProposal}
              roles={roles}
              isSignedIn={isSignedIn}
              highlighted
              onOpenClimb={handleOpenClimb}
              onLongPressClimb={handleLongPressClimb}
            />
          </View>
        ) : null}
      </View>
    ),
    [
      statusOptions,
      statusScope,
      boardOptions,
      boardScope,
      disabledBoardKeys,
      pinnedProposal,
      roles,
      isSignedIn,
      handleOpenClimb,
      handleLongPressClimb,
      brandColors.primary,
      t,
    ],
  );

  // A fresh object here would hand FlashList a new contentContainerStyle on every
  // render, which re-lays the list out for nothing.
  const contentContainerStyle = useMemo(
    () => ({ paddingBottom: bottomChrome.scrollBottomPadding + spacing[4] }),
    [bottomChrome.scrollBottomPadding],
  );

  // Below every hook, so the gate never changes how many are called. A
  // notification from before the takedown still lands on this route, so it gets
  // an answer rather than an empty queue it can't explain.
  if (!moderationEnabled) {
    return (
      <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
        <View style={styles.stateBlock}>
          <Icon name="info" size={44} color={systemColors.tertiaryLabel} />
          <Text variant="headline" style={styles.stateTitle}>
            {t('mobile.moderation.unavailable.title')}
          </Text>
          <Text variant="footnote" color={systemColors.tertiaryLabel} style={styles.stateBody}>
            {t('mobile.moderation.unavailable.subtitle')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <FlashList
        ref={listRef}
        data={proposals}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={contentContainerStyle}
        ListHeaderComponent={listHeader}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          showOffline && offline.reason ? (
            <OfflineState reason={offline.reason} onRetry={handleRefresh} />
          ) : showSpinner ? (
            <View style={styles.stateBlock}>
              <ActivityIndicator size="large" />
            </View>
          ) : showError ? (
            <View style={styles.stateBlock}>
              <Icon name="error" size={32} color={iosSystemColors.systemRed} />
              <Text variant="headline" style={styles.stateTitle}>
                {t('mobile.moderation.loadError')}
              </Text>
              <View style={styles.stateCta}>
                <Button title={tCommon('actions.retry')} onPress={handleRefresh} />
              </View>
            </View>
          ) : (
            <View style={styles.stateBlock}>
              <Icon name="check.small" size={44} color={systemColors.tertiaryLabel} />
              <Text variant="headline" style={styles.stateTitle}>
                {t('mobile.moderation.empty.title')}
              </Text>
              <Text variant="footnote" color={systemColors.tertiaryLabel} style={styles.stateBody}>
                {t('mobile.moderation.empty.subtitle')}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        refreshControl={
          // `isRefetching` is `isFetching && !isPending`, which is also true while
          // a NEXT page loads — without the guard the pull-to-refresh spinner pops
          // at the top every time the climber paginates at the bottom.
          <RefreshControl
            refreshing={isRefetching && !isFetchingNextPage}
            onRefresh={handleRefresh}
            tintColor={brandColors.primary}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: spacing[4], paddingTop: spacing[3], gap: spacing[2] },
  pinned: { marginHorizontal: -spacing[4], marginTop: spacing[1] },
  pinnedLabel: { marginHorizontal: spacing[4], fontWeight: '700', letterSpacing: 0.4 },
  stateBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[12],
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  stateTitle: { marginTop: spacing[3], opacity: 0.75, textAlign: 'center' },
  stateBody: { textAlign: 'center' },
  stateCta: { marginTop: spacing[3] },
  footer: { paddingVertical: spacing[5], alignItems: 'center' },
});
