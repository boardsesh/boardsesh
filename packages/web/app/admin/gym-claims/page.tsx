import React from 'react';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import MuiLink from '@mui/material/Link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { checkAdmin } from '@/app/lib/admin/check-admin';
import { themeTokens } from '@/app/theme/theme-config';
import GymClaimsPanel from '@/app/components/admin/gym-claims-panel';
import LocaleLink from '@/app/components/i18n/locale-link';

// Server-rendered so admin access is enforced before any markup ships — matching
// /admin/retention. The GraphQL mutations are already admin-gated on the backend,
// so this is defense-in-depth, but it keeps the whole /admin subtree consistent.
export const dynamic = 'force-dynamic';

export default async function AdminGymClaimsPage() {
  const access = await checkAdmin();
  const locale = await getLocale();
  const { t } = await getServerTranslation('admin');

  if (!access.authenticated) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin']}>
        <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="warning">{t('auth.signInRequired')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  if (!access.isAdmin) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin']}>
        <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="error">{t('auth.noAccess')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale} namespaces={['common', 'admin']}>
      <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 1, color: themeTokens.neutral[800] }}>
          {t('gymClaims.title')}
        </Typography>
        <Box sx={{ mb: 3 }}>
          <MuiLink component={LocaleLink} href="/admin" underline="hover" sx={{ color: themeTokens.colors.primary }}>
            {t('gymClaims.backToAdmin')}
          </MuiLink>
        </Box>
        <GymClaimsPanel />
      </Container>
    </I18nProvider>
  );
}
