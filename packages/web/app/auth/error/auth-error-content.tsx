'use client';

import React from 'react';
import MuiAlert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import CancelOutlined from '@mui/icons-material/CancelOutlined';
import { useSearchParams } from 'next/navigation';
import { useBrowserSession } from '@/app/components/providers/session-provider';
import { useTranslation } from 'react-i18next';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';
import { getAuthErrorMessage } from './get-error-message';

type AuthErrorContentProps = {
  /**
   * Set when this error ended a forced re-sign-in of this browser's account
   * (#7655 item 6): the path the climber was confirming for.
   */
  reauthenticationReturnTo?: string;
};

export default function AuthErrorContent({ reauthenticationReturnTo }: AuthErrorContentProps = {}) {
  const { t } = useTranslation('auth');
  const searchParams = useSearchParams();
  const error = searchParams.get('error');
  const { data: session } = useBrowserSession();
  const signedInEmail = session?.user?.email;
  // A sign-in that would have made a second account while signed in (#7596 B5e1).
  const linkRequired = error === 'OAuthLinkRequired';
  const reauthenticating = linkRequired && reauthenticationReturnTo !== undefined;
  const message = reauthenticating
    ? t('error.linkRequiredReauthenticating')
    : linkRequired && signedInEmail
      ? t('error.linkRequiredSignedInAs', { email: signedInEmail })
      : getAuthErrorMessage(error, t);
  const retryHref = reauthenticating
    ? `/auth/reauthenticate?${new URLSearchParams({ callbackUrl: reauthenticationReturnTo }).toString()}`
    : undefined;

  return (
    <Box sx={{ minHeight: '100vh', background: 'var(--semantic-background)' }}>
      <Box
        component="header"
        sx={{
          background: 'var(--semantic-surface)',
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          boxShadow: themeTokens.shadows.xs,
          height: 64,
        }}
      >
        <BackButton />
        <Logo size="sm" showText={false} />
        <Typography variant="h4" sx={{ margin: 0, flex: 1 }}>
          {t('error.header')}
        </Typography>
      </Box>

      <Box
        component="main"
        sx={{
          padding: '24px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          paddingTop: '48px',
        }}
      >
        <Card sx={{ width: '100%', maxWidth: 400, textAlign: 'center' }}>
          <CardContent>
            <Stack spacing={3} sx={{ width: '100%' }}>
              <CancelOutlined sx={{ fontSize: 48, color: 'var(--color-error)', mx: 'auto' }} />
              <Typography variant="h3">{t('error.title')}</Typography>
              <MuiAlert severity="error">{message}</MuiAlert>
              {retryHref ? (
                <Button variant="contained" component={LocaleLink} href={retryHref} fullWidth size="large">
                  {t('error.tryAgain')}
                </Button>
              ) : linkRequired && signedInEmail ? (
                <Button variant="contained" component={LocaleLink} href="/settings" fullWidth size="large">
                  {t('error.openSettings')}
                </Button>
              ) : (
                <Button variant="contained" href="/auth/login" fullWidth size="large">
                  {t('error.back')}
                </Button>
              )}
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
