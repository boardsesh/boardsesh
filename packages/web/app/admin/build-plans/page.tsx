import React from 'react';
import Alert from '@mui/material/Alert';
import Container from '@mui/material/Container';
import MuiLink from '@mui/material/Link';
import BuildPlansPanel from '@/app/components/admin/build-plans-panel';
import LocaleLink from '@/app/components/i18n/locale-link';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { fetchCncCatalog } from '@/app/build-plans/build-plans-page';
import { PageFrame } from '@/app/build-plans/ui';
import { checkAdmin } from '@/app/lib/admin/check-admin';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';

/**
 * Every build-pack order — free previews included — for support and for
 * requeueing a failed pack.
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
 * It borrows the buyer's own page frame and card kit rather than a second admin
 * one: an operator is usually on the phone to somebody looking at the buyer's
 * screen, and two visual languages for one order is how "it says ready on mine"
 * happens.
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
      <PageFrame
        title={t('buildPlans.title')}
        intro={t('buildPlans.subtitle')}
        eyebrow={
          <MuiLink component={LocaleLink} href="/admin" variant="body2">
            {t('buildPlans.backToAdmin')}
          </MuiLink>
        }
      >
        <BuildPlansPanel catalog={catalog} locale={locale} />
      </PageFrame>
    </I18nProvider>
  );
}
