import { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  buildConnectedAppDetail,
  connectedAppDisconnectPrompt,
  connectedAppDisconnectResult,
  type ConnectedAppDetailView,
  type ConnectedAppRowView,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useAuth } from '../../providers/auth-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useDisconnectApp, useMyConnectedApps } from '../../lib/graphql/hooks/use-connected-apps';
import { borderRadius, spacing } from '../../theme/tokens';
import { useConnectedAppsFormatters } from './PartnerAppsSection';

/**
 * Settings › Connected apps › an app (#6981 F16): what it can see, the
 * unlisted-climbs line under the logbook (#7387), when it connected and was last
 * used, and Disconnect. A pushed settings page, like Board look's leaves: a
 * destination one tap down a list, with Back. Reads the list Connected apps
 * already fetched, so opening it costs no request.
 */
export function ConnectedAppDetailScreen() {
  const { t } = useTranslation('settings');
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { isAuthenticated } = useAuth();
  const { data, isError, refetch } = useMyConnectedApps();
  const formatters = useConnectedAppsFormatters();
  const router = useRouter();

  const detail = useMemo(
    () =>
      buildConnectedAppDetail({
        signedIn: isAuthenticated,
        data,
        connectionId: typeof id === 'string' ? id : '',
        // A cold deep link whose first load failed: say so, with a retry, never an endless spinner.
        loadFailed: isError,
        t: t as ConnectedAppsTranslate,
        formatters,
      }),
    [isAuthenticated, data, id, isError, t, formatters],
  );
  const retry = useCallback(() => void refetch(), [refetch]);

  // Once Disconnect succeeds the row leaves the list at once; keep drawing the
  // app while the page slides away instead of flashing "not connected".
  const shown = useRef<ConnectedAppDetailView | null>(null);
  const [leaving, setLeaving] = useState(false);
  if (detail.kind === 'app') shown.current = detail;
  const visible = leaving && shown.current ? shown.current : detail;

  const leave = useCallback(() => {
    setLeaving(true);
    if (router.canGoBack()) router.back();
  }, [router]);
  const { disconnect, disconnecting } = usePartnerAppDisconnect(leave);

  return (
    <ConnectedAppDetailPage detail={visible} onDisconnect={disconnect} disconnecting={disconnecting} onRetry={retry} />
  );
}

/** Confirm, then end the connection and say how it went. `onDisconnected` leaves the page. */
export function usePartnerAppDisconnect(onDisconnected: () => void) {
  const { t } = useTranslation('settings');
  const confirm = useConfirm();
  const { showToast } = useToast();
  const { mutate } = useDisconnectApp();
  const [disconnecting, setDisconnecting] = useState(false);
  const translate = t as ConnectedAppsTranslate;

  const disconnect = useCallback(
    async (row: ConnectedAppRowView) => {
      const prompt = connectedAppDisconnectPrompt({ name: row.name }, translate);
      const confirmed = await confirm({ ...prompt, destructive: true });
      if (!confirmed) return;
      setDisconnecting(true);
      mutate(
        { connectionId: row.connectionId },
        {
          onSuccess: () => {
            showToast(connectedAppDisconnectResult({ name: row.name }, 'disconnected', translate), 'success');
            onDisconnected();
          },
          onError: () => showToast(connectedAppDisconnectResult({ name: row.name }, 'failed', translate), 'error'),
          onSettled: () => setDisconnecting(false),
        },
      );
    },
    [confirm, mutate, showToast, translate, onDisconnected],
  );

  return { disconnect, disconnecting };
}

type ConnectedAppDetailPageProps = {
  detail: ConnectedAppDetailView;
  onDisconnect: (row: ConnectedAppRowView) => void;
  disconnecting: boolean;
  /** Loads the list again after a failed first load. */
  onRetry: () => void;
};

