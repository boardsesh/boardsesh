import React from 'react';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import LocaleLink from '@/app/components/i18n/locale-link';

export const dynamic = 'force-dynamic';

// Static-literal lookup: the i18n linter forbids t(variable)/t(template).
function reasonMessage(t: (key: string) => string, reason: string | undefined): string {
  switch (reason) {
    case 'expired':
      return t('claimLanding.error.reasons.expired');
    case 'used':
      return t('claimLanding.error.reasons.used');
    case 'superseded':
      return t('claimLanding.error.reasons.superseded');
    case 'server_error':
      return t('claimLanding.error.reasons.serverError');
    default:
      return t('claimLanding.error.reasons.invalid');
  }
}

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('boards');
  return createNoIndexMetadata({
    title: t('claimLanding.error.title'),
    description: t('claimLanding.error.reasons.invalid'),
    path: '/gym-claim/error',
    locale,
  });
}

export default async function GymClaimErrorPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const locale = await getLocale();
  const { t } = await getServerTranslation('boards');
  const { reason } = await searchParams;

  return (
    <I18nProvider locale={locale} namespaces={['common', 'boards']}>
      <Container maxWidth="sm" sx={{ py: 8, pt: 'calc(var(--global-header-height) + 48px)', textAlign: 'center' }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <ErrorOutline color="error" sx={{ fontSize: 56 }} />
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {t('claimLanding.error.title')}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {reasonMessage(t, reason)}
          </Typography>
          <MuiLink component={LocaleLink} href="/" underline="hover">
            {t('claimLanding.backHome')}
          </MuiLink>
        </Box>
      </Container>
    </I18nProvider>
  );
}
