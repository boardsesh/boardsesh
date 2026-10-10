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
import SprayTrainingPanel from '@/app/components/admin/spray-training-panel';
import LocaleLink from '@/app/components/i18n/locale-link';

// Server-rendered so access is enforced before any markup ships. A `spray`-scoped
// admin passes here as well as a global one; the backend queue applies the same rule.
export const dynamic = 'force-dynamic';

export default async function AdminSprayWallsPage() {
  const access = await checkAdmin({ boardType: 'spray' });
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
    // `boardScopedOnly` is true for any board-scoped admin role this check did
    // not accept. Here that can only be an admin of another board (a spray or
    // global admin has `isAdmin`), which is who the spray-specific message is for.
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin']}>
        <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="error">{t(access.boardScopedOnly ? 'sprayTraining.noAccess' : 'auth.noAccess')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale} namespaces={['common', 'admin']}>
      <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 1, color: themeTokens.neutral[800] }}>
          {t('sprayTraining.title')}
        </Typography>
        {access.hasGlobalAdmin && (
          <Box sx={{ mb: 3 }}>
            <MuiLink component={LocaleLink} href="/admin" underline="hover" sx={{ color: themeTokens.colors.primary }}>
              {t('sprayTraining.backToAdmin')}
            </MuiLink>
          </Box>
        )}
        <SprayTrainingPanel />
      </Container>
    </I18nProvider>
  );
}
