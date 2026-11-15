import { type ComponentProps, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { Button } from '../Button';
import { OfflineStateView } from '../OfflineStateView';
import { SearchEmptyRecovery } from '../search/SearchEmptyRecovery';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { OfflineQueryReason } from '../../hooks/use-offline-query-state';

type RecoveryProps = ComponentProps<typeof SearchEmptyRecovery>;
export type ClimbsEmptyStateProps = {
  status:
    | 'loading'
    | 'authors-sync'
    | 'error'
    | 'offline-filter'
    | 'offline-missing'
    | 'offline-queued'
    | 'unset-wall'
    | 'empty'
    | null;
  loadingContent?: ReactNode;
  offlineFilterReason: OfflineQueryReason;
  boardName: string;
  angle: number;
  query: string;
  tokens: RecoveryProps['tokens'];
  lockedDimensions: RecoveryProps['lockedDimensions'];
  canCreateClimb: boolean;
  onRetry: () => void;
  onClearFilters: () => void;
  onCreate: () => void;
  onOpenFilters: () => void;
  downloadAction?: ReactNode;
};

export function ClimbsEmptyState({
  status,
  loadingContent,
  offlineFilterReason,
  boardName,
  angle,
  query,
  tokens,
  lockedDimensions,
  canCreateClimb,
  onRetry,
  onClearFilters,
  onCreate,
  onOpenFilters,
  downloadAction,
}: ClimbsEmptyStateProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  return status === 'loading' ? (
    loadingContent
  ) : status === 'authors-sync' ? (
    <View style={styles.emptyContainer}>
      <Text variant="subheadline" style={styles.emptySubtitle}>
        {t('authors.syncNeeded')}
      </Text>
      <Button title={t('authors.retry')} onPress={onRetry} />
    </View>
  ) : status === 'error' ? (
    <OfflineStateView reason="error" onRetry={onRetry} effectiveOffline={false} />
  ) : status === 'offline-filter' ? (
    <View style={styles.emptyContainer}>
      {/* The glyph carries the same blame as the title: a wifi-slash over
                "needs our server" would contradict itself. */}
      <Icon
        name={offlineFilterReason === 'backend_unreachable' ? 'server.unreachable' : 'offline.unavailable'}
        size={48}
        color={systemColors.tertiaryLabel}
      />
      {/* "Needs a signal" is a lie when the phone has four bars and we
                are the ones who are down, or when the climber chose Offline
                mode. Literal keys — the i18n linter rejects a computed one. */}
      <Text variant="headline" style={styles.emptyTitle}>
        {offlineFilterReason === 'backend_unreachable'
          ? t('mobile.emptyState.offlineFilter.titleServer')
          : offlineFilterReason === 'offline_mode'
            ? t('mobile.emptyState.offlineFilter.titleOfflineMode')
            : t('mobile.emptyState.offlineFilter.title')}
      </Text>
      <Text variant="subheadline" style={styles.emptySubtitle}>
        {t('mobile.emptyState.offlineFilter.subtitle')}
      </Text>
      <Button
        title={t('mobile.emptyState.offlineFilter.cta')}
        variant="outlined"
        onPress={onClearFilters}
        style={styles.emptyCta}
      />
    </View>
  ) : status === 'offline-missing' ? (
    <View style={styles.emptyContainer}>
      <Icon name="offline.download" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="headline" style={styles.emptyTitle}>
        {t('mobile.emptyState.offlineNoCatalog.title')}
      </Text>
      <Text variant="subheadline" style={styles.emptySubtitle}>
        {t('mobile.emptyState.offlineNoCatalog.subtitle')}
      </Text>
      {downloadAction}
    </View>
  ) : status === 'offline-queued' ? (
    <View style={styles.emptyContainer}>
      <Icon name="offline.download" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="headline" style={styles.emptyTitle}>
        {t('mobile.emptyState.offlineCatalogQueued.title')}
      </Text>
      <Text variant="subheadline" style={styles.emptySubtitle}>
        {t('mobile.emptyState.offlineCatalogQueued.subtitle', { name: boardName })}
      </Text>
    </View>
  ) : status === 'unset-wall' ? (
    <View style={styles.emptyContainer}>
      <Icon name="add" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="headline" style={styles.emptyTitle}>
        {t('mobile.emptyState.unsetWall.title')}
      </Text>
      <Text variant="subheadline" style={styles.emptySubtitle}>
        {t('mobile.emptyState.unsetWall.subtitle')}
      </Text>
      {canCreateClimb ? (
        <Button
          title={t('mobile.emptyState.unsetWall.cta')}
          variant="outlined"
          onPress={onCreate}
          style={styles.emptyCta}
        />
      ) : null}
    </View>
  ) : status === 'empty' ? (
    <SearchEmptyRecovery
      query={query}
      boardName={boardName}
      angle={angle}
      tokens={tokens}
      lockedDimensions={lockedDimensions}
      onOpenFilters={onOpenFilters}
    />
  ) : null;
}
const styles = StyleSheet.create({
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: { marginTop: 12, opacity: 0.6 },
  emptySubtitle: { opacity: 0.4, textAlign: 'center' },
  emptyCta: { marginTop: spacing[4] },
});
