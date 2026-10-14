import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { IntegrationStatus } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Button } from '../Button';
import { ListRow } from '../ListRow';
import { SwitchRow } from '../SwitchRow';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { connectStrava } from '../../lib/integrations';
import { useDisconnectIntegration, useIntegrationStatuses, useSetIntegrationAutoSync } from '../../lib/graphql/hooks';
import { STRAVA_ORANGE } from './strava-brand';

function findStravaStatus(statuses: IntegrationStatus[] | undefined): IntegrationStatus | undefined {
  return statuses?.find((status) => status.provider === 'STRAVA');
}

export function StravaCard() {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { data: statuses, isLoading, refetch } = useIntegrationStatuses();
  // Destructure .mutate (stable across renders per React Query) — the
  // mutation object itself is a fresh reference every render and would churn
  // the useCallback identities below.
  const { mutate: setAutoSyncMutate } = useSetIntegrationAutoSync();
  const { mutate: disconnectIntegrationMutate } = useDisconnectIntegration();
  const [connecting, setConnecting] = useState(false);

  const strava = findStravaStatus(statuses);

  const handleConnect = useCallback(() => {
    setConnecting(true);
    void (async () => {
      try {
        const result = await connectStrava();
        // Refresh status regardless of outcome so the card reflects a
        // connection that landed even if the result came back ambiguous.
        await refetch();
        if (result === 'connected') {
          showToast(t('integrations.toast.connected'), 'success');
        } else if (result === 'error') {
          showToast(t('integrations.toast.connectFailed'), 'error');
        }
        // 'cancelled' is a deliberate user choice — no toast.
      } finally {
        setConnecting(false);
      }
    })();
  }, [refetch, showToast, t]);

  const handleAutoSyncChange = useCallback(
    (enabled: boolean) => {
      // The mutation hook owns the optimistic cache update.
      setAutoSyncMutate({ provider: 'STRAVA', enabled });
    },
    [setAutoSyncMutate],
  );

  const handleDisconnect = useCallback(async () => {
    const confirmed = await confirm({
      title: t('integrations.strava.disconnectConfirmTitle'),
      message: t('integrations.strava.disconnectConfirmBody'),
      confirmLabel: t('integrations.strava.disconnect'),
      cancelLabel: tCommon('actions.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    disconnectIntegrationMutate(
      { provider: 'STRAVA' },
      {
        onSuccess: () => {
          showToast(t('integrations.toast.disconnected'), 'success');
        },
        onError: () => {
          // The card stays in its connected state (statuses are only
          // invalidated on success) — tell the user the tap did nothing.
          showToast(t('integrations.toast.disconnectFailed'), 'error');
        },
      },
    );
  }, [confirm, disconnectIntegrationMutate, showToast, t, tCommon]);

  const cardBackground = { backgroundColor: systemColors.secondaryGroupedBackground };

  if (isLoading && !strava) {
    return (
      <View style={[styles.card, styles.loadingCard, cardBackground]}>
        <ActivityIndicator color={brandColors.primary} />
      </View>
    );
  }

  if (!strava?.connected) {
    return (
      <>
        <View style={[styles.card, styles.paddedCard, cardBackground]}>
          {/* TODO: replace with official "Connect with Strava" brand asset (Strava brand guidelines) */}
          <Button
            title={t('integrations.strava.connect')}
            variant="filled"
            tintColor={STRAVA_ORANGE}
            onPress={handleConnect}
            disabled={connecting}
            loading={connecting}
          />
        </View>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footer}>
          {t('integrations.strava.autoSyncDescription')}
        </Text>
      </>
    );
  }

  const accountLabel = strava.externalAccountName
    ? t('integrations.strava.connectedAs', { name: strava.externalAccountName })
    : t('integrations.strava.connected');
  const needsReconnect = strava.status === 'expired' || strava.status === 'revoked';

  return (
    <>
      <View style={[styles.card, cardBackground]}>
        <ListRow title={accountLabel} showSeparator />
        <SwitchRow
          label={t('integrations.strava.autoSync')}
          value={strava.autoSyncEnabled}
          onValueChange={handleAutoSyncChange}
        />
        {needsReconnect ? (
          <View style={styles.reconnectBlock}>
            <Button
              title={t('integrations.strava.reconnect')}
              variant="filled"
              tintColor={STRAVA_ORANGE}
              onPress={handleConnect}
              disabled={connecting}
              loading={connecting}
            />
          </View>
        ) : null}
      </View>
      {/* The expiry is what the climber needs to act on, so it leads the footer. */}
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footer}>
        {needsReconnect
          ? `${t('integrations.strava.expired')}\n\n${t('integrations.strava.autoSyncDescription')}`
          : t('integrations.strava.autoSyncDescription')}
      </Text>
      {/* Disconnect is its own row in its own card, so a destructive action never
          shares a card with the switch it would turn off. */}
      <View style={[styles.card, styles.disconnectCard, cardBackground]}>
        <Button
          title={t('integrations.strava.disconnect')}
          variant="text"
          role="destructive"
          onPress={handleDisconnect}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
  },
  loadingCard: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[6],
  },
  paddedCard: {
    padding: spacing[4],
  },
  reconnectBlock: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  disconnectCard: {
    marginTop: spacing[4],
    alignItems: 'flex-start',
    paddingHorizontal: spacing[2],
  },
});
