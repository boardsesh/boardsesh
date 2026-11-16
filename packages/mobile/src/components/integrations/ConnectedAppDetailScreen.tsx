import {
  buildConnectedAppDetail,
  connectedAppDisconnectPrompt,
  connectedAppDisconnectResult,
  type ConnectedAppDetailView,
  type ConnectedAppRowView,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDisconnectApp, useMyConnectedApps } from '../../lib/graphql/hooks/use-connected-apps';
import { useAuth } from '../../providers/auth-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { ConnectedAppDetailPageView, type ConnectedAppDetailPageViewProps } from './ConnectedAppDetailPageView';
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

export function ConnectedAppDetailPage(props: Omit<ConnectedAppDetailPageViewProps, 'scrollBottomPadding'>) {
  const { scrollBottomPadding } = useBottomChromeMetrics();
  return (
    <>
      <Stack.Screen options={{ title: props.detail.kind === 'app' ? props.detail.row.name : '' }} />
      <ConnectedAppDetailPageView {...props} scrollBottomPadding={scrollBottomPadding} />
    </>
  );
}
