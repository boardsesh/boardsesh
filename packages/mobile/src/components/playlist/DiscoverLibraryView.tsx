import type { ReactNode } from 'react';
import { View, RefreshControl, ScrollView, StyleSheet, type ScrollViewProps } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ReadableColumn } from '../ReadableColumn';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { OfflineStateView } from '../OfflineStateView';
import { Button } from '../Button';
import { SectionHeader } from '../SectionHeader';
import { useTheme } from '../../providers/theme-provider';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import type { OfflineQueryReason } from '../../hooks/use-offline-query-state';
import { spacing } from '../../theme/tokens';

export type DiscoverLibraryViewProps = {
  nativeRootHeader: boolean;
  chromeHeight: number;
  bottomInset: number;
  scrollEdge?: ScrollEdgeBackdrop;
  onScroll?: ScrollViewProps['onScroll'];
  refreshing: boolean;
  onRefresh: () => void;
  showSignInPrompt: boolean;
  onSignIn: () => void;
  emptyState: 'none' | 'empty' | 'error' | 'offline' | 'loading';
  offlineReason: OfflineQueryReason;
  effectiveOffline: boolean;
  onRetry: () => void;
  onCreate: () => void;
  pinned?: ReactNode;
  ownedShelf?: ReactNode;
  forYouShelf?: ReactNode;
  communityShelf?: ReactNode;
  chrome?: ReactNode;
  createAction?: ReactNode;
  overlays?: ReactNode;
};

/** Shared library layout; its owner supplies the bounded shelves and live actions. */
export function DiscoverLibraryView({
  nativeRootHeader,
  chromeHeight,
  bottomInset,
  scrollEdge,
  onScroll,
  refreshing,
  onRefresh,
  showSignInPrompt,
  onSignIn,
  emptyState,
  offlineReason,
  effectiveOffline,
  onRetry,
  onCreate,
  pinned,
  ownedShelf,
  forYouShelf,
  communityShelf,
  chrome,
  createAction,
  overlays,
}: DiscoverLibraryViewProps) {
  const { t } = useTranslation('playlists');
  const { systemColors, brandColors, variant } = useTheme();
  return (
    <View style={styles.flex}>
      <ReadableColumn style={styles.flex}>
        <ScrollView
          style={styles.flex}
          contentInsetAdjustmentBehavior={nativeRootHeader ? 'automatic' : 'never'}
          contentContainerStyle={{ paddingTop: chromeHeight, paddingBottom: bottomInset + spacing[6] }}
          scrollIndicatorInsets={{ top: chromeHeight }}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          {...scrollEdge?.listProps}
          onScroll={onScroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={brandColors.primary}
              progressViewOffset={chromeHeight}
            />
          }
        >
          {nativeRootHeader || variant === 'material' ? null : (
            <Text variant="largeTitle" style={styles.screenTitle}>
              {t('bottomTabBar.discover')}
            </Text>
          )}
          {showSignInPrompt ? (
            <PressableSurface
              style={[styles.signInBanner, { borderColor: systemColors.separator }]}
              onPress={onSignIn}
              accessibilityRole="button"
            >
              <Icon name="person" size={26} color={systemColors.secondaryLabel} />
              <View style={styles.signInText}>
                <Text variant="subheadline" style={styles.signInTitle}>
                  {t('library.signInBanner.title')}
                </Text>
                <Text variant="caption1" style={styles.signInDescription}>
                  {t('library.signInBanner.description')}
                </Text>
              </View>
              <Text variant="subheadline" color={brandColors.primary} style={styles.signInCta}>
                {t('library.signInBanner.cta')}
              </Text>
            </PressableSurface>
          ) : null}
          {pinned ? (
            <View style={styles.section}>
              <SectionHeader title={t('library.sections.pinned')} />
              <View style={styles.grid}>{pinned}</View>
            </View>
          ) : null}
          {ownedShelf}
          {forYouShelf}
          {communityShelf}
          {emptyState === 'error' ? (
            <View style={styles.emptyContainer}>
              <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
              <Text variant="headline" style={styles.emptyTitle}>
                {t('library.errors.loadTitle')}
              </Text>
              <Text variant="subheadline" style={styles.emptySubtitle}>
                {t('library.errors.loadDescription')}
              </Text>
              <PressableSurface
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityLabel={t('library.errors.tryAgain')}
                hitSlop={8}
              >
                <Text variant="subheadline" color={brandColors.primary} style={styles.retryCta}>
                  {t('library.errors.tryAgain')}
                </Text>
              </PressableSurface>
            </View>
          ) : null}
          {emptyState === 'offline' ? (
            <OfflineStateView reason={offlineReason} effectiveOffline={effectiveOffline} />
          ) : null}
          {emptyState === 'empty' ? (
            <View style={styles.emptyContainer}>
              <Icon name="playlist" size={48} color={systemColors.tertiaryLabel} />
              <Text variant="headline" style={styles.emptyTitle}>
                {t('library.empty.title')}
              </Text>
              <Text variant="subheadline" style={styles.emptySubtitle}>
                {t('library.empty.description')}
              </Text>
              <View style={styles.emptyCta}>
                <Button title={t('library.empty.createCta')} icon="plus" onPress={onCreate} />
              </View>
            </View>
          ) : null}
          {emptyState === 'loading' ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" />
            </View>
          ) : null}
        </ScrollView>
      </ReadableColumn>
      {chrome}
      {createAction}
      {overlays}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    minHeight: 0,
  },
  // Material create FAB: bottom-trailing, the list scrolls under it; the host sets
  // `bottom` from the variant-correct floating-control offset (clears tab bar +
  // queue accessory).
  createFab: {
    position: 'absolute',
    right: spacing[4],
  },
  screenTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
  section: {
    marginTop: spacing[2],
    marginBottom: spacing[2],
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing[4],
    rowGap: spacing[4],
  },
  gridItem: {
    width: '50%',
    paddingEnd: spacing[3],
  },
  signInBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    marginHorizontal: spacing[4],
    marginTop: spacing[3],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  signInText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  signInTitle: {
    fontWeight: '600',
  },
  signInDescription: {
    opacity: 0.6,
  },
  signInCta: {
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[10] * 2,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    marginTop: 12,
    opacity: 0.6,
  },
  emptySubtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
  emptyCta: {
    marginTop: spacing[4],
  },
  retryCta: {
    marginTop: spacing[3],
    fontWeight: '600',
  },
  loadingContainer: {
    paddingTop: spacing[10] * 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
