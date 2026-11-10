'use client';

import React, { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import MuiAlert from '@mui/material/Alert';
import MuiDivider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import {
  buildConnectedAppsSection,
  connectedAppDisconnectPrompt,
  connectedAppDisconnectResult,
  withoutConnectedApp,
  type ConnectedAppRowView,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import {
  DISCONNECT_APP,
  GET_MY_CONNECTED_APPS,
  type DisconnectAppResponse,
  type GetMyConnectedAppsResponse,
} from '@boardsesh/graphql/operations/connected-apps';
import type { ConnectedApps } from '@boardsesh/shared-schema';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { themeTokens } from '@/app/theme/theme-config';

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 hours ago" in the page's language. dayjs's relative time is English-only on the website. */
function relativeTimeFormatter(locale: string, nowMs: number): (iso: string) => string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return (iso) => {
    const seconds = (Date.parse(iso) - nowMs) / 1000;
    for (const [unit, size] of RELATIVE_UNITS) {
      if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    }
    return format.format(0, 'minute');
  };
}

/**
 * Settings › Connected apps on the website (#6981 F16): the apps a climber
 * connected through Boardsesh sign-in, what each can read, and Disconnect, so
 * a connection can be ended from any browser. The words and the show-or-hide
 * rule come from `@boardsesh/connected-apps`, shared with the app.
 */
export default function ConnectedAppsSection() {
  const { t, i18n } = useTranslation('settings');
  const { data: session } = useSession();
  const { token, isAuthenticated } = useWsAuthToken();
  const queryClient = useQueryClient();
  const { showMessage } = useSnackbar();
  const [confirming, setConfirming] = useState<ConnectedAppRowView | null>(null);
  const queryKey = useMemo(() => ['myConnectedApps', session?.user?.id ?? null] as const, [session?.user?.id]);
  const translate = t as ConnectedAppsTranslate;

  const list = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      (
        await createGraphQLHttpClient(token).request<GetMyConnectedAppsResponse>({
          document: GET_MY_CONNECTED_APPS,
          signal,
        })
      ).myConnectedApps,
    enabled: !!token && isAuthenticated,
    retry: false,
  });

  const disconnect = useMutation({
    mutationFn: async (row: ConnectedAppRowView) =>
      createGraphQLHttpClient(token).request<DisconnectAppResponse>(DISCONNECT_APP, {
        connectionId: row.connectionId,
      }),
    onSuccess: (_answer, row) => {
      queryClient.setQueryData<ConnectedApps>(queryKey, (current) =>
        current ? withoutConnectedApp(current, row.connectionId) : current,
      );
      void queryClient.invalidateQueries({ queryKey });
      showMessage(connectedAppDisconnectResult({ name: row.name }, 'disconnected', translate), 'success');
    },
    onError: (_error, row) => {
      showMessage(connectedAppDisconnectResult({ name: row.name }, 'failed', translate), 'error');
    },
    onSettled: () => setConfirming(null),
  });

  const locale = i18n.language;
  const section = useMemo(() => {
    const nowMs = Date.now();
    return buildConnectedAppsSection({
      signedIn: isAuthenticated,
      data: list.data,
      t: translate,
      formatters: {
        date: (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
        relativeTime: relativeTimeFormatter(locale, nowMs),
        nowMs,
      },
    });
  }, [isAuthenticated, list.data, translate, locale]);

  if (section.kind === 'hidden') return null;
  const prompt = confirming ? connectedAppDisconnectPrompt({ name: confirming.name }, translate) : null;

  return (
    <>
      <MuiDivider sx={{ my: 2 }} />
      <Card component="section" aria-labelledby="connected-apps-title">
        <CardContent>
          <Typography id="connected-apps-title" variant="h5" component="h2">
            {t('integrations.title')}
          </Typography>
          <Typography variant="subtitle2" color="text.secondary" component="p" sx={{ mb: 2 }}>
            {section.title}
          </Typography>
          {section.kind === 'empty' ? (
            <Typography variant="body2" color="text.secondary">
              {section.message}
            </Typography>
          ) : (
            <Stack
              component="ul"
              divider={<MuiDivider component="li" aria-hidden />}
              spacing={2}
              sx={{ listStyle: 'none', m: 0, p: 0 }}
            >
              {section.rows.map((row) => (
                <ConnectedAppRow
                  key={row.connectionId}
                  row={row}
                  disconnecting={disconnect.isPending && disconnect.variables?.connectionId === row.connectionId}
                  onDisconnect={() => setConfirming(row)}
                />
              ))}
            </Stack>
          )}
          {section.kind === 'list' ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              {section.footer}
            </Typography>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={confirming !== null}
        onClose={() => (disconnect.isPending ? undefined : setConfirming(null))}
        aria-labelledby="connected-apps-disconnect-title"
      >
        {prompt ? (
          <>
            <DialogTitle id="connected-apps-disconnect-title">{prompt.title}</DialogTitle>
            <DialogContent>
              <DialogContentText>{prompt.message}</DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirming(null)} disabled={disconnect.isPending}>
                {prompt.cancelLabel}
              </Button>
              <Button
                color="error"
                variant="contained"
                disabled={disconnect.isPending}
                startIcon={
                  disconnect.isPending ? <CircularProgress size={16} color="inherit" aria-hidden /> : undefined
                }
                onClick={() => confirming && disconnect.mutate(confirming)}
              >
                {prompt.confirmLabel}
              </Button>
            </DialogActions>
          </>
        ) : null}
      </Dialog>
    </>
  );
}

function ConnectedAppRow({
  row,
  disconnecting,
  onDisconnect,
}: {
  row: ConnectedAppRowView;
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  return (
    <Box component="li" sx={{ listStyle: 'none' }} data-testid={`connected-app-${row.connectionId}`}>
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
        {row.name}
      </Typography>
      {row.publisher ? (
        <Typography variant="body2" color="text.secondary">
          {row.publisher}
        </Typography>
      ) : null}
      <Typography variant="body2" color="text.secondary">
        {`${row.connected} · ${row.lastUsed}`}
      </Typography>
      {row.suspendedNotice ? (
        <MuiAlert severity="warning" sx={{ mt: 1.5 }}>
          {row.suspendedNotice}
        </MuiAlert>
      ) : null}
      <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, mt: 1.5, p: 0 }}>
        {row.scopes.map((scope) => (
          <Box component="li" key={scope.scope} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
            <CheckCircleOutlined aria-hidden sx={{ color: themeTokens.colors.primary, fontSize: 20, mt: '1px' }} />
            <Box>
              <Typography variant="body2">{scope.label}</Typography>
              {scope.notes.map((note) => (
                <Typography key={note} variant="body2" color="text.secondary">
                  {note}
                </Typography>
              ))}
            </Box>
          </Box>
        ))}
      </Stack>
      <Button
        color="error"
        variant="outlined"
        size="small"
        sx={{ mt: 2 }}
        disabled={disconnecting}
        aria-label={row.disconnectAccessibilityLabel}
        onClick={onDisconnect}
      >
        {row.disconnectLabel}
      </Button>
    </Box>
  );
}
