import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { ScrollEdgeListReset, type ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { ClimbProgressProvider, type ClimbProgressTarget } from '../../providers/climb-progress-provider';
import { ClimbListRow } from '../ClimbListRow';
import { useUserClimbs } from '../../lib/graphql/hooks';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { useBoardListActivation, type BoardListRow } from '../../lib/playlists/use-board-list-activation';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type ProfileClimbsTabProps = {
  userId: string | undefined;
  topInset?: number;
  /** The Profile tab's `useScrollEdgeBackdrop().list`: tells the floating header
   *  when this tab's list is scrolled under it. Undefined under an opaque header. */
  scrollEdge?: ScrollEdgeBackdrop;
};

const keyExtractor = (climb: Climb) => climb.uuid;

// Rows keep their identity across pages, so each is read once.
const describedClimbs = new WeakMap<Climb, BoardListRow>();

/**
 * The board a profile climb is drawn on. The userClimbs payload carries no
 * size or sets, so they come from the climb's resolved render board, or the
 * layout's default when it has none.
 */
function describeProfileClimb(climb: Climb): BoardListRow {
  const described = describedClimbs.get(climb);
  if (described) return described;
  // boardType is typed optional on Climb but the userClimbs query always returns it.
  // A climb with no board to draw on gets `board: null` here, and `renderItem`
  // renders no row for it under the same two checks, so a tap never reaches
  // the list hook without a board and this list needs no `openFallback`.
  const config = climb.boardType
    ? renderBoardToPlaylistConfig(climb.boardType, climb.layoutId, climb.renderBoard)
    : null;
  const row: BoardListRow = {
    climb,
    board: config
      ? {
          boardName: config.boardName,
          layoutId: config.layoutId,
          sizeId: config.sizeId,
          setIds: config.setIds.join(','),
          angle: climb.angle,
        }
      : null,
  };
  describedClimbs.set(climb, row);
  return row;
}

/**
 * Climbs a user has created (web-profile "Created Climbs" parity). Each row
 * resolves its own board art from (boardType, layoutId) — the userClimbs payload
 * carries no size/sets — and opens the climb read-only in the play drawer.
 */
export function ProfileClimbsTab({ userId, topInset = 0, scrollEdge }: ProfileClimbsTabProps) {
  const nativeRootHeader = useNativeRootHeader();
  const { t } = useTranslation('you');
  const { t: tSession } = useTranslation('session');
  const { systemColors } = useTheme();
  const { openClimbActions } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const feed = useUserClimbs(userId);
  const climbs = useMemo(() => feed.data?.pages.flatMap((page) => page.climbs) ?? [], [feed.data]);

  const progressTargets = useMemo<ClimbProgressTarget[]>(() => {
    const targets: ClimbProgressTarget[] = [];
    for (const climb of climbs) {
      if (!climb.boardType) continue;
      const config = renderBoardToPlaylistConfig(climb.boardType, climb.layoutId, climb.renderBoard);
      if (config) targets.push({ boardName: config.boardName as BoardName, climbUuid: climb.uuid });
    }
    return targets;
  }, [climbs]);

  // A tap opens the climb playing from this profile's climbs, paging on through
  // the same feed as the climber swipes (issue #6665). Climbs set on another
  // board open as a preview on their own board.
  const fetchNextClimbsPage = feed.fetchNextPage;
  const loadMoreClimbs = useCallback(async () => {
    const result = await fetchNextClimbsPage({ cancelRefetch: false });
    if (result.isError) throw result.error;
    return { rows: result.data?.pages.flatMap((page) => page.climbs) ?? [], hasMore: result.hasNextPage ?? false };
  }, [fetchNextClimbsPage]);
  const handlePress = useBoardListActivation<Climb>({
    sourceId: `profile-climbs:${userId ?? ''}`,
    label: tSession('playView.track.createdClimbs'),
    rows: climbs,
    describeRow: describeProfileClimb,
    hasMore: feed.hasNextPage ?? false,
    loadMore: loadMoreClimbs,
  });

  // Long press → reaction menu. Resolves the same per-climb board config handlePress
  // uses (the userClimbs payload carries no size/sets).
  const handleOpenActions = useCallback(
    (climb: Climb) => {
      if (!climb.boardType) return;
      const config = renderBoardToPlaylistConfig(climb.boardType, climb.layoutId, climb.renderBoard);
      if (!config) return;
      openClimbActions(climb, {
        boardName: config.boardName,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds: config.setIds.join(','),
        angle: climb.angle,
      });
    },
    [openClimbActions],
  );

  const handleEndReached = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed]);

  const renderItem = useCallback(
    ({ item }: { item: Climb }) => {
      if (!item.boardType) return null;
      const config = renderBoardToPlaylistConfig(item.boardType, item.layoutId, item.renderBoard);
      if (!config) return null;
      return (
        <ClimbListRow
          climb={item}
          boardName={config.boardName as BoardName}
          layoutId={config.layoutId}
          sizeId={config.sizeId}
          setIds={config.setIds.join(',')}
          angle={item.angle}
          onPress={handlePress}
          onOpenActions={handleOpenActions}
          showProgress
        />
      );
    },
    [handlePress, handleOpenActions],
  );

  if (!userId || feed.isPending) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {/* The loading branch above unmounts the list. */}
      <ScrollEdgeListReset edge={scrollEdge} />
      <ClimbProgressProvider targets={progressTargets}>
        <FlashList
          data={climbs}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          {...scrollEdge?.listProps}
          contentInsetAdjustmentBehavior={nativeRootHeader ? 'automatic' : 'never'}
          contentContainerStyle={{ paddingTop: topInset, paddingBottom }}
          scrollIndicatorInsets={{ top: topInset }}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            feed.isError ? (
              <View style={styles.stateBlock}>
                <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
                <Text variant="headline" style={styles.stateTitle}>
                  {t('mobile.profile.climbsError')}
                </Text>
              </View>
            ) : (
              <View style={styles.stateBlock}>
                <Icon name="boards" size={48} color={systemColors.tertiaryLabel} />
                <Text variant="headline" style={styles.stateTitle}>
                  {t('mobile.profile.noClimbs')}
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            feed.isFetchingNextPage ? (
              <View style={styles.footer}>
                <ActivityIndicator size="small" />
              </View>
            ) : null
          }
        />
      </ClimbProgressProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stateBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[16],
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  stateTitle: {
    marginTop: spacing[3],
    opacity: 0.65,
    textAlign: 'center',
  },
  footer: {
    paddingVertical: spacing[5],
    alignItems: 'center',
  },
});
