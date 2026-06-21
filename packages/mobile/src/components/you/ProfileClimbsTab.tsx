import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { ClimbListRow } from '../ClimbListRow';
import { useUserClimbs } from '../../lib/graphql/hooks';
import { getBoardConfigForPlaylist } from '../../lib/playlists/board-details-for-playlist';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type ProfileClimbsTabProps = {
  userId: string | undefined;
  topInset?: number;
};

const keyExtractor = (climb: Climb) => climb.uuid;

/**
 * Climbs a user has created (web-profile "Created Climbs" parity). Each row
 * resolves its own board art from (boardType, layoutId) — the userClimbs payload
 * carries no size/sets — and opens the climb read-only in the play drawer.
 */
export function ProfileClimbsTab({ userId, topInset = 0 }: ProfileClimbsTabProps) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const router = useRouter();
  const { openPlayDrawer, openClimbActions } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const feed = useUserClimbs(userId);
  const climbs = useMemo(() => feed.data?.pages.flatMap((page) => page.climbs) ?? [], [feed.data]);

  const handlePress = useCallback(
    (climb: Climb) => {
      // boardType is typed optional on Climb but the userClimbs query always returns it.
      if (!climb.boardType) return;
      const config = getBoardConfigForPlaylist(climb.boardType, climb.layoutId);
      if (!config) return;
      // We already have the full climb, so open the play drawer in place (kind
      // 'climb') rather than 'ref', which would route to the Climbs tab's climb
      // screen instead of opening over the profile.
      openClimbInPlayDrawer(
        {
          kind: 'climb',
          climb,
          boardConfig: {
            boardName: config.boardName,
            layoutId: config.layoutId,
            sizeId: config.sizeId,
            setIds: config.setIds.join(','),
            angle: climb.angle,
          },
        },
        { openPlayDrawer, router },
      );
    },
    [openPlayDrawer, router],
  );

  // Long press → reaction menu. Resolves the same per-climb board config handlePress
  // uses (the userClimbs payload carries no size/sets).
  const handleOpenActions = useCallback(
    (climb: Climb) => {
      if (!climb.boardType) return;
      const config = getBoardConfigForPlaylist(climb.boardType, climb.layoutId);
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
      const config = getBoardConfigForPlaylist(item.boardType, item.layoutId);
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
      <FlashList
        data={climbs}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentInsetAdjustmentBehavior="never"
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
