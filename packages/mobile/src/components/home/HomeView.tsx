import type { CrewFeedItem, UserBoard } from '@boardsesh/shared-schema';
import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, StyleSheet, View, type ScrollViewProps } from 'react-native';
import type { OfflineQueryState } from '../../hooks/use-offline-query-state';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import type { FeedMode } from '../../lib/feed/feed-scope';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { Button } from '../Button';
import { Card } from '../Card';
import { ContentRenderMarker } from '../ContentRenderObserver';
import { Icon } from '../Icon';
import { OfflineStateView } from '../OfflineStateView';
import { ReadableColumn } from '../ReadableColumn';
import { Text } from '../Text';
import { EmptyState } from '../EmptyState';
import { HomeEmptyState } from './HomeEmptyState';

const INITIAL_FEED_SKELETON_KEYS = ['home-feed-skeleton-1', 'home-feed-skeleton-2', 'home-feed-skeleton-3'];
const NEXT_PAGE_FEED_SKELETON_KEYS = ['home-feed-footer-skeleton-1', 'home-feed-footer-skeleton-2'];
const keyExtractor = (item: CrewFeedItem) => item.id;
const getItemType = (item: CrewFeedItem) => item.__typename;

export type HomeViewProps = {
  isAuthenticated: boolean;
  feedItems: CrewFeedItem[];
  renderItem: FlashListProps<CrewFeedItem>['renderItem'];
  onViewableItemsChanged?: FlashListProps<CrewFeedItem>['onViewableItemsChanged'];
  listRef?: RefObject<FlashListRef<CrewFeedItem> | null>;
  listExtraData?: unknown;
  nativeRootHeader: boolean;
  chromeHeight: number;
  bottomInset: number;
  scrollEdge?: ScrollEdgeBackdrop;
  handleScroll?: ScrollViewProps['onScroll'];
  handleEndReached: () => void;
  handleRefresh: () => void;
  handleOpenCustomize: () => void;
  handleBrowseEveryone: () => void;
  loadNextPage: () => void;
  onSignIn: () => void;
  header?: ReactNode;
  chrome?: ReactNode;
  overlays?: ReactNode;
  emptyMarker?: ReactNode;
  feedVisible: boolean;
  homeEmpty: boolean;
  sectionsRefreshing: boolean;
  scopeReady: boolean;
  requiresManualPage: boolean;
  mode: FeedMode;
  selectedBoard: Pick<UserBoard, 'name' | 'gymName'> | null;
  feedOffline: OfflineQueryState;
  feed: {
    isRefetching: boolean;
    isLoading: boolean;
    isError: boolean;
    isFetchingNextPage: boolean;
    refetch: () => unknown;
  };
};

/** The Home list and all its loading, empty and error states, without live reads. */
export function HomeView({
  isAuthenticated,
  feedItems,
  renderItem,
  onViewableItemsChanged,
  listRef,
  listExtraData,
  nativeRootHeader,
  chromeHeight,
  bottomInset,
  scrollEdge,
  handleScroll,
  handleEndReached,
  handleRefresh,
  handleOpenCustomize,
  handleBrowseEveryone,
  loadNextPage,
  onSignIn,
  header,
  chrome,
  overlays,
  emptyMarker,
  feedVisible,
  homeEmpty,
  sectionsRefreshing,
  scopeReady,
  requiresManualPage,
  mode,
  selectedBoard,
  feedOffline,
  feed,
}: HomeViewProps) {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  if (!isAuthenticated) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {emptyMarker}
        <EmptyState
          size="screen"
          icon="people"
          title={t('mobile.home.signInTitle')}
          body={t('mobile.home.signInBody')}
          actions={<Button title={tCommon('userDrawer.signIn')} onPress={onSignIn} />}
        />
      </View>
    );
  }

  return (
    <View testID="home-screen" style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <ContentRenderMarker route="/home" count={feedItems.length} />
      <ReadableColumn style={styles.flex}>
        <FlashList
          ref={listRef}
          data={feedItems}
          getItemType={getItemType}
          extraData={listExtraData}
          renderItem={renderItem}
          onViewableItemsChanged={onViewableItemsChanged}
          keyExtractor={keyExtractor}
          // UIKit owns the native title inset; other variants use the measured chrome.
          contentInsetAdjustmentBehavior={nativeRootHeader ? 'automatic' : 'never'}
          contentContainerStyle={{
            paddingTop: chromeHeight,
            paddingBottom: bottomInset + spacing[5],
          }}
          scrollIndicatorInsets={{ top: chromeHeight }}
          // Every frame, so the app bar tints while rows pass under it (the browser
          // build otherwise reports little more than the start and end of a scroll).
          scrollEventThrottle={16}
          {...scrollEdge?.listProps}
          onScroll={handleScroll}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={header ? <>{header}</> : undefined}
          refreshControl={
            <RefreshControl
              refreshing={feedVisible ? feed.isRefetching : sectionsRefreshing}
              onRefresh={handleRefresh}
              tintColor={brandColors.primary}
            />
          }
          ListEmptyComponent={
            !feedVisible ? (
              <>
                {emptyMarker}
                {homeEmpty ? <HomeEmptyState onCustomize={handleOpenCustomize} /> : null}
              </>
            ) : (
              <>
                {emptyMarker}
                {feedOffline.isBlocked && feedOffline.reason ? (
                  <OfflineStateView
                    reason={feedOffline.reason}
                    effectiveOffline={feedOffline.isOffline}
                    onRetry={handleRefresh}
                  />
                ) : feed.isLoading || !scopeReady ? (
                  <ActivitySkeletonList skeletonKeys={INITIAL_FEED_SKELETON_KEYS} />
                ) : feed.isError ? (
                  <View style={styles.feedState}>
                    <Icon name="error" size={32} color={systemColors.error} />
                    <Text variant="headline" style={styles.emptyTitle}>
                      {t('errors.loadActivity')}
                    </Text>
                    <View style={styles.emptyCta}>
                      <Button title={tCommon('actions.retry')} onPress={() => void feed.refetch()} />
                    </View>
                  </View>
                ) : requiresManualPage ? null : mode === 'gym' && selectedBoard != null ? (
                  <EmptyState
                    size="section"
                    icon="boards"
                    title={t('mobile.home.boardEmptyTitle', { board: selectedBoard.gymName ?? selectedBoard.name })}
                    body={t('mobile.home.boardEmptyBody')}
                    actions={<Button title={t('mobile.home.boardEmptyCta')} onPress={handleBrowseEveryone} />}
                  />
                ) : mode === 'crew' ? (
                  <EmptyState
                    size="section"
                    icon="people"
                    title={t('mobile.home.emptyTitle')}
                    body={t('mobile.home.emptyBody')}
                  />
                ) : (
                  <EmptyState size="section" icon="people" title={t('emptyStates.noRecentActivity')} />
                )}
              </>
            )
          }
          ListFooterComponent={
            feed.isFetchingNextPage ? (
              <ActivitySkeletonList skeletonKeys={NEXT_PAGE_FEED_SKELETON_KEYS} />
            ) : requiresManualPage ? (
              <Button title={t('crewLoadMore')} onPress={loadNextPage} />
            ) : null
          }
        />
      </ReadableColumn>
      {chrome}
      {overlays}
    </View>
  );
}

