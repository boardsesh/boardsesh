import React from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { GET_CNC_ORDER, type GetCncOrderQueryResponse } from '@boardsesh/graphql/operations/cnc-packs';
import type { CncOrder } from '@boardsesh/shared-schema';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { fetchCncCatalog, requireCncPacksFlag } from '../../build-plans-page';
import { wallLabel } from '../../order-display';
import styles from '../../build-plans.module.css';
import OrderStatus from './order-status';

/** One person's order, with a live status. Never cached, never static. */
export const dynamic = 'force-dynamic';

type OrderRouteProps = {
  params: Promise<{ licenceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * `noindex, follow`. Stays that way after launch — a purchase receipt is a
 * utility surface. The licence id is in the title because that is how a buyer
 * picks this tab out of five open ones.
 */
export async function generateMetadata(props: OrderRouteProps): Promise<Metadata> {
  const { licenceId } = await props.params;
  const { t, locale } = await getServerTranslation('cnc');
  return createNoIndexMetadata({
    title: t('metadata.order.title', { licenceId }),
    description: t('metadata.order.description'),
    path: `/build-plans/orders/${licenceId}`,
    locale,
  });
}

export default async function BuildPlanOrderPage(props: OrderRouteProps) {
  await requireCncPacksFlag();

  const { licenceId } = await props.params;
  const searchParams = await props.searchParams;

  const authToken = await getServerAuthToken();
  if (!authToken) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(`/build-plans/orders/${licenceId}`)}`);
  }

  const { t, locale } = await getServerTranslation('cnc');

  // `cncOrder` answers null for a licence that does not exist AND for one that
  // belongs to somebody else — deliberately indistinguishable, so this page
  // must not treat them differently either.
  const [order, catalog] = await Promise.all([
    executeAuthenticatedGraphQL<GetCncOrderQueryResponse>(GET_CNC_ORDER, { licenceId }, authToken)
      .then((response) => response.cncOrder)
      .catch((error: unknown) => {
        console.error('cncOrder failed:', error);
        return null satisfies CncOrder | null;
      }),
    fetchCncCatalog(),
  ]);

  if (!order) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'cnc']}>
        <Box component="main" className={styles.page}>
          <Typography variant="h1" className={styles.heroTitle}>
            {t('order.notFound.heading')}
          </Typography>
          <Typography variant="body1" className={styles.heroSubtitle}>
            {t('order.notFound.body')}
          </Typography>
          <MuiLink component={LocaleLink} href="/build-plans/orders" variant="body2" sx={{ mt: 2, display: 'block' }}>
            {t('order.back')}
          </MuiLink>
        </Box>
      </I18nProvider>
    );
  }

  const checkoutParam = searchParams.checkout;
  const checkoutOutcome = checkoutParam === 'success' || checkoutParam === 'cancelled' ? checkoutParam : null;

  return (
    <I18nProvider locale={locale} namespaces={['common', 'cnc']}>
      <Box component="main" className={styles.page}>
        <OrderStatus
          initialOrder={order}
          wallLabel={wallLabel(catalog, order)}
          checkoutOutcome={checkoutOutcome}
          locale={locale}
        />
      </Box>
    </I18nProvider>
  );
}
