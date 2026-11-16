import { type ComponentProps, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../EmptyState';
import { Button } from '../Button';
import { OfflineStateView } from '../OfflineStateView';
import { SearchEmptyRecovery } from '../search/SearchEmptyRecovery';
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
  return status === 'loading' ? (
    loadingContent
  ) : status === 'authors-sync' ? (
    <EmptyState
      size="screen"
      style={styles.listTop}
      title={t('authors.syncNeeded')}
      actions={<Button title={t('authors.retry')} onPress={onRetry} />}
    />
  ) : status === 'error' ? (
    <OfflineStateView reason="error" onRetry={onRetry} effectiveOffline={false} />
  ) : status === 'offline-filter' ? (
    // The glyph carries the same blame as the title: a wifi-slash over "needs
    // our server" would contradict itself. "Needs a signal" is a lie when the
    // phone has four bars and we are the ones who are down, or when the climber
    // chose Offline mode. Literal keys: the i18n linter rejects a computed one.
    <EmptyState
      size="screen"
      style={styles.listTop}
      icon={offlineFilterReason === 'backend_unreachable' ? 'server.unreachable' : 'offline.unavailable'}
      title={
        offlineFilterReason === 'backend_unreachable'
          ? t('mobile.emptyState.offlineFilter.titleServer')
          : offlineFilterReason === 'offline_mode'
            ? t('mobile.emptyState.offlineFilter.titleOfflineMode')
            : t('mobile.emptyState.offlineFilter.title')
      }
      body={t('mobile.emptyState.offlineFilter.subtitle')}
      actions={<Button title={t('mobile.emptyState.offlineFilter.cta')} variant="outlined" onPress={onClearFilters} />}
    />
  ) : status === 'offline-missing' ? (
    <EmptyState
      size="screen"
      style={styles.listTop}
      icon="offline.download"
      title={t('mobile.emptyState.offlineNoCatalog.title')}
      body={t('mobile.emptyState.offlineNoCatalog.subtitle')}
      actions={downloadAction}
    />
  ) : status === 'offline-queued' ? (
    <EmptyState
      size="screen"
      style={styles.listTop}
      icon="offline.download"
      title={t('mobile.emptyState.offlineCatalogQueued.title')}
      body={t('mobile.emptyState.offlineCatalogQueued.subtitle', { name: boardName })}
    />
  ) : status === 'unset-wall' ? (
    <EmptyState
      size="screen"
      style={styles.listTop}
      icon="add"
      title={t('mobile.emptyState.unsetWall.title')}
      body={t('mobile.emptyState.unsetWall.subtitle')}
      actions={
        canCreateClimb ? (
          <Button title={t('mobile.emptyState.unsetWall.cta')} variant="outlined" onPress={onCreate} />
        ) : undefined
      }
    />
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
  // The 120pt the list's empty placards always sat below the header.
  listTop: { paddingTop: 120 },
});
