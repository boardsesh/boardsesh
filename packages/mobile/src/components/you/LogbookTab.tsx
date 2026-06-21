import { useCallback, useMemo, useRef, useState } from 'react';
import { View, RefreshControl, Pressable, StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { Text } from '../Text';
import { ScreenTitle } from '../ScreenTitle';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { LogbookRow } from './LogbookRow';
import { LogbookEditSheet } from './LogbookEditSheet';
import { useUserAscentsFeed } from '../../lib/graphql/hooks';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { tickToClimb } from '../../lib/tick-to-climb';
import { getBoardConfigForPlaylist } from '../../lib/playlists/board-details-for-playlist';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type LogbookTabProps = {
  userId: string | undefined;
  /** Measured chrome height — the list insets its top by this so the first row
   *  rests below the floating chrome and the rest scroll under it. */
  topInset?: number;
  /**
   * Whether the signed-in user owns this logbook. Defaults to true (the You
   * tab). When false (viewing another climber's profile) a row opens the climb
   * read-only in the play drawer instead of the editable LogbookEditSheet.
   */
  viewerIsOwner?: boolean;
  /** In-body identity title (the own "You" tab passes "You"). Omitted on another
   *  climber's profile, where the name lives in the public-profile header. */
  screenTitle?: string;
};

export function LogbookTab({ userId, topInset = 0, viewerIsOwner = true, screenTitle }: LogbookTabProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  const router = useRouter();
  const { openPlayDrawer, openClimbActions } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const editSheetRef = useRef<BottomSheet | null>(null);
  const [editAscent, setEditAscent] = useState<AscentFeedItem | null>(null);

  const feed = useUserAscentsFeed(userId);
  // Stabilise the FlashList `data` identity so it doesn't re-diff every render.
  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.userAscentsFeed.items) ?? [], [feed.data]);

  // Tap → set the climb active and open the play drawer (own logbook and another
  // climber's read-only logbook alike). AscentFeedItem structurally satisfies the
  // `tick` kind, which builds the climb + board config from frames.
  const handleActivate = useCallback(
    (ascent: AscentFeedItem) => {
      track(SHARED_EVENTS.LogbookRowClicked, { climbUuid: ascent.climbUuid });
      // Default open mode is now "set active", so no option is needed here.
      openClimbInPlayDrawer({ kind: 'tick', tick: ascent }, { openPlayDrawer, router });
    },
    [openPlayDrawer, router],
  );

  // Swipe left-to-right → edit this tick (owner-only). The old tap behaviour.
  const handleEdit = useCallback((ascent: AscentFeedItem) => {
    setEditAscent(ascent);
    editSheetRef.current?.snapToIndex(0);
  }, []);

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
      const config = getBoardConfigForPlaylist(ascent.boardType, ascent.layoutId);
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
        viewerIsOwner ? { onEditEntry: () => handleEdit(ascent) } : undefined,
      );
    },
    [openClimbActions, viewerIsOwner, handleEdit],
  );

  const handleEndReached = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed]);

  const handleRetry = useCallback(() => {
    void feed.refetch();
  }, [feed]);

  const renderItem = useCallback(
    ({ item }: { item: AscentFeedItem }) => (
      <LogbookRow
        ascent={item}
        onActivate={handleActivate}
        onOpenActions={handleOpenActions}
        onEdit={viewerIsOwner ? handleEdit : undefined}
      />
    ),
    [handleActivate, handleOpenActions, handleEdit, viewerIsOwner],
  );

  // The screen's identity (when supplied), in-body under the floating chrome.
  // Memoized so FlashList doesn't re-render the header on every LogbookTab render.
  // ScreenTitle hides itself on Material (the M3 app bar owns the title); the
  // whole header is omitted on another climber's profile (no title passed).
  const listHeader = useMemo(
    () => (screenTitle ? <ScreenTitle style={styles.screenTitle}>{screenTitle}</ScreenTitle> : null),
    [screenTitle],
  );

  if (!userId || feed.isPending) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (feed.isError) {
    return (
      <View style={[styles.errorContainer, { paddingTop: topInset }]}>
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
    );
  }

  return (
    <View style={styles.flex}>
      <FlashList
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentInsetAdjustmentBehavior="never"
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingTop: topInset, paddingBottom }}
        scrollIndicatorInsets={{ top: topInset }}
        ListHeaderComponent={listHeader}
        refreshControl={
          <RefreshControl
            refreshing={feed.isRefetching}
            onRefresh={() => void feed.refetch()}
            tintColor={brandColors.primary}
          />
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
              {t('mobile.logbook.empty')}
            </Text>
          </View>
        }
      />
      {viewerIsOwner ? (
        <LogbookEditSheet sheetRef={editSheetRef} ascent={editAscent} onClose={() => setEditAscent(null)} />
      ) : null}
    </View>
  );
}

function keyExtractor(item: AscentFeedItem) {
  return item.uuid;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingVertical: spacing[5], alignItems: 'center' },
  screenTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
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
