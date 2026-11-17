import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import type { LogbookListRow } from '@boardsesh/logbook';
import { FlashList, type FlashListProps } from '@shopify/flash-list';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, StyleSheet, View } from 'react-native';
import type { OfflineQueryState } from '../../hooks/use-offline-query-state';
import { ScrollEdgeListReset, type ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, opacity, spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { OfflineStateView } from '../OfflineStateView';
import { PressableSurface } from '../PressableSurface';
import { ReadableColumn } from '../ReadableColumn';
import { Text } from '../Text';
export type LogbookGroupUnit = AscentFeedItem & { wall?: string; groupTries?: number; groupItems?: AscentFeedItem[] };
export type LogbookViewProps = {
  userId?: string;
  viewerIsOwner: boolean;
  hasComposedHeader: boolean;
  controls: ReactNode;
  header?: ReactNode;
  overlays?: ReactNode;
  boardLinkPrompt?: ReactNode;
  headerMeasured: boolean;
  nativeRootHeader: boolean;
  headerHeight: number;
  scrollHeaderInset: number;
  paddingBottom: number;
  offline: OfflineQueryState;
  isFiltered: boolean;
  listRows: LogbookListRow<LogbookGroupUnit>[];
  renderItem: FlashListProps<LogbookListRow<LogbookGroupUnit>>['renderItem'];
  scrollEdge?: ScrollEdgeBackdrop;
  handleScroll?: FlashListProps<LogbookListRow<LogbookGroupUnit>>['onScroll'];
  handleRetry: () => void;
  handleRefresh: () => void;
  handleEndReached: () => void;
  handleClearFilters: () => void;
  feed: { isPending: boolean; isError: boolean; isRefetching: boolean; isFetchingNextPage: boolean };
};
export function LogbookView({
  userId,
  viewerIsOwner,
  hasComposedHeader,
  controls,
  header,
  overlays,
  boardLinkPrompt,
  headerMeasured,
  nativeRootHeader,
  headerHeight,
  scrollHeaderInset,
  paddingBottom,
  offline,
  isFiltered,
  listRows,
  renderItem,
  scrollEdge,
  handleScroll,
  handleRetry,
  handleRefresh,
  handleEndReached,
  handleClearFilters,
  feed,
}: LogbookViewProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  return (
    <View style={styles.flex}>
      <ReadableColumn style={styles.flex}>
        {hasComposedHeader ? null : controls}
        {/* UIKit supplies its title inset to the full-height scroll view. Material
            uses an opaque header, so its entire results frame starts below it. */}
        <View
          pointerEvents={headerMeasured ? 'auto' : 'none'}
          accessibilityElementsHidden={!headerMeasured}
          importantForAccessibility={headerMeasured ? 'auto' : 'no-hide-descendants'}
          style={[
            styles.flex,
            hasComposedHeader && !nativeRootHeader && { paddingTop: headerHeight, overflow: 'hidden' },
            !headerMeasured && styles.unmeasuredContent,
          ]}
        >
          {!userId ? (
            <View style={[styles.centered, { paddingTop: scrollHeaderInset }]}>
              <ActivityIndicator size="large" />
            </View>
          ) : offline.isBlocked && offline.reason ? (
            <View style={[styles.centered, { paddingTop: scrollHeaderInset }]}>
              <OfflineStateView
                effectiveOffline={offline.isOffline}
                reason={offline.reason}
                errorTitle={t('mobile.logbook.errorTitle')}
                onRetry={handleRetry}
              />
            </View>
          ) : feed.isPending ? (
            <View style={[styles.centered, { paddingTop: scrollHeaderInset }]}>
              <ActivityIndicator size="large" />
            </View>
          ) : feed.isError ? (
            <View style={[styles.errorContainer, { paddingTop: scrollHeaderInset }]}>
              <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
              <Text variant="headline" style={styles.errorTitle}>
                {t('mobile.logbook.errorTitle')}
              </Text>
              <Text tone="secondary" variant="subheadline" style={styles.errorBody}>
                {t('mobile.logbook.errorBody')}
              </Text>
              <PressableSurface
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
                <Text variant="footnote" color={systemColors.accent}>
                  {t('mobile.logbook.retry')}
                </Text>
              </PressableSurface>
            </View>
          ) : (
            <>
              <ScrollEdgeListReset edge={scrollEdge} />
              <FlashList
                testID="logbook-screen"
                data={listRows}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                getItemType={getRowType}
                {...scrollEdge?.listProps}
                onScroll={handleScroll}
                // The native controls are measured after this list mounts. Keeping
                // a row anchored would scroll away the padding added for them.
                maintainVisibleContentPosition={hasComposedHeader && nativeRootHeader ? { disabled: true } : undefined}
                contentInsetAdjustmentBehavior={nativeRootHeader ? 'automatic' : 'never'}
                onEndReached={handleEndReached}
                onEndReachedThreshold={0.5}
                contentContainerStyle={{ paddingTop: scrollHeaderInset, paddingBottom }}
                scrollIndicatorInsets={{ top: scrollHeaderInset }}
                refreshControl={
                  <RefreshControl
                    refreshing={feed.isRefetching}
                    onRefresh={handleRefresh}
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
                  <EmptyState
                    size="section"
                    style={{ paddingTop: 120 }}
                    icon="tick.outline"
                    title={
                      isFiltered
                        ? t('mobile.logbook.emptyFiltered')
                        : viewerIsOwner
                          ? t('mobile.logbook.empty')
                          : t('mobile.logbook.emptyOther')
                    }
                    actions={
                      <>
                        {isFiltered ? (
                          <Button
                            title={t('mobile.logbook.clearFilters')}
                            onPress={handleClearFilters}
                            variant="tonal"
                            size="medium"
                          />
                        ) : null}
                        {/* Unfiltered only: a logbook emptied by a filter says nothing about
                  whether a board account is linked. */}
                        {boardLinkPrompt}
                      </>
                    }
                  />
                }
              />
            </>
          )}
        </View>
      </ReadableColumn>

      {header}
      {overlays}
    </View>
  );
}
function keyExtractor(row: LogbookListRow<LogbookGroupUnit>) {
  return row.key;
}

// Divider vs entry recycling pools — FlashList must never recycle a divider
// into a climb row or vice versa.
function getRowType(row: LogbookListRow<LogbookGroupUnit>) {
  return row.type;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minHeight: 0 },
  unmeasuredContent: { opacity: 0 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingVertical: spacing[5], alignItems: 'center' },
  // The capsule row and the rails pad their own 16pt gutter and scroll out to
  // the column's edge, so the block itself has no side padding.
  controls: {
    paddingBottom: spacing[1],
  },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[1],
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  errorTitle: { marginTop: spacing[3], textAlign: 'center' },
  errorBody: { textAlign: 'center' },
  retryButton: {
    marginTop: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  retryButtonDisabled: { opacity: opacity.disabled },
});
