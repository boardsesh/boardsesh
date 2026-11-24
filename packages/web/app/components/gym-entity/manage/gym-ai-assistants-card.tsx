'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import { GET_MY_CONNECTED_APPS, type GetMyConnectedAppsResponse } from '@boardsesh/graphql/operations/connected-apps';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useBrowserSession } from '@/app/components/providers/session-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { themeTokens } from '@/app/theme/theme-config';

/** Uses the same account-scoped cache as Settings, including disconnect invalidation. */
export default function GymAiAssistantsCard({ invitationRequired = false }: { invitationRequired?: boolean }) {
  const { t } = useTranslation('kiosk');
  const { data: session } = useBrowserSession();
  const { token } = useWsAuthToken();
  const connections = useQuery({
    queryKey: ['myConnectedApps', session?.user?.id ?? null],
    queryFn: async ({ signal }) =>
      (
        await createGraphQLHttpClient(token).request<GetMyConnectedAppsResponse>({
          document: GET_MY_CONNECTED_APPS,
          signal,
        })
      ).myConnectedApps,
    enabled: !!token && !!session?.user?.id,
    retry: false,
    throwOnError: false,
  });
  const gymConnections = connections.data?.apps.filter((app) => app.scopes.some((scope) => scope.startsWith('gyms:')));
  const connectionStatus = connections.isError
    ? t('manage.aiAssistants.statusUnavailable')
    : gymConnections === undefined
      ? t('manage.aiAssistants.checking')
      : gymConnections.some((app) => !app.suspended)
        ? t('manage.aiAssistants.connected')
        : gymConnections.length > 0
          ? t('manage.aiAssistants.paused')
          : t('manage.aiAssistants.notConnected');

  return (
    <Card variant="outlined" component="section" aria-labelledby="gym-ai-assistants-title">
      <CardContent>
        <Typography
          id="gym-ai-assistants-title"
          component="h2"
          variant="subtitle1"
          sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}
        >
          {t('manage.aiAssistants.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {invitationRequired ? t('manage.aiAssistants.pilotBody') : t('manage.aiAssistants.body')}
        </Typography>
        <Typography variant="body2" color="text.secondary" role="status" sx={{ mt: 1 }}>
          {connectionStatus}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 1.5 }}>
          <Button component={LocaleLink} href="/developers/gym-mcp" variant="outlined" size="small">
            {invitationRequired ? t('manage.aiAssistants.pilotDetails') : t('manage.aiAssistants.connect')}
          </Button>
          <Button component={LocaleLink} href="/settings" size="small">
            {t('manage.aiAssistants.connections')}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