function ActivitySkeletonList({ skeletonKeys }: { skeletonKeys: string[] }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {skeletonKeys.map((skeletonKey) => (
        <ActivityCardSkeleton key={skeletonKey} />
      ))}
    </View>
  );
}

function ActivityCardSkeleton() {
  const { systemColors } = useTheme();
  const blockStyle = { backgroundColor: systemColors.fill };

  return (
    <View style={styles.cardOuter}>
      <Card>
        <View style={styles.skeletonHeader}>
          <View style={[styles.skeletonAvatar, blockStyle]} />
          <View style={styles.skeletonHeaderText}>
            <View style={[styles.skeletonTitleLine, blockStyle]} />
            <View style={[styles.skeletonSmallLine, blockStyle]} />
          </View>
        </View>

        <View style={styles.skeletonBody}>
          <View style={[styles.skeletonThumbnail, blockStyle]} />
          <View style={styles.skeletonDetails}>
            <View style={[styles.skeletonClimbName, blockStyle]} />
            <View style={[styles.skeletonMetaLine, blockStyle]} />
            <View style={[styles.skeletonCommentLine, blockStyle]} />
            <View style={[styles.skeletonCommentShortLine, blockStyle]} />
          </View>
        </View>

        <View style={[styles.skeletonSocialRow, { borderTopColor: systemColors.separator }]}>
          <View style={[styles.skeletonSocialPill, blockStyle]} />
          <View style={[styles.skeletonSocialPill, blockStyle]} />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  header: {
    // A small gap below the floating header band (the list already insets by the
    // band via contentContainerStyle).
    paddingTop: spacing[2],
  },
  scopePicker: {
    alignItems: 'flex-start',
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  feedHeading: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  cardOuter: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  skeletonHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  skeletonAvatar: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.full,
    opacity: 0.5,
  },
  skeletonHeaderText: {
    flex: 1,
    gap: spacing[2],
  },
  skeletonTitleLine: {
    width: '44%',
    height: 18,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  skeletonSmallLine: {
    width: '34%',
    height: 12,
    borderRadius: borderRadius.full,
    opacity: 0.4,
  },
  skeletonBody: {
    flexDirection: 'row',
    gap: spacing[3],
    paddingTop: spacing[3],
  },
  skeletonThumbnail: {
    width: 76,
    height: 96,
    borderRadius: borderRadius.md,
    opacity: 0.55,
  },
  skeletonDetails: {
    flex: 1,
    gap: spacing[2],
  },
  skeletonClimbName: {
    width: '74%',
    height: 20,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  skeletonMetaLine: {
    width: '64%',
    height: 14,
    borderRadius: borderRadius.full,
    opacity: 0.4,
  },
  skeletonCommentLine: {
    width: '92%',
    height: 12,
    borderRadius: borderRadius.full,
    opacity: 0.35,
  },
  skeletonCommentShortLine: {
    width: '58%',
    height: 12,
    borderRadius: borderRadius.full,
    opacity: 0.32,
  },
  skeletonSocialRow: {
    flexDirection: 'row',
    gap: spacing[2],
    marginTop: spacing[3],
    paddingTop: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  skeletonSocialPill: {
    width: 52,
    height: 28,
    borderRadius: borderRadius.full,
    opacity: 0.42,
  },
  feedState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[12],
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  emptyTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  emptyCta: {
    marginTop: spacing[4],
  },
});
