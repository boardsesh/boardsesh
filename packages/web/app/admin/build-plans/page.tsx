import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import BuildPlansPanel from '@/app/components/admin/build-plans-panel';
import LocaleLink from '@/app/components/i18n/locale-link';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { fetchCncCatalog } from '@/app/build-plans/build-plans-page';
import { checkAdmin } from '@/app/lib/admin/check-admin';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';

/**
 * Every build-pack order, for support and for requeueing a failed pack.
 *
 * Server-rendered so admin access is enforced before any markup ships, matching
 * the rest of `/admin`. `adminCncOrders` and `regenerateCncPack` are both
 * `requireAdmin` on the backend, so this gate is defence in depth — but it is
 * also what stops a non-admin seeing a table of other people's email addresses
 * flash up before the query is refused.
 *
 * Deliberately NOT behind the `cnc-packs` flag. The flag decides whether the
 * shop is open to the public; orders that already exist still have to be
 * supportable if it is turned back off, and an operator locked out of the queue
 * by a rollout percentage is exactly the wrong failure. `/admin` is noindex
 * through the layout's `createNoIndexMetadata`, so nothing here is indexable
 * either way.
 *
 * The catalogue is fetched here rather than in the panel: it is the same cached,
 * public read the shop page makes, and it is only used to turn a size id into a
 * wall label.
 */
export const dynamic = 'force-dynamic';

export default async function AdminBuildPlansPage() {
  const access = await checkAdmin();
  const locale = await getLocale();
  const { t } = await getServerTranslation('admin');

  if (!access.authenticated) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin', 'cnc']}>
        <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="warning">{t('auth.signInRequired')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  if (!access.isAdmin) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin', 'cnc']}>
        <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="error">{t(access.boardScopedOnly ? 'auth.boardScopedNoAccess' : 'auth.noAccess')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  const catalog = await fetchCncCatalog();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'admin', 'cnc']}>
      <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 1, color: themeTokens.neutral[800] }}>
          {t('buildPlans.title')}
        </Typography>
        <Typography variant="body2" sx={{ mb: 2, color: themeTokens.neutral[600] }}>
          {t('buildPlans.subtitle')}
        </Typography>
        <Box sx={{ mb: 3 }}>
          <MuiLink component={LocaleLink} href="/admin" underline="hover" sx={{ color: themeTokens.colors.primary }}>
            {t('buildPlans.backToAdmin')}
          </MuiLink>
        </Box>
        <BuildPlansPanel catalog={catalog} locale={locale} />
      </Container>
    </I18nProvider>
  );
}
