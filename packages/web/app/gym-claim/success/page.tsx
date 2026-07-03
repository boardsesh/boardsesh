import React from 'react';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutline';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import LocaleLink from '@/app/components/i18n/locale-link';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('boards');
  return createNoIndexMetadata({
    title: t('claimLanding.success.title'),
    description: t('claimLanding.success.body'),
    path: '/gym-claim/success',
    locale,
  });
}

export default async function GymClaimSuccessPage() {
  const locale = await getLocale();
  const { t } = await getServerTranslation('boards');

  return (
    <I18nProvider locale={locale} namespaces={['common', 'boards']}>
      <Container maxWidth="sm" sx={{ py: 8, pt: 'calc(var(--global-header-height) + 48px)', textAlign: 'center' }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <CheckCircleOutlined color="success" sx={{ fontSize: 56 }} />
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {t('claimLanding.success.title')}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {t('claimLanding.success.body')}
          </Typography>
          <MuiLink component={LocaleLink} href="/" underline="hover">
            {t('claimLanding.backHome')}
          </MuiLink>
        </Box>
      </Container>
    </I18nProvider>
  );
}