export function ConnectedAppDetailPage({ detail, onDisconnect, disconnecting, onRetry }: ConnectedAppDetailPageProps) {
  const { systemColors, brandColors } = useTheme();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const pageStyle = { backgroundColor: systemColors.groupedBackground };
  const cardBackground = { backgroundColor: systemColors.secondaryGroupedBackground };
  const handleDisconnect = useCallback(() => {
    if (detail.kind === 'app') onDisconnect(detail.row);
  }, [detail, onDisconnect]);

  if (detail.kind === 'loading') {
    return (
      <View style={[styles.page, styles.centered, pageStyle]}>
        <Stack.Screen options={{ title: '' }} />
        <ActivityIndicator />
      </View>
    );
  }
  if (detail.kind === 'error') {
    return (
      <View style={[styles.page, styles.centered, pageStyle]}>
        <Stack.Screen options={{ title: '' }} />
        <Text variant="body" color={systemColors.secondaryLabel} style={styles.message}>
          {detail.message}
        </Text>
        <Button title={detail.retryLabel} variant="outlined" size="small" onPress={onRetry} />
      </View>
    );
  }
  if (detail.kind === 'gone') {
    return (
      <View style={[styles.page, pageStyle]}>
        <Stack.Screen options={{ title: '' }} />
        <Text variant="body" color={systemColors.secondaryLabel} style={styles.message}>
          {detail.message}
        </Text>
      </View>
    );
  }

  const { row } = detail;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={pageStyle}
      contentContainerStyle={[styles.container, { paddingBottom: scrollBottomPadding + spacing[4] }]}
      testID="connected-app-detail"
    >
      <Stack.Screen options={{ title: row.name }} />

      <View style={[styles.card, styles.paddedCard, cardBackground]}>
        <Text variant="title3">{row.name}</Text>
        {row.publisher ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {row.publisher}
          </Text>
        ) : null}
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.when}>
          {row.connected}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {row.lastUsed}
        </Text>
        {row.suspendedNotice ? (
          <View style={[styles.notice, { backgroundColor: systemColors.tertiaryGroupedBackground }]}>
            <Icon name="warning" size={18} color={brandColors.warning} />
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.noticeText}>
              {row.suspendedNotice}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.section}>
        <SectionHeader title={detail.scopesHeading} />
        <View style={[styles.card, styles.paddedCard, styles.scopes, cardBackground]}>
          {row.scopes.map((scope) => (
            <View key={scope.scope} style={styles.scopeRow}>
              <Icon name="check.small" size={16} color={brandColors.primary} />
              <View style={styles.scopeText}>
                <Text variant="body">{scope.label}</Text>
                {scope.notes.map((note) => (
                  <Text key={note} variant="footnote" color={systemColors.secondaryLabel}>
                    {note}
                  </Text>
                ))}
              </View>
            </View>
          ))}
        </View>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footer}>
          {detail.footer}
        </Text>
      </View>

      {/* Disconnect in a card of its own, like Strava's, so the destructive action stands apart. */}
      <View style={[styles.card, styles.disconnectCard, cardBackground]}>
        <Button
          title={row.disconnectLabel}
          accessibilityLabel={row.disconnectAccessibilityLabel}
          variant="text"
          role="destructive"
          loading={disconnecting}
          disabled={disconnecting}
          onPress={handleDisconnect}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: {
    padding: spacing[4],
  },
  container: {
    width: '100%',
    maxWidth: 672,
    alignSelf: 'center',
    flexGrow: 1,
    paddingTop: spacing[4],
  },
  section: {
    marginTop: spacing[6],
  },
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
  },
  paddedCard: {
    padding: spacing[4],
  },
  when: {
    marginTop: spacing[2],
  },
  notice: {
    marginTop: spacing[3],
    borderRadius: borderRadius.md,
    padding: spacing[3],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  noticeText: {
    flex: 1,
  },
  scopes: {
    gap: spacing[3],
  },
  scopeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  scopeText: {
    flex: 1,
    gap: 2,
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  disconnectCard: {
    marginTop: spacing[6],
    alignItems: 'flex-start',
    paddingHorizontal: spacing[2],
  },
});
