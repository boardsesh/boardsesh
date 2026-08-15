import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LocationSyncFreezesPanel from '@/app/components/admin/location-sync-freezes-panel';
import LocaleLink from '@/app/components/i18n/locale-link';
import { checkAdmin } from '@/app/lib/admin/check-admin';
import { themeTokens } from '@/app/theme/theme-config';

// Administrative recovery utility: inherited /admin metadata is explicitly
// noindex, and the server gate prevents protected markup from shipping.
export const dynamic = 'force-dynamic';

export default async function AdminLocationSyncPage() {
  const access = await checkAdmin();
  const locale = await getLocale();
  const { t } = await getServerTranslation('admin');

  if (!access.authenticated) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin']}>
        <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="warning">{t('auth.signInRequired')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  if (!access.isAdmin) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin']}>
        <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="error">{t('auth.noAccess')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale} namespaces={['common', 'admin']}>
      <Container
        maxWidth="lg"
        sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)', pb: 'var(--bottom-bar-height)' }}
      >
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 1, color: themeTokens.neutral[800] }}>
          {t('locationSync.title')}
        </Typography>
        <Box sx={{ mb: 3 }}>
          <MuiLink component={LocaleLink} href="/admin" underline="hover" sx={{ color: themeTokens.colors.primary }}>
            {t('locationSync.backToAdmin')}
          </MuiLink>
        </Box>
        <LocationSyncFreezesPanel />
      </Container>
    </I18nProvider>
  );
}
