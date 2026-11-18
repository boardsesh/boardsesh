import React from 'react';
import Alert from '@mui/material/Alert';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import PartnerAppsPanel from '@/app/components/admin/partner-apps-panel';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { checkAdmin } from '@/app/lib/admin/check-admin';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { themeTokens } from '@/app/theme/theme-config';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('admin');
  return createNoIndexMetadata({
    title: t('partnerApps.title'),
    description: t('partnerApps.description'),
    path: '/admin/partner-apps',
    locale,
  });
}

export default async function AdminPartnerAppsPage() {
  const access = await checkAdmin();
  const { t, locale } = await getServerTranslation('admin');
  return (
    <I18nProvider locale={locale} namespaces={['common', 'admin']}>
      <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        {!access.authenticated ? (
          <Alert severity="warning">{t('auth.signInRequired')}</Alert>
        ) : !access.hasGlobalAdmin ? (
          <Alert severity="error">{t(access.boardScopedOnly ? 'auth.boardScopedNoAccess' : 'auth.noAccess')}</Alert>
        ) : (
          <>
            <Typography component="h1" variant="h5" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
              {t('partnerApps.title')}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1, mb: 2 }}>
              {t('partnerApps.description')}
            </Typography>
            <PartnerAppsPanel />
          </>
        )}
      </Container>
    </I18nProvider>
  );
}
