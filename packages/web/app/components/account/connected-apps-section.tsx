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
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import MuiAlert from '@mui/material/Alert';
import MuiDivider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ChevronRightOutlined from '@mui/icons-material/ChevronRightOutlined';
import LinkOutlined from '@mui/icons-material/LinkOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import {
  buildConnectedAppDetail,
  buildConnectedAppsSection,
  connectedAppDisconnectPrompt,
  connectedAppDisconnectResult,
  withoutConnectedApp,
  type ConnectedAppRowView,
  type ConnectedAppsFormatters,
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
 * connected through Boardsesh sign-in, so a connection can be ended from any
 * browser. Like the app: one row per app with its last use, each opening the
 * app's detail (what it can see, when it connected, Disconnect). The words and
 * the show-or-hide rule come from `@boardsesh/connected-apps`, shared with the app.
 */
export default function ConnectedAppsSection() {
  const { t, i18n } = useTranslation('settings');
  const { data: session } = useSession();
  const { token, isAuthenticated } = useWsAuthToken();
  const queryClient = useQueryClient();
  const { showMessage } = useSnackbar();
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
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

  const close = () => {
    setOpenId(null);
    setConfirming(false);
  };

  const disconnect = useMutation({
    mutationFn: async (row: ConnectedAppRowView) =>
      createGraphQLHttpClient(token).request<DisconnectAppResponse>(DISCONNECT_APP, {
        connectionId: row.connectionId,
      }),
    onSuccess: (_answer, row) => {
      close();
      queryClient.setQueryData<ConnectedApps>(queryKey, (current) =>
        current ? withoutConnectedApp(current, row.connectionId) : current,
      );
      void queryClient.invalidateQueries({ queryKey });
      showMessage(connectedAppDisconnectResult({ name: row.name }, 'disconnected', translate), 'success');
    },
    onError: (_error, row) => {
      setConfirming(false);
      showMessage(connectedAppDisconnectResult({ name: row.name }, 'failed', translate), 'error');
    },
  });

  const locale = i18n.language;
  const formatters = useMemo<ConnectedAppsFormatters>(() => {
    const nowMs = Date.now();
    return {
      date: (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
      relativeTime: relativeTimeFormatter(locale, nowMs),
      nowMs,
    };
  }, [locale]);
  const section = useMemo(
    () => buildConnectedAppsSection({ signedIn: isAuthenticated, data: list.data, t: translate, formatters }),
    [isAuthenticated, list.data, translate, formatters],
  );
  const detail = useMemo(
    () =>
      openId === null
        ? null
        : buildConnectedAppDetail({
            signedIn: isAuthenticated,
            data: list.data,
            connectionId: openId,
            t: translate,
            formatters,
          }),
    [openId, isAuthenticated, list.data, translate, formatters],
  );

  if (section.kind === 'hidden') return null;
  const shownApp = detail?.kind === 'app' ? detail : null;
  const prompt = shownApp ? connectedAppDisconnectPrompt({ name: shownApp.row.name }, translate) : null;

  return (
    <>
      <MuiDivider sx={{ my: 2 }} />
      <Card component="section" aria-labelledby="connected-apps-title">
        <CardContent>
          <Typography id="connected-apps-title" variant="h5" component="h2">
            {t('integrations.title')}
          </Typography>
          <Typography variant="subtitle2" color="text.secondary" component="p" sx={{ mb: 1 }}>
            {section.title}
          </Typography>
          {section.kind === 'empty' ? (
            <Typography variant="body2" color="text.secondary">
              {section.message}
            </Typography>
          ) : (
            <List disablePadding>
              {section.rows.map((row, index) => (
                <ListItem key={row.connectionId} disablePadding divider={index < section.rows.length - 1}>
                  <ListItemButton
                    onClick={() => setOpenId(row.connectionId)}
                    data-testid={`connected-app-${row.connectionId}`}
                    sx={{ px: 1, borderRadius: themeTokens.borderRadius.md }}
                  >
                    <ListItemIcon sx={{ minWidth: 40 }}>
                      {row.suspendedNotice ? (
                        <WarningAmberOutlined aria-hidden sx={{ color: themeTokens.colors.warning }} />
                      ) : (
                        <LinkOutlined aria-hidden />
                      )}
                    </ListItemIcon>
                    <ListItemText primary={row.name} secondary={row.summary} />
                    <ChevronRightOutlined aria-hidden sx={{ color: 'text.secondary' }} />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={shownApp !== null}
        onClose={() => (disconnect.isPending ? undefined : close())}
        aria-labelledby="connected-app-dialog-title"
        fullWidth
        maxWidth="sm"
      >
        {shownApp && prompt && confirming ? (
          <>
            <DialogTitle id="connected-app-dialog-title">{prompt.title}</DialogTitle>
            <DialogContent>
              <DialogContentText>{prompt.message}</DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirming(false)} disabled={disconnect.isPending}>
                {prompt.cancelLabel}
              </Button>
              <Button
                color="error"
                variant="contained"
                disabled={disconnect.isPending}
                startIcon={
                  disconnect.isPending ? <CircularProgress size={16} color="inherit" aria-hidden /> : undefined
                }
                onClick={() => disconnect.mutate(shownApp.row)}
              >
                {prompt.confirmLabel}
              </Button>
            </DialogActions>
          </>
        ) : null}
        {shownApp && !confirming ? (
          <>
            <DialogTitle id="connected-app-dialog-title">{shownApp.row.name}</DialogTitle>
            <DialogContent>
              <ConnectedAppDetail row={shownApp.row} scopesHeading={shownApp.scopesHeading} />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                {shownApp.footer}
              </Typography>
            </DialogContent>
            <DialogActions sx={{ justifyContent: 'space-between' }}>
              <Button
                color="error"
                variant="outlined"
                aria-label={shownApp.row.disconnectAccessibilityLabel}
                onClick={() => setConfirming(true)}
              >
                {shownApp.row.disconnectLabel}
              </Button>
              <Button onClick={close}>{t('integrations.partnerApps.close')}</Button>
            </DialogActions>
          </>
        ) : null}
      </Dialog>
    </>
  );
}

function ConnectedAppDetail({ row, scopesHeading }: { row: ConnectedAppRowView; scopesHeading: string }) {
  return (
    <Box data-testid={`connected-app-detail-${row.connectionId}`}>
      {row.publisher ? (
        <Typography variant="body2" color="text.secondary">
          {row.publisher}
        </Typography>
      ) : null}
      <Typography variant="body2" color="text.secondary">
        {row.connected}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {row.lastUsed}
      </Typography>
      {row.suspendedNotice ? (
        <MuiAlert severity="warning" sx={{ mt: 1.5 }}>
          {row.suspendedNotice}
        </MuiAlert>
      ) : null}
      <Typography
        variant="subtitle2"
        component="h3"
        sx={{ mt: 2.5, mb: 1, fontWeight: themeTokens.typography.fontWeight.semibold }}
      >
        {scopesHeading}
      </Typography>
      <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }}>
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
    </Box>
  );
}
