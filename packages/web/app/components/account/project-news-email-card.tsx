'use client';

import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import {
  GET_MY_PROJECT_NEWS_EMAIL_CONSENT,
  SET_PROJECT_NEWS_EMAIL_CONSENT,
  type GetMyProjectNewsEmailConsentResponse,
  type SetProjectNewsEmailConsentResponse,
  type SetProjectNewsEmailConsentVariables,
} from '@boardsesh/graphql/operations/project-news-email';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { executeGraphQL } from '@/app/lib/graphql/client';

/**
 * "Email me project news", the same switch the app has under Settings, Account.
 * Off until the climber turns it on; see docs/project-news-email.md.
 */
export default function ProjectNewsEmailCard() {
  const { t } = useTranslation('settings');
  const { data: session, status } = useSession();
  const userId = status === 'authenticated' ? (session?.user.id ?? null) : null;
  const { token } = useWsAuthToken(userId !== null);
  const queryClient = useQueryClient();
  const queryKey = ['projectNewsEmailConsent', userId];

  const consent = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await executeGraphQL<GetMyProjectNewsEmailConsentResponse>(
        GET_MY_PROJECT_NEWS_EMAIL_CONSENT,
        undefined,
        token,
      );
      return response.myProjectNewsEmailConsent;
    },
    enabled: userId !== null && !!token,
  });

  const save = useMutation({
    mutationFn: async (subscribed: boolean) => {
      const response = await executeGraphQL<SetProjectNewsEmailConsentResponse, SetProjectNewsEmailConsentVariables>(
        SET_PROJECT_NEWS_EMAIL_CONSENT,
        { input: { subscribed, source: 'web' } },
        token,
      );
      return response.setProjectNewsEmailConsent;
    },
    onSuccess: (saved) => queryClient.setQueryData(queryKey, saved),
  });

  const checked = save.isPending ? save.variables : (consent.data?.subscribed ?? false);

  return (
    <Card>
      <CardContent>
        <Typography variant="h5">{t('projectNews.sectionTitle')}</Typography>
        <FormControlLabel
          sx={{ mt: 1 }}
          control={
            <Switch
              checked={checked}
              disabled={!consent.data || save.isPending}
              onChange={(event) => {
                save.reset();
                save.mutate(event.target.checked);
              }}
            />
          }
          label={t('projectNews.toggle')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('projectNews.description')}
        </Typography>
        {consent.isError && !consent.data && (
          <Typography variant="body2" color="error" role="alert" sx={{ mt: 1 }}>
            {t('projectNews.loadFailed')}
          </Typography>
        )}
        {save.isError && (
          <Typography variant="body2" color="error" role="alert" sx={{ mt: 1 }}>
            {t('projectNews.saveFailed')}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
